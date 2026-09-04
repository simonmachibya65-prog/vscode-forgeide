import * as vscode from 'vscode';
import { McpManager, McpTool } from './mcpManager';

interface ServerRow {
    kind: 'server';
    name: string;
    status: string;
    error?: string;
    tools: McpTool[];
}
interface ToolRow {
    kind: 'tool';
    server: string;
    tool: McpTool;
}
type Row = ServerRow | ToolRow;

export class McpTreeProvider implements vscode.TreeDataProvider<Row> {
    private emitter = new vscode.EventEmitter<void>();
    onDidChangeTreeData = this.emitter.event;

    constructor(private mcp: McpManager) {
        mcp.onServersChanged(() => this.emitter.fire());
    }

    getTreeItem(row: Row): vscode.TreeItem {
        if (row.kind === 'server') {
            const item = new vscode.TreeItem(
                row.name,
                row.tools.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
            );
            item.description = row.status === 'connected' ? `${row.tools.length} tool(s)` : row.error ?? 'error';
            item.iconPath = new vscode.ThemeIcon(row.status === 'connected' ? 'plug' : 'error');
            item.contextValue = 'forgeide.mcpServer';
            return item;
        }
        const item = new vscode.TreeItem(row.tool.name);
        item.description = row.tool.description ?? '';
        item.iconPath = new vscode.ThemeIcon('tools');
        return item;
    }

    getChildren(row?: Row): Row[] {
        if (!row) {
            return this.mcp.listServers().map(s => ({ kind: 'server', ...s } as ServerRow));
        }
        if (row.kind === 'server') {
            return row.tools.map(tool => ({ kind: 'tool', server: row.name, tool } as ToolRow));
        }
        return [];
    }
}
