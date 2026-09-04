import * as vscode from 'vscode';
import {
    BedrockRuntimeClient,
    InvokeModelWithResponseStreamCommand
} from '@aws-sdk/client-bedrock-runtime';

export interface ModelMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
}

export interface StreamHandle {
    onToken(cb: (token: string) => void): void;
    result(): Promise<string>;
}

export interface ModelClient {
    complete(messages: ModelMessage[], opts?: { maxTokens?: number }): Promise<string>;
    stream(messages: ModelMessage[], opts?: { maxTokens?: number }): Promise<StreamHandle>;
}

type Provider = 'anthropic' | 'openai' | 'bedrock';

function secretKeyFor(provider: Provider): string {
    return `forgeide.apiKey.${provider}`;
}

async function getApiKey(context: vscode.ExtensionContext, provider: Provider): Promise<string> {
    const key = secretKeyFor(provider);
    const existing = await context.secrets.get(key);
    if (existing) return existing;

    const entered = await vscode.window.showInputBox({
        prompt: `Enter your ${provider} API key (stored securely in VS Code SecretStorage, asked once)`,
        password: true,
        ignoreFocusOut: true
    });
    if (!entered) throw new Error(`No API key provided for ${provider}.`);
    await context.secrets.store(key, entered);
    return entered;
}

function splitSystem(messages: ModelMessage[]): { system?: string; rest: ModelMessage[] } {
    const system = messages.find(m => m.role === 'system')?.content;
    const rest = messages.filter(m => m.role !== 'system');
    return { system, rest };
}

export class MultiProviderModelClient implements ModelClient {
    constructor(
        private context: vscode.ExtensionContext,
        private providerOverride?: string,
        private modelOverride?: string
    ) {}

    private provider(): Provider {
        return (this.providerOverride as Provider)
            ?? vscode.workspace.getConfiguration('forgeide').get<Provider>('model.provider', 'anthropic');
    }

    private modelName(): string {
        return this.modelOverride
            ?? vscode.workspace.getConfiguration('forgeide').get<string>('model.name', 'claude-sonnet-4-6');
    }

    async complete(messages: ModelMessage[], opts?: { maxTokens?: number }): Promise<string> {
        const handle = await this.stream(messages, opts);
        return handle.result();
    }

    async stream(messages: ModelMessage[], opts?: { maxTokens?: number }): Promise<StreamHandle> {
        const provider = this.provider();
        if (provider === 'anthropic') return this.streamAnthropic(messages, opts);
        if (provider === 'openai')    return this.streamOpenAI(messages, opts);
        return this.streamBedrock(messages, opts);
    }

