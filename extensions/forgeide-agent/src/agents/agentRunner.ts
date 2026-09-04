import * as vscode from 'vscode';
import * as path from 'path';
import { AgentDefinition, AgentRegistry, PermissionRule } from './agentRegistry';
import { ModelClient, ModelMessage } from '../modelClient';
import { SkillLoader } from '../skills/skillLoader';
import { SteeringLoader } from '../steering/steeringLoader';
import { ToolHarness, ProcessInfo } from '../tools/toolHarness';

/**
 * AgentRunner — executes an AgentDefinition against a user prompt.
 *
 * Responsibilities:
 *  - Builds the system prompt from agent definition + active skills + steering context.
 *  - Filters tool calls against the agent's `allowedTools` list.
 *  - Enforces file-path permission rules (permissions.rules) before any write.
 *  - Delegates to sub-agents via AgentRegistry when the agent's `subAgents` list is used.
 *  - Streams reasoning tokens to the output channel in real time.
 */

export interface RunOptions {
    prompt: string;
    /** Additional context to inject (e.g. selected code, open file content) */
    extraContext?: string;
    /** Cancellation token from VS Code */
    token?: vscode.CancellationToken;
    /** Stream tokens to this callback as they arrive */
    onToken?: (token: string) => void;
}

export interface RunResult {
    agentId: string;
    response: string;
    /** Any sub-agent results keyed by sub-agent id */
    subResults?: Record<string, string>;
    durationMs: number;
    toolsUsed: string[];
    blocked: string[];  // tools or paths that were blocked by permission rules
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Matches a string value against a glob-like pattern.
 * Supports `**` (any segments), `*` (any chars within a segment), and literals.
 */
function matchesPattern(pattern: string, value: string): boolean {
    // Normalise separators
    const p = pattern.replace(/\\/g, '/');
    const v = value.replace(/\\/g, '/');

    // Build regex from glob
    const escaped = p
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // escape regex specials except * and ?
        .replace(/\*\*/g, '§§')                 // temporarily replace **
        .replace(/\*/g,   '[^/]*')              // * = any chars within a segment
        .replace(/§§/g,   '.*');                // ** = any chars including /

    return new RegExp(`^${escaped}$`, 'i').test(v);
}

/**
 * Evaluate permission rules against a target (file path or tool name).
 * Rules are evaluated in order; last match wins (similar to .gitignore semantics).
 * Returns `true` (allowed) if no rule matches, matching the "open by default" policy.
 */
export function evaluatePermissions(rules: PermissionRule[], target: string): boolean {
    let allowed = true;  // default: allow
    for (const rule of rules) {
        if (matchesPattern(rule.pattern, target)) {
            allowed = rule.allow;
        }
    }
    return allowed;
}

// ─────────────────────────────────────────────────────────────────────────────
// AgentRunner
// ─────────────────────────────────────────────────────────────────────────────

export class AgentRunner {
    constructor(
        private model: ModelClient,
        private registry: AgentRegistry,
        private skillLoader: SkillLoader,
        private steeringLoader: SteeringLoader,
        private toolHarness: ToolHarness,
        private outputChannel: vscode.OutputChannel
    ) {}

    // ── Run ───────────────────────────────────────────────────────────────────

    async run(agent: AgentDefinition, opts: RunOptions): Promise<RunResult> {
        const startMs = Date.now();
        const toolsUsed: string[] = [];
        const blocked: string[] = [];
        const subResults: Record<string, string> = {};

        this.outputChannel.appendLine(`\nAgent "${agent.name}" starting...`);
        if (opts.token?.isCancellationRequested) {
            return { agentId: agent.id, response: '', durationMs: 0, toolsUsed, blocked };
        }

        // Build system prompt
        const systemPrompt = await this.buildSystemPrompt(agent, opts.prompt);

        // Run any sub-agents first to gather context
        for (const subId of agent.subAgents ?? []) {
            if (opts.token?.isCancellationRequested) break;
            const subAgent = this.registry.resolveSubAgent(subId);
            if (!subAgent) {
                this.outputChannel.appendLine(`  Sub-agent "${subId}" not found, skipping.`);
                continue;
            }
            this.outputChannel.appendLine(`  Delegating to sub-agent "${subAgent.name}"...`);
            try {
                const subResult = await this.run(subAgent, {
                    prompt: opts.prompt,
                    extraContext: opts.extraContext,
                    token: opts.token
                });
                subResults[subId] = subResult.response;
                toolsUsed.push(...subResult.toolsUsed);
                blocked.push(...subResult.blocked);
            } catch (e) {
                this.outputChannel.appendLine(`  Sub-agent "${subId}" error: ${e}`);
            }
        }

        // Build context from sub-agents
        const subContext = Object.entries(subResults).length
            ? '\n\n## Sub-agent context\n' +
              Object.entries(subResults)
                  .map(([id, text]) => `### ${id}\n${text}`)
                  .join('\n\n')
            : '';

        const userContent = [
            opts.extraContext ? `## Extra context\n${opts.extraContext}` : '',
            subContext,
            opts.prompt
        ].filter(Boolean).join('\n\n');

        const messages: ModelMessage[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userContent }
        ];

