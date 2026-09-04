import * as vscode from 'vscode';
import { CheckpointManager, Checkpoint } from './checkpointManager';

type Row = CheckpointRow | InfoRow;
class CheckpointRow { constructor(public checkpoint: Checkpoint) {} }
class InfoRow       { constructor(public label: string) {} }

/**
 * CheckpointsTreeProvider — sidebar view showing git-stash checkpoints
 * created before each agent write. Each item has a "Restore" inline button.
 */
export class CheckpointsTreeProvider implements vscode.TreeDataProvider<Row> {
    private emitter = new vscode.EventEmitter<void>();
    onDidChangeTreeData = this.emitter.event;

    constructor(private manager: CheckpointManager) {
        manager.onCheckpointsChanged(() => this.emitter.fire());
    }

    refresh(): void { this.emitter.fire(); }

    getTreeItem(row: Row): vscode.TreeItem {
        if (row instanceof InfoRow) {
            return new vscode.TreeItem(row.label);
        }

        const cp = row.checkpoint;
        const item = new vscode.TreeItem(cp.label, vscode.TreeItemCollapsibleState.None);
        item.description = `${cp.fileCount} file(s) · ${new Date(cp.createdAt).toLocaleTimeString()}`;
        item.tooltip = [
            `Stash ref: ${cp.stashRef}`,
            `Created: ${new Date(cp.createdAt).toLocaleString()}`,
            `Files: ${cp.fileCount}`
        ].join('\n');
        item.iconPath = new vscode.ThemeIcon('history');
        item.contextValue = 'forgeide.checkpoint';
        item.command = {
            command: 'forgeide.restoreCheckpoint',
            title: 'Restore Checkpoint',
            arguments: [cp.id]
        };
        return item;
    }

    getChildren(): Row[] {
        const cps = this.manager.list();
        if (!cps.length) {
            return [new InfoRow('No checkpoints yet — checkpoints are created automatically before each agent write')];
        }
        return cps.map(cp => new CheckpointRow(cp));
    }
}
