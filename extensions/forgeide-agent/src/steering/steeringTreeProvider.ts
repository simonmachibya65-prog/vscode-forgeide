import * as vscode from 'vscode';
import { SteeringLoader, SteeringFile } from './steeringLoader';

export class SteeringTreeProvider implements vscode.TreeDataProvider<SteeringFile> {
    private emitter = new vscode.EventEmitter<void>();
    onDidChangeTreeData = this.emitter.event;

    constructor(private loader: SteeringLoader, private steeringDir: string) {}

    refresh() {
        this.emitter.fire();
    }

    getTreeItem(file: SteeringFile): vscode.TreeItem {
        const item = new vscode.TreeItem(file.name);
        item.description = file.appliesTo ? `scoped: ${file.appliesTo}` : 'global';
        item.tooltip = file.content.slice(0, 300);
        item.iconPath = new vscode.ThemeIcon('book');
        return item;
    }

    async getChildren(): Promise<SteeringFile[]> {
        return this.loader.loadAll(this.steeringDir);
    }
}