        // Stream the response
        let response = '';
        try {
            const handle = await this.model.stream(messages, { maxTokens: agent.maxTokens ?? 4096 });
            handle.onToken(tok => {
                response += tok;
                opts.onToken?.(tok);
                this.outputChannel.append(tok);
            });
            response = await handle.result();
        } catch (e) {
            this.outputChannel.appendLine(`Agent "${agent.name}" model error: ${e}`);
            throw e;
        }

        this.outputChannel.appendLine(
            `\nAgent "${agent.name}" done in ${Date.now() - startMs}ms. ` +
            `Tools used: ${toolsUsed.join(', ') || 'none'}`
        );

        return {
            agentId: agent.id,
            response,
            subResults: Object.keys(subResults).length ? subResults : undefined,
            durationMs: Date.now() - startMs,
            toolsUsed,
            blocked
        };
    }

    // ── Tool filtering ─────────────────────────────────────────────────────────

    /**
     * Returns true if the given tool name is allowed for the agent.
     * An empty allowedTools list means all tools are allowed.
     */
    isToolAllowed(agent: AgentDefinition, toolName: string): boolean {
        if (!agent.allowedTools.length) {
            // Still check permission rules if defined
            if (agent.permissions?.rules.length) {
                return evaluatePermissions(agent.permissions.rules, toolName);
            }
            return true;
        }
        if (!agent.allowedTools.includes(toolName)) return false;
        if (agent.permissions?.rules.length) {
            return evaluatePermissions(agent.permissions.rules, toolName);
        }
        return true;
    }

    /**
     * Returns true if the agent is allowed to read/write the given file path.
     * Applied before every fs_write, str_replace, fs_append, delete_file call.
     */
    isPathAllowed(agent: AgentDefinition, filePath: string): boolean {
        if (!agent.permissions?.rules.length) return true;

        // Convert absolute path to workspace-relative for matching
        const folders = vscode.workspace.workspaceFolders;
        let relative = filePath.replace(/\\/g, '/');
        if (folders?.length) {
            const wsRoot = folders[0].uri.fsPath.replace(/\\/g, '/');
            if (relative.startsWith(wsRoot)) {
                relative = relative.slice(wsRoot.length).replace(/^\//, '');
            }
        }
        return evaluatePermissions(agent.permissions.rules, relative);
    }

    // ── Context building ───────────────────────────────────────────────────────

    private async buildSystemPrompt(agent: AgentDefinition, contextText: string): Promise<string> {
        const parts: string[] = [agent.systemPrompt.trim()];

        // Inject active skills relevant to this context
        const skillsBlock = this.skillLoader.buildContextBlock(contextText);
        if (skillsBlock) {
            parts.push('---\n' + skillsBlock);
        }

        // Inject steering context
        const steeringDir = vscode.workspace.getConfiguration('forgeide')
            .get<string>('steering.directory', '.kiro/steering');
        try {
            const steeringText = await this.steeringLoader.load(steeringDir);
            if (steeringText) {
                parts.push('---\n## Project steering\n' + steeringText);
            }
        } catch { /* no steering files — not an error */ }

        // Tool constraints notice
        if (agent.allowedTools.length) {
            parts.push(
                '---\n## Tool constraints\n' +
                `You have access to these tools only: ${agent.allowedTools.join(', ')}.`
            );
        }

        // Running process context (list active dev servers)
        const processes = this.toolHarness.listProcesses();
        if (processes.length) {
            parts.push(
                '---\n## Active dev processes\n' +
                processes.map(p => `- [${p.status}] ${p.command} (pid ${p.pid})`).join('\n')
            );
        }

        return parts.join('\n\n');
    }

    // ── Convenience: run active agent ──────────────────────────────────────────

    async runActive(
        context: vscode.ExtensionContext,
        opts: RunOptions
    ): Promise<RunResult> {
        const agent = this.registry.getActive(context);
        return this.run(agent, opts);
    }

    // ── Permission check helpers (for use by task executor / hooks) ────────────

    /**
     * Check and log a write operation. Returns true if allowed, false if blocked.
     */
    checkWrite(agent: AgentDefinition, targetPath: string, blockedLog: string[]): boolean {
        const allowed = this.isPathAllowed(agent, targetPath);
        if (!allowed) {
            const rel = path.relative(
                vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', targetPath
            );
            this.outputChannel.appendLine(
                `Agent "${agent.name}": write BLOCKED to "${rel}" by permission rules.`
            );
            blockedLog.push(targetPath);
            vscode.window.showWarningMessage(
                `ForgeIDE: Agent "${agent.name}" blocked from writing to "${rel}".`
            );
        }
        return allowed;
    }
}
