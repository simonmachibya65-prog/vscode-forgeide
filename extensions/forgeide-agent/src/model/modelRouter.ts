import * as vscode from 'vscode';
import {
    RoutingPolicy,
    RoutingOverride,
    ModelRequest,
    ModelResponse,
    ModelMessage as DaemonModelMessage
} from '../daemon/types';
import { ModelClient, ModelMessage, StreamHandle } from '../modelClient';

/**
 * ModelRouter — routes model requests to providers using RoutingPolicy
 * from daemon/types.ts.
 *
 * Policy resolution order:
 *   1. Check overrides: taskType match first, then fileGlob match
 *   2. Fall back to policy.default
 *   3. On rate-limit → policy.fallback.onRateLimit
 *   4. On outage    → policy.fallback.onOutage
 *
 * Circuit breaker: a provider that errored within the last 60 s is skipped
 * and the fallback is used instead.
 */

const CIRCUIT_BREAKER_WINDOW_MS = 60_000;

interface ProviderState {
    lastErrorAt?: number;
    requests: number;
    errors: number;
    totalLatencyMs: number;
}

export class ModelRouter implements ModelClient {
    private policy: RoutingPolicy;
    private states = new Map<string, ProviderState>();
    private delegates = new Map<string, ModelClient>();

    constructor(private context: vscode.ExtensionContext) {
        this.policy = this.loadPolicy();
    }

    private loadPolicy(): RoutingPolicy {
        const cfg = vscode.workspace.getConfiguration('forgeide');
        const provider = cfg.get<string>('model.provider', 'anthropic');
        const model    = cfg.get<string>('model.name', 'claude-sonnet-4-6');
        const extras   = cfg.get<RoutingOverride[]>('router.providers', []) as RoutingOverride[];

        // Default policy: one provider, no overrides, self-fallback
        const defaultModel = `${provider}/${model}`;
        const stored = cfg.get<Partial<RoutingPolicy>>('router.policy');
        if (stored?.default) {
            return {
                default: stored.default,
                overrides: stored.overrides ?? extras,
                fallback: stored.fallback ?? { onRateLimit: defaultModel, onOutage: defaultModel }
            };
        }
        return {
            default: defaultModel,
            overrides: extras,
            fallback: { onRateLimit: defaultModel, onOutage: defaultModel }
        };
    }

    // ── ModelClient interface ─────────────────────────────────────────────────

    async complete(messages: ModelMessage[], opts?: { maxTokens?: number }): Promise<string> {
        const handle = await this.stream(messages, opts);
        return handle.result();
    }

    async stream(messages: ModelMessage[], opts?: { maxTokens?: number }): Promise<StreamHandle> {
        this.policy = this.loadPolicy();
        const modelId = this.resolveModel({ messages: this.toDeamonMessages(messages), toolsAvailable: [] });
        return this.streamWithModel(modelId, messages, opts);
    }

    // ── Daemon-typed routing ──────────────────────────────────────────────────

    /**
     * Route a ModelRequest (typed per daemon/types.ts) and return a StreamHandle.
     * Uses taskType + fileHint for override resolution.
     */
    async routeRequest(req: ModelRequest, opts?: { maxTokens?: number }): Promise<StreamHandle> {
        this.policy = this.loadPolicy();
        const modelId = this.resolveModel(req);
        const messages = req.messages.map(m => ({ role: m.role as ModelMessage['role'], content: m.content }));
        return this.streamWithModel(modelId, messages, opts);
    }

    /**
     * Parse a model's text response into a ModelResponse struct.
     * Looks for a tool call in the format:
     *   TOOL_CALL: <type> "<target>" [content]
     */
    parseModelResponse(text: string): ModelResponse {
        const toolLine = text.match(/^TOOL_CALL:\s*(\w+)\s+"([^"]+)"(?:\s+(.+))?$/m);
        if (toolLine) {
            const [, type, target, content] = toolLine;
            return {
                toolCall: { type: type as any, target, content },
                done: false
            };
        }
        return { text: text.trim(), done: true };
    }

    // ── Resolution logic ──────────────────────────────────────────────────────

    resolveModel(req: ModelRequest): string {
        // 1 — check overrides in order
        for (const override of this.policy.overrides) {
            // taskType match
            if (override.taskType && req.taskType === override.taskType) {
                if (this.isHealthy(override.model)) return override.model;
            }
            // fileGlob match against fileHint
            if (override.fileGlobs?.length && req.fileHint) {
                const match = override.fileGlobs.some(glob => {
                    const re = new RegExp('^' + glob.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
                    return re.test(req.fileHint!);
                });
                if (match && this.isHealthy(override.model)) return override.model;
            }
        }

        // 2 — default
        if (this.isHealthy(this.policy.default)) return this.policy.default;

        // 3 — rate-limit fallback (same logic for now — caller decides)
        if (this.isHealthy(this.policy.fallback.onRateLimit)) return this.policy.fallback.onRateLimit;

        // 4 — outage fallback
        return this.policy.fallback.onOutage;
    }

    private async streamWithModel(
        modelId: string,
        messages: ModelMessage[],
        opts?: { maxTokens?: number }
    ): Promise<StreamHandle> {
        const delegate = this.getDelegate(modelId);
        const start = Date.now();
        try {
            const handle = await delegate.stream(messages, opts);
            this.recordSuccess(modelId, Date.now() - start);
            return handle;
        } catch (e: any) {
            this.recordError(modelId);
            // Try fallback once
            const fallback = this.policy.fallback.onOutage;
            if (fallback !== modelId && this.isHealthy(fallback)) {
                const fallbackDelegate = this.getDelegate(fallback);
                return fallbackDelegate.stream(messages, opts);
            }
            throw e;
        }
    }

    private getDelegate(modelId: string): ModelClient {
        if (this.delegates.has(modelId)) return this.delegates.get(modelId)!;
        const [provider, model] = modelId.split('/');
        const { MultiProviderModelClient } = require('../modelClient');
        const delegate = new MultiProviderModelClient(this.context, provider, model);
        this.delegates.set(modelId, delegate);
        return delegate;
    }

    private isHealthy(modelId: string): boolean {
        const state = this.states.get(modelId);
        if (!state?.lastErrorAt) return true;
        return Date.now() - state.lastErrorAt > CIRCUIT_BREAKER_WINDOW_MS;
    }

    private recordSuccess(modelId: string, latencyMs: number): void {
        const s = this.states.get(modelId) ?? { requests: 0, errors: 0, totalLatencyMs: 0 };
        this.states.set(modelId, { ...s, requests: s.requests + 1, totalLatencyMs: s.totalLatencyMs + latencyMs });
    }

    private recordError(modelId: string): void {
        const s = this.states.get(modelId) ?? { requests: 0, errors: 0, totalLatencyMs: 0 };
        this.states.set(modelId, { ...s, errors: s.errors + 1, lastErrorAt: Date.now() });
    }

    private toDeamonMessages(messages: ModelMessage[]): DaemonModelMessage[] {
        return messages.map(m => ({ role: m.role as DaemonModelMessage['role'], content: m.content }));
    }

    getPolicy(): RoutingPolicy { return { ...this.policy }; }

    getStats(): { modelId: string; requests: number; errors: number; avgLatencyMs: number }[] {
        return [...this.states.entries()].map(([modelId, s]) => ({
            modelId,
            requests: s.requests,
            errors: s.errors,
            avgLatencyMs: s.requests > 0 ? Math.round(s.totalLatencyMs / s.requests) : 0
        }));
    }
}
