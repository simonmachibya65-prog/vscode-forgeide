import * as vscode from 'vscode';
import { SkillLoader, Skill, SkillScope } from './skillLoader';

// ── Tree node types ───────────────────────────────────────────────────────────

type SkillsTreeNode = ScopeGroup | SkillItem;

class ScopeGroup extends vscode.TreeItem {
    readonly kind = 'scopeGroup' as const;
    constructor(
        public readonly scope: SkillScope,
        public readonly count: number
    ) {
        super(
            scope === 'global' ? 'Global (~/.kiro/skills)' : 'Workspace (.kiro/skills)',
            vscode.TreeItemCollapsibleState.Expanded
        );
        this.contextValue = `forgeide.skillScope.${scope}`;
        this.iconPath = new vscode.ThemeIcon(
            scope === 'global' ? 'home' : 'folder-library'
        );
        this.description = `${count} skill${count !== 1 ? 's' : ''}`;
    }
}

class SkillItem extends vscode.TreeItem {
    readonly kind = 'skillItem' as const;
    constructor(public readonly skill: Skill) {
        super(skill.name, vscode.TreeItemCollapsibleState.None);
        this.contextValue = 'forgeide.skill';
        this.iconPath = new vscode.ThemeIcon(
            skill.fromPower ? 'extensions' : 'symbol-misc'
        );
        this.description = skill.fromPower
            ? `power: ${skill.fromPower}`
            : skill.description
                ? skill.description.slice(0, 60) + (skill.description.length > 60 ? '…' : '')
                : '';
        this.tooltip = new vscode.MarkdownString(
            `**${skill.name}** \`[${skill.scope}]\`\n\n` +
            (skill.description ? `_${skill.description}_\n\n` : '') +
            `\`\`\`\n${skill.instructions.slice(0, 400)}${skill.instructions.length > 400 ? '\n…' : ''}\n\`\`\`\n\n` +
            `Source: \`${skill.sourcePath}\``
        );
        this.command = {
            command: 'forgeide.openSkill',
            title: 'Open Skill',
            arguments: [skill.sourcePath]
        };
    }
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class SkillsTreeProvider implements vscode.TreeDataProvider<SkillsTreeNode> {
    private emitter = new vscode.EventEmitter<void>();
    onDidChangeTreeData = this.emitter.event;

    constructor(private loader: SkillLoader) {}

    refresh(): void {
        this.emitter.fire();
    }

    getTreeItem(node: SkillsTreeNode): vscode.TreeItem {
        return node;
    }

    async getChildren(node?: SkillsTreeNode): Promise<SkillsTreeNode[]> {
        if (!node) {
            // Root: two scope groups
            const all = this.loader.getAllSkills();
            const globalCount    = all.filter(s => s.scope === 'global').length;
            const workspaceCount = all.filter(s => s.scope === 'workspace').length;

            const groups: ScopeGroup[] = [];
            // Always show workspace first (most relevant), then global
            if (workspaceCount > 0 || vscode.workspace.workspaceFolders?.length) {
                groups.push(new ScopeGroup('workspace', workspaceCount));
            }
            groups.push(new ScopeGroup('global', globalCount));
            return groups;
        }

        if (node.kind === 'scopeGroup') {
            return this.loader
                .getByScope(node.scope)
                .map(s => new SkillItem(s));
        }

        return [];
    }
}
