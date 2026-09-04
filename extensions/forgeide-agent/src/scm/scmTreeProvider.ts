import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as util from 'util';

const exec = util.promisify(cp.exec);

export interface ScmChange {
    path: string;
    status: string;
}

export class ScmTreeProvider implements vscode.TreeDataProvider<ScmChange>, vscode.Disposable {
    private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<ScmChange | undefined>();
    readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
    private changes: ScmChange[] = [];

    constructor(private readonly workspaceRoot: string) {}

    async refresh(): Promise<void> {
        try {
            const { stdout } = await exec('git status --short -uall', { cwd: this.workspaceRoot });
            this.changes = stdout
                .split(/\r?\n/)
                .filter(Boolean)
                .map(line => ({
                    status: line.slice(0, 2).trim() || '?',
                    path: line.slice(3).trim()
                }))
                .filter(change => change.path.length > 0);
        } catch {
            this.changes = [];
        }
        this.onDidChangeTreeDataEmitter.fire(undefined);
    }

    getTreeItem(change: ScmChange): vscode.TreeItem {
        const item = new vscode.TreeItem(change.path, vscode.TreeItemCollapsibleState.None);
        item.description = change.status;
        item.tooltip = `${change.status} ${change.path}`;
        item.contextValue = 'forgeide.scmChange';
        item.command = {
            command: 'forgeide.openScmFile',
            title: 'Open Changed File',
            arguments: [change]
        };
        return item;
    }

    getChildren(): ScmChange[] {
        return this.changes;
    }

    dispose(): void {
        this.onDidChangeTreeDataEmitter.dispose();
    }
}