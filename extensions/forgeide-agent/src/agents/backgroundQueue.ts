import * as vscode from 'vscode';

export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface QueuedTask {
    id: string;
    label: string;
    status: TaskStatus;
    error?: string;
    createdAt: string;
    startedAt?: string;
    finishedAt?: string;
}

type TaskFn = (token: vscode.CancellationToken) => Promise<void>;

/**
 * BackgroundQueue — runs agent tasks asynchronously so they don't block the
 * editor session. Tasks are serialized (one at a time) to avoid conflicting
 * writes, but the queue accepts new items while one is in flight.
 *
 * Each task shows up in the status bar as a spinner and in the Background
 * Tasks output channel. The user can cancel the running task at any time.
 */
export class BackgroundQueue implements vscode.Disposable {
    private queue: { task: QueuedTask; fn: TaskFn; cancel: vscode.CancellationTokenSource }[] = [];
    private running = false;
    private onChangeEmitter = new vscode.EventEmitter<QueuedTask[]>();
    onTasksChanged = this.onChangeEmitter.event;
    private outputChannel: vscode.OutputChannel;
    private statusBarItem: vscode.StatusBarItem;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('ForgeIDE — Background Tasks');
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
        this.statusBarItem.command = 'forgeide.showBackgroundTasks';
        this.statusBarItem.hide();
    }

    /** Enqueue a background task. Returns the queued task record. */
    enqueue(label: string, fn: TaskFn): QueuedTask {
        const cancel = new vscode.CancellationTokenSource();
        const task: QueuedTask = {
            id: `bgtask-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            label,
            status: 'queued',
            createdAt: new Date().toISOString()
        };
        this.queue.push({ task, fn, cancel });
        this.onChangeEmitter.fire(this.allTasks());
        this.outputChannel.appendLine(`[queued] ${label}`);
        this.drain();
        return task;
    }

    /** Cancel the currently running task (no-op if nothing is running). */
    cancelRunning(): void {
        const running = this.queue.find(e => e.task.status === 'running');
        if (running) {
            running.cancel.cancel();
            this.outputChannel.appendLine(`[cancelled] ${running.task.label}`);
        }
    }

    allTasks(): QueuedTask[] {
        return this.queue.map(e => e.task);
    }

    private async drain(): Promise<void> {
        if (this.running) return;
        this.running = true;

        while (true) {
            const entry = this.queue.find(e => e.task.status === 'queued');
            if (!entry) break;

            entry.task.status = 'running';
            entry.task.startedAt = new Date().toISOString();
            this.onChangeEmitter.fire(this.allTasks());
            this.updateStatusBar();
            this.outputChannel.appendLine(`[running] ${entry.task.label}`);

            try {
                await entry.fn(entry.cancel.token);
                if (entry.cancel.token.isCancellationRequested) {
                    entry.task.status = 'cancelled';
                } else {
                    entry.task.status = 'done';
                }
            } catch (e: any) {
                entry.task.status = 'failed';
                entry.task.error = String(e?.message ?? e);
                this.outputChannel.appendLine(`[failed] ${entry.task.label}: ${entry.task.error}`);
                vscode.window.showErrorMessage(`Background task "${entry.task.label}" failed: ${entry.task.error}`);
            }

            entry.task.finishedAt = new Date().toISOString();
            entry.cancel.dispose();
            this.onChangeEmitter.fire(this.allTasks());
            this.updateStatusBar();
            this.outputChannel.appendLine(`[${entry.task.status}] ${entry.task.label}`);
        }

        this.running = false;
        this.updateStatusBar();
    }

    private updateStatusBar(): void {
        const running = this.queue.filter(e => e.task.status === 'running' || e.task.status === 'queued');
        if (running.length === 0) {
            this.statusBarItem.hide();
            return;
        }
        const current = running.find(e => e.task.status === 'running');
        this.statusBarItem.text = `$(sync~spin) ForgeIDE: ${current?.task.label ?? 'queued'} (${running.length})`;
        this.statusBarItem.tooltip = running.map(e => `${e.task.status}: ${e.task.label}`).join('\n');
        this.statusBarItem.show();
    }

    dispose(): void {
        this.queue.forEach(e => e.cancel.dispose());
        this.outputChannel.dispose();
        this.statusBarItem.dispose();
    }
}
