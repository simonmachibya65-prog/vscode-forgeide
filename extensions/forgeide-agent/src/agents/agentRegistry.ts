import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';

/**
 * AgentRegistry — manages custom agent definitions.
 *
 * Agent definitions live in:
 *   - Built-in: hardcoded in this file (Default, Spec, QuickSpec, BugFix)
 *   - Workspace: .kiro/agents/<id>.json
 *   - Global:    ~/.kiro/agents/<id>.json
 *
 * Agent JSON schema:
 * {
 *   id:           string,
 *   name:         string,
 *   description:  string,
 *   systemPrompt: string,
 *   allowedTools: string[],   // subset of tool names; empty = all allowed
 *   permissions: {
 *     rules: [ { pattern: string, allow: boolean } ]
 *   },
 *   subAgents:  string[],     // other agent ids to delegate to
 *   model:      string,       // optional model override
 *   maxTokens:  number
 * }
 */

export interface PermissionRule {
    /** Glob-style pattern to match against file paths or tool names */
    pattern: string;
    allow: boolean;
}

export interface AgentPermissions {
    rules: PermissionRule[];
}

export type AgentScope = 'builtin' | 'global' | 'workspace';

export interface AgentDefinition {
    id: string;
    name: string;
    description: string;
    systemPrompt: string;
    /** Tool names this agent is allowed to use. Empty = all tools allowed. */
    allowedTools: string[];
    permissions?: AgentPermissions;
    /** IDs of sub-agents this agent may delegate tasks to */
    subAgents?: string[];
    /** Optional model override for this agent */
    model?: string;
    maxTokens?: number;
    scope: AgentScope;
    sourcePath?: string;  // undefined for builtins
}

// ─────────────────────────────────────────────────────────────────────────────
// Built-in agent definitions
// ─────────────────────────────────────────────────────────────────────────────

const BUILTIN_AGENTS: Omit<AgentDefinition, 'scope'>[] = [
    {
        id: 'default',
        name: 'Default',
        description: 'General-purpose coding assistant. Full tool access with standard safety rules.',
        systemPrompt: `You are ForgeIDE's Default agent — a knowledgeable, direct coding assistant.
You have access to the full tool suite. Follow safe coding practices: parameterized queries,
input validation, proper error handling. Prefer targeted edits over full rewrites.
Explain your reasoning when making recommendations.`,
        allowedTools: [],  // empty = no restriction
        permissions: {
            rules: [
                { pattern: '**/.env',             allow: false },
                { pattern: '**/*.pem',            allow: false },
                { pattern: '**/secrets/**',       allow: false },
                { pattern: '**',                  allow: true  }
            ]
        },
        subAgents: ['context-gatherer']
    },
    {
        id: 'spec',
        name: 'Spec',
        description: 'Structured spec-driven agent. Runs the full requirements → design → tasks workflow.',
        systemPrompt: `You are ForgeIDE's Spec agent. Your job is to transform a feature prompt into
a structured spec (requirements, design, tasks) and then implement it task-by-task.
Always validate requirements with EARS notation. Gate code generation behind task approval.
Be thorough in requirements; be concise in implementation.`,
        allowedTools: [
            'fs_write', 'str_replace', 'fs_append', 'read_file', 'read_code',
            'grep_search', 'file_search', 'execute_pwsh', 'todo_list'
        ],
        permissions: {
            rules: [
                { pattern: '**/.env',       allow: false },
                { pattern: '**/*.pem',      allow: false },
                { pattern: '**',            allow: true  }
            ]
        },
        subAgents: ['context-gatherer', 'general-task-execution']
    },
    {
        id: 'quickspec',
        name: 'QuickSpec',
        description: 'Fast one-shot spec agent. Skips the approval gates and implements immediately.',
        systemPrompt: `You are ForgeIDE's QuickSpec agent. Given a feature prompt, generate a
minimal spec and implement it in one pass without waiting for approval gates.
Prefer pragmatic, working code over perfect architecture. Flag anything that needs
human review with a TODO comment.`,
        allowedTools: [
            'fs_write', 'str_replace', 'fs_append', 'read_file', 'read_code',
            'grep_search', 'file_search', 'execute_pwsh'
        ],
        permissions: {
            rules: [
                { pattern: '**/.env',   allow: false },
                { pattern: '**/*.pem',  allow: false },
                { pattern: '**',        allow: true  }
            ]
        },
        subAgents: []
    },
    {
        id: 'bugfix',
        name: 'BugFix',
        description: 'Focused bug-fixing agent. Diagnoses, proposes minimal fix, verifies with tests.',
        systemPrompt: `You are ForgeIDE's BugFix agent. Given a bug report or failing test, your job is to:
1. Read the relevant code and understand the root cause.
2. Propose the minimal fix — avoid unrelated changes.
3. Run existing tests to verify the fix.
4. If no tests exist for this path, add a targeted regression test.
Never silence errors without explaining why. Prefer fixes that address root cause over
workarounds.`,
        allowedTools: [
            'read_file', 'read_code', 'grep_search', 'file_search',
            'str_replace', 'execute_pwsh'
        ],
        permissions: {
            rules: [
                { pattern: '**/.env',   allow: false },
                { pattern: '**/*.pem',  allow: false },
                { pattern: '**',        allow: true  }
            ]
        },
        subAgents: ['context-gatherer']
    }
];

