import * as vscode from 'vscode';
import {
    TaskRecord,
    TaskStatus,
    TaskBudget,
    TaskStep,
    SpecState,
    SpecPhase
} from './types';
import { SpecsEngine, Spec, SpecTask } from '../specs/specsEngine';
import { TaskExecutor } from '../specs/taskExecutor';
import { VerificationAgent } from '../agents/verificationAgent';
import { CheckpointManager } from '../agents/checkpointManager';
import { ReasoningPanel } from '../agents/reasoningPanel';
import { AutopilotManager } from '../agents/autopilot';
import { ModelClient } from '../modelClient';

export type PipelineStage = SpecPhase | 'implement' | 'verify' | 'done';

export interface PipelineEvent {
    stage: PipelineStage;
    specId: string;
    taskId?: string;
    message: string;
    requiresApproval?: boolean;
    taskRecord?: TaskRecord;
}

export type PipelineEventHandler = (event: PipelineEvent) => Promise<void>;

const DEFAULT_BUDGET: TaskBudget = {
    maxSteps: 50,
    usedSteps: 0,
    maxWallClockSec: 300  // 5 minutes per task
};

/**
 * Orchestrator — the Agent Loop wiring:
 *   Spec Engine → Task Runner → Verification Agent
 *
 * Uses the canonical TaskRecord and TaskBudget from types.ts to track
 * every task's lifecycle, budget consumption, and step audit trail.
 *
 * Enforces the approval gate at each SpecPhase boundary.
 * In Supervised mode: pauses for explicit user approval.
 * In Autopilot mode: auto-advances (spec gate still enforced).
 */
export class Orchestrator {
    private onEventHandlers: PipelineEventHandler[] = [];
    /** In-memory record of all tasks run this session, keyed by taskId */
    private taskRecords = new Map<string, TaskRecord>();

    constructor(
        private specsEngine: SpecsEngine,
        private taskExecutor: TaskExecutor | undefined,
        private verificationAgent: VerificationAgent,
        private checkpointManager: CheckpointManager,
        private reasoningPanel: ReasoningPanel,
        private autopilot: AutopilotManager,
        private model: ModelClient,
        private outputChannel: vscode.OutputChannel
    ) {}

    onEvent(handler: PipelineEventHandler): void {
        this.onEventHandlers.push(handler);
    }

    private async emit(event: PipelineEvent): Promise<void> {
        for (const h of this.onEventHandlers) await h(event);
    }

    // ── Spec state helper ─────────────────────────────────────────────────────

    private specToState(spec: Spec): SpecState {
        return {
            slug: spec.id,
            phase: spec.stage === 'requirements' ? 'requirements'
                 : spec.stage === 'design' ? 'design'
                 : 'tasks',
            approved: {
                requirements: spec.requirementsApproved,
                design: spec.designApproved,
                tasks: spec.tasksApproved
            },
            content: {
                requirements: spec.requirements ?? '',
                design: spec.design ?? '',
                tasks: JSON.stringify(spec.tasks ?? [])
            }
        };
    }

    // ── Full pipeline ─────────────────────────────────────────────────────────

    async runFromPrompt(prompt: string, codebaseContext = ''): Promise<Spec> {
        this.reasoningPanel.start(`Pipeline: ${prompt}`, true);

        // Requirements
        this.reasoningPanel.append('Generating requirements...');
        const spec = await this.specsEngine.createFromPrompt(prompt);
        await this.emit({
            stage: 'requirements', specId: spec.id,
            message: `Requirements drafted (${spec.requirementsCheck?.valid}/${spec.requirementsCheck?.total} EARS valid).`,
            requiresApproval: !this.autopilot.isAutopilot()
        });
        await this.gateApprove(spec, 'requirements');
        const specReqApproved = await this.specsEngine.approveRequirements(spec);

        // Design
        this.reasoningPanel.append('Generating design...');
        const specWithDesign = await this.specsEngine.advanceToDesign(specReqApproved, codebaseContext);
        await this.emit({
            stage: 'design', specId: spec.id,
            message: 'Design document generated.',
            requiresApproval: !this.autopilot.isAutopilot()
        });
        await this.gateApprove(specWithDesign, 'design');
        const specDesignApproved = await this.specsEngine.approveDesign(specWithDesign);

        // Tasks
        this.reasoningPanel.append('Breaking down tasks...');
        const specWithTasks = await this.specsEngine.advanceToTasks(specDesignApproved);
        await this.emit({
            stage: 'tasks', specId: spec.id,
            message: `${specWithTasks.tasks?.length ?? 0} tasks generated.`,
            requiresApproval: !this.autopilot.isAutopilot()
        });
        await this.gateApprove(specWithTasks, 'tasks');
        const readySpec = await this.specsEngine.approveTasks(specWithTasks);

        this.reasoningPanel.append('All phases approved — starting implementation...');
        return this.runImplementationLoop(readySpec);
    }

