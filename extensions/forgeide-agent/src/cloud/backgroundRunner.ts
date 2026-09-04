import * as vscode from 'vscode';
import * as crypto from 'crypto';

/**
 * CloudBackgroundRunner — async task queue for long-running agent tasks that
 * should not block the local IDE session.
 *
 * Architecture:
 *   - Local queue: tasks run in-process via the BackgroundQueue (already exists)
 *   - Cloud queue: tasks are serialised to .kiro/background-queue.json and
 *     polled/executed by a separate process (or a future cloud worker)
 *   - Webhook callbacks: when a task completes, registered webhooks are called
 *
 * For now the "cloud" execution is local async (same process, no blocking UI),
 * but the data model and API are shaped so a real remote worker can slot in
 * without changing callers.
 */

export type RunnerTaskStatus =
    | 'queued'
    | 'running'
    | 'done'
    | 'failed'
    | 'cancelled';

export interface RunnerTask {
    id: string;
    label: string;
    type: 'spec.pipeline' | 'task.implement' | 'index.rebuild' | 'custom';
    payload: unknown;
    status: RunnerTaskStatus;
    createdAt: string;
    startedAt?: string;
    finishedAt?: string;
    result?: unknown;
    error?: string;
    webhookUrl?: string;
}

export interface WebhookPayload {
    taskId: string;
    status: RunnerTaskStatus;
    result?: unknown;
    error?: string;
}

type TaskFn = (task: RunnerTask, token: AbortSignal) => Promise<unknown>;

export class CloudBackgroundRunner implements vscode.Disposable {
    private tasks = new Map<string, RunnerTask>();
    private handlers = new Map<string, TaskFn>();
    private running = false;
    private abortControllers = new Map<string, AbortController>();
    private onChangeEmitter = new vscode.EventEmitter<RunnerTask[]>();
    onTasksChanged = this.onChangeEmitter.event;
    private outputChannel: vscode.OutputChannel;
    private statusBar: vscode.StatusBarItem;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('ForgeIDE — Background Runner');
        this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 85);
        this.statusBar.command = 'forgeide.showBackgroundTasks';
        this.statusBar.hide();
    }

    /** Register a handler for a task type. */
    register(type: RunnerTask['type'], fn: TaskFn): void {
        this.handlers.set(type, fn);
    }

    /** Enqueue a task. Returns the task record immediately. */
    enqueue(
        label: string,
        type: RunnerTask['type'],
        payload: unknown,
        webhookUrl?: string
    ): RunnerTask {
        const task: RunnerTask = {
            id: crypto.randomUUID(),
            label, type, payload,
            status: 'queued',
            createdAt: new Date().toISOString(),
            webhookUrl
        };
        this.tasks.set(task.id, task);
        this.outputChannel.appendLine(`[queued] ${label} (${type})`);
        this.onChangeEmitter.fire(this.list());
        this.updateStatusBar();
        this.drain();
        return task;
    }

    /** Cancel a running or queued task. */
    cancel(id: string): void {
        const task = this.tasks.get(id);
        if (!task) return;
        if (task.status === 'running') {
            this.abortControllers.get(id)?.abort();
        }
        task.status = 'cancelled';
        task.finishedAt = new Date().toISOString();
        this.onChangeEmitter.fire(this.list());
        this.updateStatusBar();
    }

    list(): RunnerTask[] {
        return [...this.tasks.values()].sort(
            (a, b) => a.createdAt.localeCompare(b.createdAt)
        );
    }

    getActive(): RunnerTask[] {
        return this.list().filter(t => t.status === 'queued' || t.status === 'running');
    }

    private async drain(): Promise<void> {
        if (this.running) return;
        this.running = true;

        while (true) {
            const next = [...this.tasks.values()].find(t => t.status === 'queued');
            if (!next) break;

            next.status = 'running';
            next.startedAt = new Date().toISOString();
            this.onChangeEmitter.fire(this.list());
            this.updateStatusBar();
            this.outputChannel.appendLine(`[running] ${next.label}`);

            const ac = new AbortController();
            this.abortControllers.set(next.id, ac);

            const handler = this.handlers.get(next.type);
            if (!handler) {
                next.status = 'failed';
                next.error = `No handler registered for type "${next.type}"`;
            } else {
                try {
                    next.result = await handler(next, ac.signal);
                    next.status = ac.signal.aborted ? 'cancelled' : 'done';
                } catch (e: any) {
                    next.status = 'failed';
                    next.error = String(e?.message ?? e);
                    vscode.window.showErrorMessage(
                        `Background task "${next.label}" failed: ${next.error}`
                    );
                }
            }

            next.finishedAt = new Date().toISOString();
            this.abortControllers.delete(next.id);
            this.onChangeEmitter.fire(this.list());
            this.updateStatusBar();
            this.outputChannel.appendLine(`[${next.status}] ${next.label}`);

            // Webhook callback
            if (next.webhookUrl) {
                this.fireWebhook(next).catch(() => {});
            }
        }

        this.running = false;
        this.updateStatusBar();
    }

    private async fireWebhook(task: RunnerTask): Promise<void> {
        if (!task.webhookUrl) return;
        try {
            const payload: WebhookPayload = {
                taskId: task.id,
                status: task.status,
                result: task.result,
                error: task.error
            };
            await fetch(task.webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            this.outputChannel.appendLine(`[webhook] ${task.label} → ${task.webhookUrl}`);
        } catch (e) {
            this.outputChannel.appendLine(`[webhook-error] ${task.label}: ${e}`);
        }
    }

    private updateStatusBar(): void {
        const active = this.getActive();
        if (!active.length) { this.statusBar.hide(); return; }
        const running = active.find(t => t.status === 'running');
        this.statusBar.text = `$(sync~spin) ${running?.label ?? 'queued'} (${active.length})`;
        this.statusBar.tooltip = active.map(t => `${t.status}: ${t.label}`).join('\n');
        this.statusBar.show();
    }

    dispose(): void {
        for (const ac of this.abortControllers.values()) ac.abort();
        this.outputChannel.dispose();
        this.statusBar.dispose();
        this.onChangeEmitter.dispose();
    }
}