// Additional built-ins that weren't in the original list
const EXTRA_BUILTINS: Omit<AgentDefinition, 'scope'>[] = [
    {
        id: 'context-gatherer',
        name: 'Context Gatherer',
        description: 'Investigates the codebase to answer specific questions. Used as a sub-agent by Default and Spec.',
        systemPrompt: `You are ForgeIDE's Context Gatherer sub-agent. Your sole job is to explore
the codebase to answer a specific question. You MUST:
1. Search for relevant files using available search tools.
2. Read the specific files and functions involved.
3. Trace execution paths and map dependencies.
4. Return a thorough written analysis pointing to specific files and lines.
Do NOT make changes. Return analysis only.`,
        allowedTools: ['read_file', 'read_code', 'grep_search', 'file_search'],
        permissions: { rules: [{ pattern: '**', allow: true }] },
        subAgents: []
    },
    {
        id: 'code-reviewer',
        name: 'Code Reviewer',
        description: 'Reviews PRs and diffs for correctness, security, and style.',
        systemPrompt: `You are ForgeIDE's Code Reviewer agent. Given a diff or set of changed files:
1. Check for correctness issues, off-by-ones, missing null checks.
2. Check for security issues: injection, hardcoded secrets, missing validation.
3. Check accessibility for any UI changes.
4. Check that code style matches the surrounding codebase.
Produce a structured review with severity: error | warning | suggestion.`,
        allowedTools: ['read_file', 'read_code', 'grep_search', 'file_search'],
        permissions: { rules: [{ pattern: '**', allow: true }] },
        subAgents: []
    }
];

// ─────────────────────────────────────────────────────────────────────────────
// AgentRegistry
// ─────────────────────────────────────────────────────────────────────────────

export class AgentRegistry implements vscode.Disposable {
    private agents = new Map<string, AgentDefinition>();
    private onChangeEmitter = new vscode.EventEmitter<AgentDefinition[]>();
    onAgentsChanged = this.onChangeEmitter.event;

    constructor(private outputChannel: vscode.OutputChannel) {
        // Register built-ins immediately
        for (const def of BUILTIN_AGENTS) {
            this.agents.set(def.id, { ...def, scope: 'builtin' });
        }
        for (const def of EXTRA_BUILTINS) {
            this.agents.set(def.id, { ...def, scope: 'builtin' });
        }
    }

    // ── Load ──────────────────────────────────────────────────────────────────

    /** Load agent definitions from global (~/.kiro/agents/) and workspace (.kiro/agents/). */
    async loadAll(): Promise<void> {
        // Load global agents first (workspace overrides global, both override builtins)
        const globalDir = path.join(os.homedir(), '.kiro', 'agents');
        await this.loadFromDir(globalDir, 'global');

        const folders = vscode.workspace.workspaceFolders;
        if (folders?.length) {
            const wsDir = path.join(folders[0].uri.fsPath, '.kiro', 'agents');
            await this.loadFromDir(wsDir, 'workspace');
        }

        this.outputChannel.appendLine(
            `Agents: ${this.agents.size} loaded (${BUILTIN_AGENTS.length} built-in + ${this.agents.size - BUILTIN_AGENTS.length} custom).`
        );
        this.onChangeEmitter.fire(this.listAll());
    }

