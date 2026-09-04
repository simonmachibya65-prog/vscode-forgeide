import * as cp from 'child_process';
import * as path from 'path';
import * as util from 'util';
import {
    RiskClass,
    ToolType,
    ToolCall,
    ClassifiedToolCall,
    ToolResult,
    TaskBudget
} from '../daemon/types';

const execFile = util.promisify(cp.execFile);

/**
 * RiskPolicy — computes RiskClass for every tool call server-side.
 * The model/caller NEVER sets riskClass directly; it is always derived here.
 *
 * Classification rules:
 *   safe     — read_file, git_op (read-only subset), mcp_call (read-only tools)
 *   elevated — edit_file, run_shell, git_op (write subset), mcp_call (write tools)
 */
export class RiskPolicy {
    private static SAFE_GIT_ARGS = ['status', 'log', 'diff', 'show', 'ls-files', 'stash list'];
    private static SAFE_MCP_PATTERNS = [/^get_/, /^list_/, /^read_/, /^fetch_/, /^search_/];

    static classify(call: ToolCall): ClassifiedToolCall {
        let riskClass: RiskClass;
        let reason: string;

        switch (call.type) {
            case 'read_file':
                riskClass = 'safe';
                reason = 'read_file never modifies disk';
                break;

            case 'edit_file':
                riskClass = 'elevated';
                reason = 'edit_file writes to disk';
                break;

            case 'run_shell': {
                // Any shell execution is elevated — no exceptions
                riskClass = 'elevated';
                reason = `run_shell executes "${call.target}" in the host environment`;
                break;
            }

            case 'git_op': {
                const isSafe = RiskPolicy.SAFE_GIT_ARGS.some(
                    safe => call.target.startsWith(safe)
                );
                riskClass = isSafe ? 'safe' : 'elevated';
                reason = isSafe
                    ? `git ${call.target} is read-only`
                    : `git ${call.target} may modify repository state`;
                break;
            }

            case 'mcp_call': {
                const isSafe = RiskPolicy.SAFE_MCP_PATTERNS.some(p => p.test(call.target));
                riskClass = isSafe ? 'safe' : 'elevated';
                reason = isSafe
                    ? `MCP tool "${call.target}" matches safe read-only pattern`
                    : `MCP tool "${call.target}" is not a known read-only tool`;
                break;
            }

            default:
                riskClass = 'elevated';
                reason = 'unknown tool type defaults to elevated';
        }

        return { ...call, riskClass, reason };
    }
}

export interface SandboxRule {
    /** Pattern to match the command binary name. Supports * wildcard. */
    command: string;
    /** Optional allowlist of argument prefixes. Empty = any args allowed. */
    allowedArgPrefixes?: string[];
    /** Timeout in ms. Default 30 000. */
    timeoutMs?: number;
    /** Risk class this rule operates at */
    riskClass?: RiskClass;
}

