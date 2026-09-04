import * as vscode from 'vscode';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { fenceUntrustedContent } from '../security/promptGuard';

export interface McpServerConfig {
    name: string;
    transport: 'stdio' | 'sse';
    command?: string;   // stdio
    args?: string[];    // stdio
    url?: string;       // sse
}

export interface McpTool {
    name: string;
    description?: string;
    inputSchema: unknown;
}

interface ConnectedServer {
    config: McpServerConfig;
    client: Client;
    tools: McpTool[];
    status: 'connected' | 'error';
    error?: string;
}

export class McpManager implements vscode.Disposable {
    private servers = new Map<string, ConnectedServer>();
    private onChangeEmitter = new vscode.EventEmitter<void>();
    onServersChanged = this.onChangeEmitter.event;

    constructor(private outputChannel: vscode.OutputChannel) {}

    async connect(config: McpServerConfig): Promise<void> {
        this.outputChannel.appendLine(`Connecting to MCP server "${config.name}" via ${config.transport}...`);

        const client = new Client({ name: 'forgeide', version: '0.1.0' }, { capabilities: {} });

        try {
            const transport = config.transport === 'stdio'
                ? new StdioClientTransport({ command: config.command!, args: config.args ?? [] })
                : new SSEClientTransport(new URL(config.url!));

            await client.connect(transport);
            const { tools } = await client.listTools();

            this.servers.set(config.name, {
                config, client,
                tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
                status: 'connected'
            });
            this.outputChannel.appendLine(
                `MCP server "${config.name}" connected: ${tools.map(t => t.name).join(', ') || '(no tools)'}`
            );
        } catch (e: any) {
            this.servers.set(config.name, {
                config, client, tools: [], status: 'error', error: String(e?.message ?? e)
            });
            this.outputChannel.appendLine(`Failed to connect MCP server "${config.name}": ${e}`);
        }
        this.onChangeEmitter.fire();
    }

    async disconnect(name: string): Promise<void> {
        const server = this.servers.get(name);
        if (!server) return;
        try {
            await server.client.close();
        } catch {
            // already closed or never fully connected
        }
        this.servers.delete(name);
        this.onChangeEmitter.fire();
    }

    listServers(): { name: string; status: string; tools: McpTool[]; error?: string }[] {
        return [...this.servers.values()].map(s => ({
            name: s.config.name, status: s.status, tools: s.tools, error: s.error
        }));
    }

    listAllTools(): { server: string; tool: McpTool }[] {
        const out: { server: string; tool: McpTool }[] = [];
        for (const server of this.servers.values()) {
            if (server.status !== 'connected') continue;
            for (const tool of server.tools) out.push({ server: server.config.name, tool });
        }
        return out;
    }

    /**
     * Invokes a tool by (server, tool) name and returns its result rendered
     * as fenced untrusted content -- MCP tool output comes from an external
     * server and should be treated the same as any other untrusted input
     * before it's fed back into the model.
     */
    async invokeTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<string> {
        const server = this.servers.get(serverName);
        if (!server || server.status !== 'connected') {
            throw new Error(`MCP server "${serverName}" is not connected.`);
        }
        const result = await server.client.callTool({ name: toolName, arguments: args });
        const text = Array.isArray(result.content)
            ? result.content.map((c: any) => (c.type === 'text' ? c.text : `[${c.type} content]`)).join('\n')
            : String(result.content);
        return fenceUntrustedContent(`mcp:${serverName}.${toolName}`, text);
    }

    async loadFromSettings(): Promise<void> {
        const config = vscode.workspace.getConfiguration('forgeide');
        const servers = config.get<McpServerConfig[]>('mcpServers', []);
        for (const server of servers) {
            await this.connect(server);
        }
    }

    dispose() {
        for (const server of this.servers.values()) {
            server.client.close().catch(() => {});
        }
        this.servers.clear();
    }
}