    private async streamAnthropic(messages: ModelMessage[], opts?: { maxTokens?: number }): Promise<StreamHandle> {
        const apiKey = await getApiKey(this.context, 'anthropic');
        const { system, rest } = splitSystem(messages);

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: this.modelName(),
                max_tokens: opts?.maxTokens ?? 4096,
                system,
                stream: true,
                messages: rest.map(m => ({ role: m.role, content: m.content }))
            })
        });

        if (!response.ok || !response.body) {
            throw new Error(`Anthropic API error (${response.status}): ${await response.text()}`);
        }

        return sseToHandle(response.body, (event) => {
            if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
                return event.delta.text as string;
            }
            return undefined;
        });
    }

    private async streamOpenAI(messages: ModelMessage[], opts?: { maxTokens?: number }): Promise<StreamHandle> {
        const apiKey = await getApiKey(this.context, 'openai');

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: this.modelName(),
                max_tokens: opts?.maxTokens ?? 4096,
                stream: true,
                messages: messages.map(m => ({ role: m.role, content: m.content }))
            })
        });

        if (!response.ok || !response.body) {
            throw new Error(`OpenAI API error (${response.status}): ${await response.text()}`);
        }

        return sseToHandle(response.body, (event) => {
            return event.choices?.[0]?.delta?.content as string | undefined;
        });
    }

    /**
     * Bedrock — uses AWS SDK v3 with credential chain (env vars, ~/.aws/credentials,
     * IAM role). No bearer token needed — SigV4 is handled by the SDK automatically.
     *
     * Supported model IDs (set forgeide.model.name):
     *   anthropic.claude-3-5-sonnet-20241022-v2:0
     *   anthropic.claude-3-haiku-20240307-v1:0
     *   amazon.titan-text-express-v1
     *   meta.llama3-70b-instruct-v1:0
     */
    private async streamBedrock(messages: ModelMessage[], opts?: { maxTokens?: number }): Promise<StreamHandle> {
        const cfg = vscode.workspace.getConfiguration('forgeide');
        const region = cfg.get<string>('bedrock.region', 'us-east-1');
        const modelId = this.modelName();
        const { system, rest } = splitSystem(messages);

        const client = new BedrockRuntimeClient({ region });

        // Build Anthropic Messages API body (works for all Claude on Bedrock)
        const body = JSON.stringify({
            anthropic_version: 'bedrock-2023-05-31',
            max_tokens: opts?.maxTokens ?? 4096,
            system,
            messages: rest.map(m => ({ role: m.role, content: m.content }))
        });

        const command = new InvokeModelWithResponseStreamCommand({
            modelId,
            contentType: 'application/json',
            accept: 'application/json',
            body: Buffer.from(body)
        });

        const listeners: ((token: string) => void)[] = [];
        let fullText = '';
        let resolveDone: (v: string) => void = () => {};
        let rejectDone: (e: unknown) => void = () => {};
        const done = new Promise<string>((res, rej) => {
            resolveDone = res;
            rejectDone = rej;
        });

        (async () => {
            try {
                const response = await client.send(command);
                if (!response.body) { resolveDone(''); return; }

                for await (const event of response.body) {
                    if (event.chunk?.bytes) {
                        const decoded = JSON.parse(Buffer.from(event.chunk.bytes).toString('utf8'));
                        // Anthropic streaming format on Bedrock
                        let token: string | undefined;
                        if (decoded.type === 'content_block_delta' && decoded.delta?.type === 'text_delta') {
                            token = decoded.delta.text;
                        } else if (decoded.outputText) {
                            // Amazon Titan / Llama format
                            token = decoded.outputText;
                        }
                        if (token) {
                            fullText += token;
                            listeners.forEach(l => l(token!));
                        }
                    }
                }
                resolveDone(fullText);
            } catch (e) {
                rejectDone(e);
            }
        })();

        return {
            onToken: (cb) => listeners.push(cb),
            result: () => done
        };
    }
}

function sseToHandle(
    body: ReadableStream<Uint8Array>,
    extractToken: (parsedEvent: any) => string | undefined
): StreamHandle {
    const listeners: ((token: string) => void)[] = [];
    let fullText = '';
    let resolveDone: (v: string) => void = () => {};
    let rejectDone: (e: unknown) => void = () => {};
    const done = new Promise<string>((res, rej) => {
        resolveDone = res;
        rejectDone = rej;
    });

    (async () => {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        try {
            while (true) {
                const { value, done: streamDone } = await reader.read();
                if (streamDone) break;
                buffer += decoder.decode(value, { stream: true });

                let lineEnd: number;
                while ((lineEnd = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.slice(0, lineEnd).trim();
                    buffer = buffer.slice(lineEnd + 1);
                    if (!line.startsWith('data:')) continue;
                    const payload = line.slice(5).trim();
                    if (payload === '[DONE]') continue;
                    try {
                        const parsed = JSON.parse(payload);
                        const token = extractToken(parsed);
                        if (token) {
                            fullText += token;
                            listeners.forEach(l => l(token));
                        }
                    } catch {
                        // ignore malformed/partial SSE frames
                    }
                }
            }
            resolveDone(fullText);
        } catch (e) {
            rejectDone(e);
        }
    })();

    return {
        onToken: (cb) => listeners.push(cb),
        result: () => done
    };
}