// Shell metacharacters that should never appear in individual arguments
const SHELL_META_RE = /[;&|`$><\\]/;

/**
 * ToolSandbox — executes tool calls with:
 *   1. RiskPolicy classification (server-side, not from model output)
 *   2. Budget enforcement (maxSteps, maxWallClockSec)
 *   3. Command allowlist + argument prefix check
 *   4. Path confinement (cwd must stay inside workspace root)
 *   5. Shell metacharacter blocking
 *   6. execFile only — never exec(string)
 */
export class ToolSandbox {
    private rules: SandboxRule[] = [];
    private workspaceRoot: string;

    constructor(workspaceRoot: string, rules: SandboxRule[] = []) {
        this.workspaceRoot = workspaceRoot;
        this.rules = rules;
    }

    allow(rule: SandboxRule): void {
        this.rules.push(rule);
    }

    addDefaultRules(): void {
        const defaults: SandboxRule[] = [
            { command: 'npm',    allowedArgPrefixes: ['install', 'run', 'test', 'build', 'lint'], timeoutMs: 120_000, riskClass: 'elevated' },
            { command: 'pnpm',   allowedArgPrefixes: ['install', 'run', 'test', 'build', 'lint'], timeoutMs: 120_000, riskClass: 'elevated' },
            { command: 'yarn',   allowedArgPrefixes: ['install', 'run', 'test', 'build', 'lint'], timeoutMs: 120_000, riskClass: 'elevated' },
            { command: 'bun',    allowedArgPrefixes: ['install', 'run', 'test', 'build', 'lint'], timeoutMs: 120_000, riskClass: 'elevated' },
            { command: 'npx',    timeoutMs: 120_000, riskClass: 'elevated' },
            { command: 'node',   timeoutMs: 60_000,  riskClass: 'elevated' },
            { command: 'git',    allowedArgPrefixes: ['add', 'status', 'diff', 'log', 'stash', 'commit', 'push', 'pull', 'checkout', 'branch', 'reset', 'restore'], riskClass: 'elevated' },
            { command: 'gh',     allowedArgPrefixes: ['pr', 'issue', 'repo', 'workflow'], timeoutMs: 120_000, riskClass: 'elevated' },
            { command: 'tsc',    timeoutMs: 60_000,  riskClass: 'safe' },
            { command: 'eslint', timeoutMs: 30_000,  riskClass: 'safe' },
            { command: 'pytest', timeoutMs: 120_000, riskClass: 'safe' },
            { command: 'cargo',  allowedArgPrefixes: ['build', 'test', 'check', 'clippy'], timeoutMs: 120_000, riskClass: 'safe' },
            { command: 'go',     allowedArgPrefixes: ['build', 'test', 'vet', 'fmt'],      timeoutMs: 60_000,  riskClass: 'safe' },
        ];
        defaults.forEach(r => this.allow(r));
    }

    /**
     * Classify a raw ToolCall and return ClassifiedToolCall.
     * Callers must use this before execute().
     */
    classify(call: ToolCall): ClassifiedToolCall {
        return RiskPolicy.classify(call);
    }

    /**
     * Check budget before executing a step. Returns false if budget exhausted.
     */
    checkBudget(budget: TaskBudget): { ok: boolean; reason?: string } {
        if (budget.usedSteps >= budget.maxSteps) {
            return { ok: false, reason: `Step budget exhausted (${budget.usedSteps}/${budget.maxSteps})` };
        }
        if (budget.startedAt !== undefined) {
            const elapsed = (Date.now() - budget.startedAt) / 1000;
            if (elapsed > budget.maxWallClockSec) {
                return { ok: false, reason: `Wall-clock budget exhausted (${Math.round(elapsed)}s / ${budget.maxWallClockSec}s)` };
            }
        }
        return { ok: true };
    }

    /**
     * Execute a shell command inside the sandbox.
     * Returns a ToolResult — never throws.
     */
    async run(
        command: string,
        args: string[],
        cwd?: string
    ): Promise<ToolResult> {
        // Allowlist check
        const rule = this.findRule(command);
        if (!rule) {
            return this.blocked(`Command "${command}" is not in the tool allowlist.`);
        }

        // Argument prefix check
        if (rule.allowedArgPrefixes?.length && args.length > 0) {
            const first = args[0];
            const allowed = rule.allowedArgPrefixes.some(p => first === p || first.startsWith(p));
            if (!allowed) {
                return this.blocked(
                    `Argument "${first}" not in allowed prefixes for "${command}": ` +
                    rule.allowedArgPrefixes.join(', ')
                );
            }
        }

        // Metacharacter check
        for (const arg of args) {
            if (SHELL_META_RE.test(arg)) {
                return this.blocked(`Argument "${arg}" contains disallowed shell metacharacters.`);
            }
        }

        // Path confinement
        const resolvedCwd = cwd ? path.resolve(cwd) : this.workspaceRoot;
        if (!resolvedCwd.startsWith(this.workspaceRoot)) {
            return this.blocked(
                `cwd "${resolvedCwd}" is outside workspace root "${this.workspaceRoot}".`
            );
        }

        // Execute via execFile — no shell string
        try {
            const { stdout, stderr } = await execFile(command, args, {
                cwd: resolvedCwd,
                timeout: rule.timeoutMs ?? 30_000,
                maxBuffer: 10 * 1024 * 1024
            });
            return { ok: true, output: stdout + (stderr ? `\n${stderr}` : '') };
        } catch (e: any) {
            return {
                ok: false,
                output: e.stdout ?? '',
                error: e.stderr ?? String(e.message)
            };
        }
    }

    /**
     * Execute a ClassifiedToolCall. Elevated calls require the caller
     * to have obtained explicit approval before invoking this.
     */
    async executeClassified(
        call: ClassifiedToolCall,
        budget: TaskBudget,
        cwd?: string
    ): Promise<ToolResult> {
        const budgetCheck = this.checkBudget(budget);
        if (!budgetCheck.ok) {
            return { ok: false, error: budgetCheck.reason };
        }

        budget.usedSteps++;

        if (call.type === 'run_shell') {
            const parts = call.target.split(' ');
            const cmd = parts[0];
            const args = parts.slice(1);
            return this.run(cmd, args, cwd);
        }

        if (call.type === 'git_op') {
            const args = call.target.split(' ');
            return this.run('git', args, cwd);
        }

        // read_file, edit_file, mcp_call are handled by callers
        // (file system / MCP manager) — sandbox just approves the classification
        return { ok: true, output: `Tool call "${call.type}" approved by sandbox.` };
    }

    private findRule(command: string): SandboxRule | undefined {
        const binary = path.basename(command);
        return this.rules.find(r => {
            if (r.command === binary) return true;
            if (r.command.includes('*')) {
                const re = new RegExp('^' + r.command.replace(/\*/g, '.*') + '$');
                return re.test(binary);
            }
            return false;
        });
    }

    private blocked(reason: string): ToolResult {
        return { ok: false, error: reason };
    }

    getRules(): SandboxRule[] { return [...this.rules]; }
}
