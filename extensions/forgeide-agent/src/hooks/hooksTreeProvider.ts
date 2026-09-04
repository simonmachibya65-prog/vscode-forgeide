import * as vscode from 'vscode';
import { HookDefinition } from './hooksEngine';

export class HooksTreeProvider implements vscode.TreeDataProvider<HookDefinition> {
    private emitter = new vscode.EventEmitter<void>();
    onDidChangeTreeData = this.emitter.event;
    private hooks: HookDefinition[] = [];

    setHooks(hooks: HookDefinition[]) {
        this.hooks = hooks;
        this.emitter.fire();
    }

    getTreeItem(hook: HookDefinition): vscode.TreeItem {
        const item = new vscode.TreeItem(hook.id);
        item.description = `${hook.on} · ${hook.glob}`;
        item.tooltip = hook.action;
        item.iconPath = new vscode.ThemeIcon(hook.enabled ? 'zap' : 'circle-slash');
        item.contextValue = hook.enabled ? 'forgeide.hook.enabled' : 'forgeide.hook.disabled';
        return item;
    }

    getChildren(): HookDefinition[] {
        return this.hooks;
    }
}