    private async loadFromDir(dir: string, scope: AgentScope): Promise<void> {
        const dirUri = vscode.Uri.file(dir);
        let entries: [string, vscode.FileType][] = [];
        try {
            entries = await vscode.workspace.fs.readDirectory(dirUri);
        } catch {
            return;  // directory doesn't exist yet — that's fine
        }

        for (const [name, type] of entries) {
            if (type !== vscode.FileType.File || !name.endsWith('.json')) continue;
            const filePath = path.join(dir, name);
            try {
                const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
                const raw = JSON.parse(Buffer.from(bytes).toString('utf8'));
                const def: AgentDefinition = {
                    id:           raw.id           ?? name.replace('.json', ''),
                    name:         raw.name         ?? name.replace('.json', ''),
                    description:  raw.description  ?? '',
                    systemPrompt: raw.systemPrompt ?? '',
                    allowedTools: Array.isArray(raw.allowedTools) ? raw.allowedTools : [],
                    permissions:  raw.permissions,
                    subAgents:    Array.isArray(raw.subAgents) ? raw.subAgents : [],
                    model:        raw.model,
                    maxTokens:    raw.maxTokens,
                    scope,
                    sourcePath:   filePath
                };
                this.agents.set(def.id, def);
                this.outputChannel.appendLine(`Agents: loaded [${scope}] "${def.name}" from ${filePath}`);
            } catch (e) {
                this.outputChannel.appendLine(`Agents: failed to parse ${filePath}: ${e}`);
            }
        }
    }

    // ── Scaffold ──────────────────────────────────────────────────────────────

    /** Interactive wizard to scaffold a new custom agent definition file. */
    async scaffold(): Promise<void> {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders?.length) {
            vscode.window.showErrorMessage('Open a workspace folder first.');
            return;
        }

        const name = await vscode.window.showInputBox({
            prompt: 'Agent name (e.g. "API Reviewer")',
            placeHolder: 'My Agent'
        });
        if (!name) return;

        const description = await vscode.window.showInputBox({
            prompt: 'Short description — shown in the Agents panel',
            placeHolder: 'Reviews API changes for breaking changes and security issues'
        });
        if (description === undefined) return;

        const baseAgent = await vscode.window.showQuickPick(
            BUILTIN_AGENTS.map(a => ({ label: a.name, description: a.description, id: a.id })),
            { placeHolder: 'Start from which built-in agent?' }
        );
        if (!baseAgent) return;

        const base = BUILTIN_AGENTS.find(a => a.id === baseAgent.id)!;
        const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

        const def: Omit<AgentDefinition, 'scope' | 'sourcePath'> = {
            id,
            name,
            description,
            systemPrompt: base.systemPrompt + `\n\n# Custom instructions for ${name}\n(Add your agent-specific instructions here.)`,
            allowedTools: [...base.allowedTools],
            permissions:  base.permissions ? JSON.parse(JSON.stringify(base.permissions)) : undefined,
            subAgents:    [...(base.subAgents ?? [])],
            model:        undefined,
            maxTokens:    4096
        };

        const agentsDir = vscode.Uri.joinPath(folders[0].uri, '.kiro', 'agents');
        await vscode.workspace.fs.createDirectory(agentsDir);
        const fileUri = vscode.Uri.joinPath(agentsDir, `${id}.json`);
        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(JSON.stringify(def, null, 2), 'utf8'));

        const doc = await vscode.workspace.openTextDocument(fileUri);
        await vscode.window.showTextDocument(doc);
        vscode.window.showInformationMessage(
            `Agent "${name}" scaffolded at .kiro/agents/${id}.json`
        );

        await this.loadAll();
    }

    // ── Sub-agent invocation ──────────────────────────────────────────────────

    /**
     * Invoke a named sub-agent by id. Returns the agent definition so the
     * AgentRunner can execute it with a delegated prompt.
     * Sub-agents are identified by their id (e.g. "context-gatherer").
     */
    resolveSubAgent(id: string): AgentDefinition | undefined {
        return this.agents.get(id);
    }

    // ── Accessors ─────────────────────────────────────────────────────────────

    listAll(): AgentDefinition[] {
        return [...this.agents.values()];
    }

    listByScope(scope: AgentScope): AgentDefinition[] {
        return [...this.agents.values()].filter(a => a.scope === scope);
    }

    getById(id: string): AgentDefinition | undefined {
        return this.agents.get(id);
    }

    /** The active agent for the current session (persisted in workspace state). */
    getActive(context: vscode.ExtensionContext): AgentDefinition {
        const id = context.workspaceState.get<string>('forgeide.activeAgentId', 'default');
        return this.agents.get(id) ?? this.agents.get('default')!;
    }

    async setActive(context: vscode.ExtensionContext, id: string): Promise<void> {
        if (!this.agents.has(id)) throw new Error(`Agent "${id}" not found.`);
        await context.workspaceState.update('forgeide.activeAgentId', id);
        this.onChangeEmitter.fire(this.listAll());
    }

    dispose(): void {
        this.onChangeEmitter.dispose();
    }
}