    async runImplementationLoop(spec: Spec): Promise<Spec> {
        if (!spec.tasksApproved) {
            throw new Error('Cannot run implementation loop: tasks not approved.');
        }
        if (!this.taskExecutor) {
            throw new Error('No workspace folder open — cannot execute tasks.');
        }

        let current = spec;
        const pending = (spec.tasks ?? []).filter(t => t.status === 'pending');

        for (const task of pending) {
            current = await this.runTask(current, task);
        }

        this.reasoningPanel.finish(`Pipeline complete for "${spec.title}".`);
        return current;
    }

    async runTask(spec: Spec, task: SpecTask): Promise<Spec> {
        if (!this.taskExecutor) throw new Error('No workspace folder open.');

        const gate = this.specsEngine.canGenerateCode(spec, task.id);
        if (!gate.allowed) throw new Error(`Gate blocked: ${gate.reason}`);

        // Build a TaskRecord for this task
        const record: TaskRecord = {
            taskId: task.id,
            specSlug: spec.id,
            description: task.title,
            status: 'in_progress',
            steps: [],
            budget: { ...DEFAULT_BUDGET, startedAt: Date.now() },
            mode: this.autopilot.isAutopilot() ? 'autopilot' : 'supervised'
        };

        // Checkpoint
        const cp = await this.checkpointManager.create(`before: ${task.title}`);
        if (cp) record.checkpointBefore = cp.stashRef;

        this.taskRecords.set(task.id, record);
        this.reasoningPanel.append(`Implementing: ${task.title}`);

        await this.emit({
            stage: 'implement', specId: spec.id, taskId: task.id,
            message: `Starting: ${task.title}`,
            taskRecord: record
        });

        let updated = await this.specsEngine.markTaskStatus(spec, task.id, 'in_progress');

        try {
            const outcomes = await this.taskExecutor.execute(spec, task, []);
            const allApplied = outcomes.every(o => o.result === 'applied' || o.result === 'unchanged');

            // Record steps
            for (const outcome of outcomes) {
                const step: TaskStep = {
                    step: record.steps.length + 1,
                    tool: 'edit_file',
                    target: outcome.path,
                    status: outcome.result === 'applied' ? 'done'
                          : outcome.result === 'rejected' ? 'denied'
                          : 'done'
                };
                record.steps.push(step);
                record.budget.usedSteps++;
            }

            if (!allApplied) {
                record.status = 'failed';
                updated = await this.specsEngine.markTaskStatus(updated, task.id, 'pending');
                return updated;
            }

            // Verification
            record.status = 'verifying';
            this.reasoningPanel.append(`Verifying: ${task.title}`);

            const verification = await this.verificationAgent.verify(spec, task, outcomes);

            await this.emit({
                stage: 'verify', specId: spec.id, taskId: task.id,
                message: verification.passed
                    ? `✓ Task "${task.title}" verified.`
                    : `⚠ Task "${task.title}" verification issues: ${verification.issues.join(', ')}`,
                requiresApproval: !verification.passed && !this.autopilot.isAutopilot(),
                taskRecord: record
            });

            if (!verification.passed && !this.autopilot.isAutopilot()) {
                const choice = await vscode.window.showWarningMessage(
                    `Verification found issues for "${task.title}". Mark done anyway?`,
                    'Mark Done', 'Keep Pending'
                );
                if (choice !== 'Mark Done') {
                    record.status = 'failed';
                    return await this.specsEngine.markTaskStatus(updated, task.id, 'pending');
                }
            }

            record.status = 'done';
            updated = await this.specsEngine.markTaskStatus(updated, task.id, 'done');
            this.outputChannel.appendLine(`Task "${task.title}": done.`);

        } catch (e: any) {
            // Check if budget was the cause
            const budgetCheck = { ok: record.budget.usedSteps < record.budget.maxSteps };
            record.status = budgetCheck.ok ? 'failed' : 'aborted_budget';
            this.outputChannel.appendLine(`Task "${task.title}" ${record.status}: ${e.message}`);
            updated = await this.specsEngine.markTaskStatus(updated, task.id, 'pending');
        }

        this.taskRecords.set(task.id, record);
        return updated;
    }

    // ── Gate ──────────────────────────────────────────────────────────────────

    private async gateApprove(spec: Spec, phase: SpecPhase): Promise<void> {
        if (this.autopilot.isAutopilot()) {
            this.reasoningPanel.append(`Autopilot: auto-advancing past ${phase} gate.`);
            return;
        }
        const choice = await vscode.window.showInformationMessage(
            `ForgeIDE: Review the ${phase} for "${spec.title}". Approve to continue?`,
            { modal: false }, 'Approve', 'Cancel'
        );
        if (choice !== 'Approve') {
            throw new Error(`Pipeline cancelled at ${phase} gate.`);
        }
    }

    // ── Accessors ─────────────────────────────────────────────────────────────

    getTaskRecord(taskId: string): TaskRecord | undefined {
        return this.taskRecords.get(taskId);
    }

    getAllTaskRecords(): TaskRecord[] {
        return [...this.taskRecords.values()];
    }
}
