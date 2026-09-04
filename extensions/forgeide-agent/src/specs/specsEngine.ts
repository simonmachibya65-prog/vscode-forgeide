import * as vscode from 'vscode';
import * as path from 'path';
import { ModelClient } from '../modelClient';
import { validateRequirements, EarsValidationSummary } from './earsValidator';

export type SpecStage = 'requirements' | 'design' | 'tasks' | 'implementing' | 'done';

export interface SpecTask {
    id: string;
    title: string;
    detail: string;
    dependsOn: string[];
    status: 'pending' | 'in_progress' | 'done';
    /** Traceability: which requirement line produced this task */
    sourceRequirementId?: string;
}

export interface Spec {
    id: string;
    prompt: string;
    title: string;
    stage: SpecStage;
    requirements?: string;
    requirementsCheck?: EarsValidationSummary;
    requirementsApproved: boolean;
    design?: string;
    designApproved: boolean;
    tasks?: SpecTask[];
    tasksApproved: boolean;
    createdAt: string;
    updatedAt: string;
}

export interface GateResult {
    allowed: boolean;
    reason?: string;
}

const REQUIREMENTS_SYSTEM_PROMPT = `You write software requirements using EARS syntax
(Easy Approach to Requirements Syntax): "WHEN <trigger>, the system SHALL <response>."
Given a feature prompt, produce:
1. A short list of user stories ("As a <role>, I want <capability>, so that <benefit>").
2. Acceptance criteria per story, each in EARS format.
Be concrete. Do not write any code. Output markdown only.`;

const DESIGN_SYSTEM_PROMPT = `You are a software architect. Given approved requirements and
the relevant parts of an existing codebase, produce a design document containing:
1. A brief architecture / data-flow summary.
2. Key interfaces or type signatures (language-appropriate).
3. Any schema or API endpoint changes needed.
Output markdown only. Do not write full implementation code, only signatures/shapes.`;

const TASKS_SYSTEM_PROMPT = `Given approved requirements and a design document, break the work
into an ordered list of implementation tasks. For each task give: a short title, a one-paragraph
detail describing what to change and where, and any task IDs it depends on. Include testing and
accessibility considerations as their own tasks where relevant. Respond ONLY with JSON matching:
{"tasks": [{"id": string, "title": string, "detail": string, "dependsOn": string[]}]}`;

export class SpecsEngine {
    constructor(
        private model: ModelClient,
        private workspaceRoot: string,
        private specsDir: string
    ) {}

    /** Resolved path — stored under .kiro/specs/ by default */
    private specPath(id: string) {
        return path.join(this.workspaceRoot, this.specsDir, `${id}.json`);
    }

    // -------------------------------------------------------------------------
    // THE GATE — every code-generation entry point (chat, Tab, Cmd-K, Composer)
    // must call this before touching any file. Never bypass it.
    // -------------------------------------------------------------------------
    canGenerateCode(spec: Spec, taskId?: string): GateResult {
        if (!spec.requirementsApproved) {
            return { allowed: false, reason: 'Requirements phase has not been approved yet.' };
        }
        if (!spec.designApproved) {
            return { allowed: false, reason: 'Design phase has not been approved yet.' };
        }
        if (!spec.tasksApproved) {
            return { allowed: false, reason: 'Tasks phase has not been approved yet.' };
        }
        if (taskId) {
            const task = spec.tasks?.find(t => t.id === taskId);
            if (!task) {
                return { allowed: false, reason: `Task "${taskId}" does not exist in this spec.` };
            }
        }
        return { allowed: true };
    }

