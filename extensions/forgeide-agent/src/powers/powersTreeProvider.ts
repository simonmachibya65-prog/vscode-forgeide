import * as vscode from 'vscode';
import { PowerManager, InstalledPower } from './powerManager';

type Row = PowerRow | InfoRow;
class PowerRow { constructor(public power: InstalledPower) {} }
class InfoRow  { constructor(public label: string) {} }

export class PowersTreeProvider implements vscode.TreeDataProvider<Row> {
    private emitter = new vscode.EventEmitter<void>();
    onDidChangeTreeData = this.emitter.event;

    constructor(private manager: PowerManager) {
        manager.onPowersChanged(() => this.emitter.fire());
    }

    refresh(): void { this.emitter.fire(); }

    getTreeItem(row: Row): vscode.TreeItem {
        if (row instanceof InfoRow) return new vscode.TreeItem(row.label);

        const p = row.power;
        const item = new vscode.TreeItem(p.manifest.name, vscode.TreeItemCollapsibleState.None);
        item.description = p.active ? '⚡ active' : p.manifest.version;
        item.tooltip = [
            p.manifest.description,
            `Keywords: ${p.manifest.keywords.join(', ')}`,
            p.error ? `Error: ${p.error}` : ''
        ].filter(Boolean).join('\n');
        item.iconPath = new vscode.ThemeIcon(
            p.active ? 'zap' : p.error ? 'error' : 'package'
        );
        item.contextValue = p.active ? 'forgeide.power.active' : 'forgeide.power.inactive';
        return item;
    }

    getChildren(): Row[] {
        const powers = this.manager.list();
        if (!powers.length) {
            return [new InfoRow('No powers installed — run "ForgeIDE: Install Power"')];
        }
        return powers.map(p => new PowerRow(p));
    }
}
