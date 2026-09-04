import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as util from 'util';

const exec = util.promisify(cp.exec);

export interface Checkpoint {
    id: string;
    label: string;
    stashRef: string;
    createdAt: string;
    fileCount: number;
}

/**
 * Creates git stash snapshots before any multi-file agent write so the user
 * can roll back to any prior checkpoint from the Specs view.
 * Uses `git stash` with a forgeide-namespaced message so entries are easy to identify.
 */
export class CheckpointManager {
    private checkpoints: Checkpoint[] = [];
    private onChangeEmitter = new vscode.EventEmitter<Checkpoint[]>();
    onCheckpointsChanged = this.onChangeEmitter.event;

    constructor(private outputChannel: vscode.OutputChannel) {}

    private repoRoot(): string {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders?.length) throw new Error('No workspace folder open.');
        return folders[0].uri.fsPath;
    }

    /** Call before any multi-file agent write. Returns the checkpoint or undefined if tree was clean. */
    async create(label: string): Promise<Checkpoint | undefined> {
        try {
            const cwd = this.repoRoot();
            // Stage all tracked changes so stash captures them
            await exec('git add -u', { cwd });

            const { stdout } = await exec(
                `git stash push -m "forgeide:${label}" --include-untracked`,
                { cwd }
            );

            if (stdout.includes('No local changes')) {
                this.outputChannel.appendLine(`Checkpoint "${label}": working tree clean, nothing to snapshot.`);
                return undefined;
            }

            const { stdout: listOut } = await exec('git stash list --format=%gd:%s', { cwd });
            const line = listOut.split('\n').find(l => l.includes(`forgeide:${label}`));
            const stashRef = line?.split(':')[0] ?? 'stash@{0}';

            let fileCount = 0;
            try {
                const { stdout: statOut } = await exec(`git stash show --stat ${stashRef}`, { cwd });
                fileCount = (statOut.match(/\n/g)?.length ?? 1) - 1;
            } catch { /* non-fatal */ }

            const checkpoint: Checkpoint = {
                id: `cp-${Date.now()}`,
                label,
                stashRef,
                createdAt: new Date().toISOString(),
                fileCount
            };
            this.checkpoints.unshift(checkpoint);
            this.onChangeEmitter.fire(this.checkpoints);
            this.outputChannel.appendLine(
                `Checkpoint created: "${label}" (${stashRef}, ${fileCount} file(s))`
            );
            return checkpoint;
        } catch (e) {
            this.outputChannel.appendLine(
                `Checkpoint "${label}" skipped (git unavailable or not a repo): ${e}`
            );
            return undefined;
        }
    }

    /** Restore a checkpoint — shows a confirmation dialog before applying. */
    async restore(checkpointId: string): Promise<void> {
        const entry = this.checkpoints.find(c => c.id === checkpointId);
        if (!entry) throw new Error(`Checkpoint "${checkpointId}" not found.`);

        const confirmed = await vscode.window.showWarningMessage(
            `Restore checkpoint "${entry.label}"? Changes after this point will be overwritten.`,
            { modal: true }, 'Restore', 'Cancel'
        );
        if (confirmed !== 'Restore') return;

        try {
            await exec(`git stash apply ${entry.stashRef}`, { cwd: this.repoRoot() });
            this.outputChannel.appendLine(`Checkpoint "${entry.label}" restored from ${entry.stashRef}.`);
            vscode.window.showInformationMessage(`Restored to checkpoint: "${entry.label}"`);
        } catch (e) {
            vscode.window.showErrorMessage(`Checkpoint restore failed: ${e}`);
        }
    }

    /** Drop a checkpoint and remove its stash entry. */
    async drop(checkpointId: string): Promise<void> {
        const entry = this.checkpoints.find(c => c.id === checkpointId);
        if (!entry) return;
        try {
            await exec(`git stash drop ${entry.stashRef}`, { cwd: this.repoRoot() });
        } catch { /* already gone */ }
        this.checkpoints = this.checkpoints.filter(c => c.id !== checkpointId);
        this.onChangeEmitter.fire(this.checkpoints);
    }

    list(): Checkpoint[] {
        return [...this.checkpoints];
    }
}
