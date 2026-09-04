import * as vscode from 'vscode';
import { AgentDefinition, AgentRegistry, AgentScope } from './agentRegistry';

// ── Tree node types ───────────────────────────────────────────────────────────

type AgentsTreeNode = ScopeGroup | AgentItem;

class ScopeGroup extends vscode.TreeItem {
    readonly kind = 'scopeGroup' as const;
    constructor(
        public readonly scope: AgentScope,
        public readonly count: number
    ) {
        const label =
            scope === 'builtin'   ? 'Built-in' :
            scope === 'global'    ? 'Global (~/.kiro/agents)' :
                                    'Workspace (.kiro/agents)';
        super(label, vscode.TreeItemCollapsibleState.Expanded);
        this.contextValue = `forgeide.agentScope.${scope}`;
        this.iconPath = new vscode.ThemeIcon(
            scope === 'builtin'   ? 'robot' :
            scope === 'global'    ? 'home'  :
                                    'folder-library'
        );
        this.description = `${count} agent${count !== 1 ? 's' : ''}`;
    }
}

class AgentItem extends vscode.TreeItem {
    readonly kind = 'agentItem' as const;
    constructor(
        public readonly agent: AgentDefinition,
        public readonly isActive: boolean
    ) {
        super(agent.name, vscode.TreeItemCollapsibleState.None);
        this.contextValue = isActive ? 'forgeide.agent.active' : 'forgeide.agent';
        this.iconPath = new vscode.ThemeIcon(
            isActive      ? 'play-circle'  :
            agent.scope === 'builtin' ? 'circuit-board' :
                                        'person'
        );
        this.description = isActive ? '● active' : (agent.allowedTools.length
            ? `${agent.allowedTools.length} tool(s)`
            : 'full access');
        this.tooltip = new vscode.MarkdownString(
            `**${agent.name}** \`[${agent.scope}]\`\n\n` +
            `_${agent.description}_\n\n` +
            (agent.allowedTools.length
                ? `**Allowed tools:** ${agent.allowedTools.join(', ')}\n\n`
                : '**Allowed tools:** all\n\n') +
            (agent.subAgents?.length
                ? `**Sub-agents:** ${agent.subAgents.join(', ')}\n\n`
                : '') +
            (agent.sourcePath
                ? `Source: \`${agent.sourcePath}\``
                : '_Built-in_')
        );
        if (agent.sourcePath) {
            this.command = {
                command: 'forgeide.openAgent',
                title: 'Open Agent Definition',
                arguments: [agent.sourcePath]
            };
        }
    }
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class AgentsTreeProvider implements vscode.TreeDataProvider<AgentsTreeNode> {
    private emitter = new vscode.EventEmitter<void>();
    onDidChangeTreeData = this.emitter.event;

    private activeAgentId = 'default';

    constructor(
        private registry: AgentRegistry,
        private extensionContext: vscode.ExtensionContext
    ) {
        registry.onAgentsChanged(() => this.refresh());
    }

    refresh(): void {
        this.activeAgentId = this.registry.getActive(this.extensionContext).id;
        this.emitter.fire();
    }

    getTreeItem(node: AgentsTreeNode): vscode.TreeItem {
        return node;
    }

    getChildren(node?: AgentsTreeNode): AgentsTreeNode[] {
        if (!node) {
            // Root: one group per scope that has agents
            const all = this.registry.listAll();
            const groups: ScopeGroup[] = [];

            const scopes: AgentScope[] = ['builtin', 'global', 'workspace'];
            for (const scope of scopes) {
                const count = all.filter(a => a.scope === scope).length;
                if (count > 0 || scope === 'workspace') {
                    groups.push(new ScopeGroup(scope, count));
                }
            }
            return groups;
        }

        if (node.kind === 'scopeGroup') {
            return this.registry
                .listByScope(node.scope)
                .map(a => new AgentItem(a, a.id === this.activeAgentId));
        }

        return [];
    }
}