    async createFromPrompt(prompt: string): Promise<Spec> {
        const id = prompt
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)/g, '')
            .slice(0, 40) || `spec-${Date.now()}`;

        let requirements = await this.model.complete([
            { role: 'system', content: REQUIREMENTS_SYSTEM_PROMPT },
            { role: 'user', content: prompt }
        ]);

        let check = validateRequirements(requirements);
        // One repair pass if the model drifted away from EARS syntax
        if (check.total > 0 && check.valid / check.total < 0.7) {
            requirements = await this.model.complete([
                { role: 'system', content: REQUIREMENTS_SYSTEM_PROMPT },
                { role: 'user', content: prompt },
                { role: 'assistant', content: requirements },
                {
                    role: 'user',
                    content: `Some acceptance criteria don't follow EARS syntax. Rewrite ALL acceptance ` +
                        `criteria strictly as one of: "WHEN <trigger>, the system SHALL <response>", ` +
                        `"IF <condition>, THEN the system SHALL <response>", ` +
                        `"WHILE <state>, the system SHALL <response>", ` +
                        `or "THE SYSTEM SHALL <response>". Problem lines were:\n${check.invalidLines.join('\n')}`
                }
            ]);
            check = validateRequirements(requirements);
        }

        const now = new Date().toISOString();
        const spec: Spec = {
            id,
            prompt,
            title: prompt.slice(0, 60),
            stage: 'requirements',
            requirements,
            requirementsCheck: check,
            requirementsApproved: false,
            designApproved: false,
            tasksApproved: false,
            createdAt: now,
            updatedAt: now
        };
        await this.save(spec);
        return spec;
    }

    async approveRequirements(spec: Spec): Promise<Spec> {
        const updated: Spec = { ...spec, requirementsApproved: true, updatedAt: new Date().toISOString() };
        await this.save(updated);
        return updated;
    }

    async advanceToDesign(spec: Spec, codebaseContext: string): Promise<Spec> {
        if (!spec.requirementsApproved) {
            throw new Error('Cannot generate design: requirements not approved.');
        }
        const design = await this.model.complete([
            { role: 'system', content: DESIGN_SYSTEM_PROMPT },
            {
                role: 'user',
                content: `Requirements:\n${spec.requirements}\n\nRelevant codebase context:\n${codebaseContext}`
            }
        ]);
        const updated: Spec = { ...spec, stage: 'design', design, updatedAt: new Date().toISOString() };
        await this.save(updated);
        return updated;
    }

    async approveDesign(spec: Spec): Promise<Spec> {
        const updated: Spec = { ...spec, designApproved: true, updatedAt: new Date().toISOString() };
        await this.save(updated);
        return updated;
    }

    async advanceToTasks(spec: Spec): Promise<Spec> {
        if (!spec.designApproved) {
            throw new Error('Cannot generate tasks: design not approved.');
        }
        const raw = await this.model.complete([
            { role: 'system', content: TASKS_SYSTEM_PROMPT },
            { role: 'user', content: `Requirements:\n${spec.requirements}\n\nDesign:\n${spec.design}` }
        ]);

        let tasks: SpecTask[];
        try {
            const parsed = JSON.parse(raw);
            tasks = parsed.tasks.map((t: any) => ({ ...t, status: 'pending' as const }));
        } catch {
            throw new Error(`Model did not return valid task JSON: ${raw.slice(0, 200)}`);
        }

        const updated: Spec = { ...spec, stage: 'tasks', tasks, updatedAt: new Date().toISOString() };
        await this.save(updated);
        return updated;
    }

    async approveTasks(spec: Spec): Promise<Spec> {
        const updated: Spec = { ...spec, tasksApproved: true, updatedAt: new Date().toISOString() };
        await this.save(updated);
        return updated;
    }

    async markTaskStatus(spec: Spec, taskId: string, status: SpecTask['status']): Promise<Spec> {
        const tasks = (spec.tasks ?? []).map(t => (t.id === taskId ? { ...t, status } : t));
        const allDone = tasks.every(t => t.status === 'done');
        const updated: Spec = {
            ...spec,
            tasks,
            stage: allDone ? 'done' : 'implementing',
            updatedAt: new Date().toISOString()
        };
        await this.save(updated);
        return updated;
    }

    async listAll(): Promise<Spec[]> {
        const dirUri = vscode.Uri.file(path.join(this.workspaceRoot, this.specsDir));
        let entries: [string, vscode.FileType][] = [];
        try {
            entries = await vscode.workspace.fs.readDirectory(dirUri);
        } catch {
            return [];
        }
        const specs: Spec[] = [];
        for (const [name, type] of entries) {
            if (type !== vscode.FileType.File || !name.endsWith('.json')) continue;
            try {
                specs.push(await this.load(name.replace(/\.json$/, '')));
            } catch {
                // skip unreadable/corrupt spec files
            }
        }
        return specs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }

    private async save(spec: Spec) {
        const uri = vscode.Uri.file(this.specPath(spec.id));
        const dirUri = vscode.Uri.file(path.dirname(this.specPath(spec.id)));
        await vscode.workspace.fs.createDirectory(dirUri);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(spec, null, 2), 'utf8'));
    }

    async load(id: string): Promise<Spec> {
        const uri = vscode.Uri.file(this.specPath(id));
        const bytes = await vscode.workspace.fs.readFile(uri);
        return JSON.parse(Buffer.from(bytes).toString('utf8'));
    }
}
