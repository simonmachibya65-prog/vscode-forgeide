import * as net from 'net';
import { randomUUID } from 'crypto';
import { AgentDaemon, DaemonCommand, DaemonRequest, DaemonResponse } from './agentDaemon';

/**
 * IpcClient — extension-side client that talks to the AgentDaemon over the
 * local socket. Handles reconnection, request/response correlation, and
 * streaming chunks back to the chat UI via callbacks.
 */
export class IpcClient {
    private socket: net.Socket | null = null;
    private buffer = '';
    private pending = new Map<string, {
        resolve: (data: unknown) => void;
        reject: (err: Error) => void;
        onChunk?: (chunk: string) => void;
    }>();
    private connecting = false;
    private socketPath: string;

    constructor(socketPath?: string) {
        this.socketPath = socketPath ?? AgentDaemon.defaultSocketPath();
    }

    async connect(): Promise<void> {
        if (this.socket?.writable) return;
        if (this.connecting) return;
        this.connecting = true;

        return new Promise((resolve, reject) => {
            const sock = net.createConnection(this.socketPath, () => {
                this.socket = sock;
                this.connecting = false;
                resolve();
            });

            sock.on('data', (chunk) => this.handleData(chunk.toString()));
            sock.on('close', () => {
                this.socket = null;
                // Reject all pending requests
                for (const [, p] of this.pending) {
                    p.reject(new Error('IPC connection closed.'));
                }
                this.pending.clear();
            });
            sock.on('error', (e) => {
                this.connecting = false;
                reject(e);
            });
        });
    }

    async send<T = unknown>(
        command: DaemonCommand,
        payload?: unknown,
        onChunk?: (chunk: string) => void
    ): Promise<T> {
        await this.connect();

        const id = randomUUID();
        const req: DaemonRequest = { id, command, payload };

        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, {
                resolve: (data) => resolve(data as T),
                reject,
                onChunk
            });
            this.socket!.write(JSON.stringify(req) + '\n');
        });
    }

    /** Convenience: stream chat tokens directly to a callback. */
    async streamChat(
        messages: { role: string; content: string }[],
        onToken: (token: string) => void
    ): Promise<string> {
        let full = '';
        await this.send('chat', { messages }, (chunk) => {
            full += chunk;
            onToken(chunk);
        });
        return full;
    }

    async ping(): Promise<boolean> {
        try {
            const res = await this.send<string>('ping');
            return res === 'pong';
        } catch {
            return false;
        }
    }

    private handleData(raw: string): void {
        this.buffer += raw;
        let nl: number;
        while ((nl = this.buffer.indexOf('\n')) !== -1) {
            const line = this.buffer.slice(0, nl).trim();
            this.buffer = this.buffer.slice(nl + 1);
            if (!line) continue;
            try {
                const resp: DaemonResponse = JSON.parse(line);
                this.handleResponse(resp);
            } catch {
                // malformed frame — ignore
            }
        }
    }

    private handleResponse(resp: DaemonResponse): void {
        const pending = this.pending.get(resp.id);
        if (!pending) return;

        if (!resp.ok) {
            pending.reject(new Error(resp.error ?? 'Daemon error'));
            this.pending.delete(resp.id);
            return;
        }

        // Streaming chunk
        if (resp.stream && resp.chunk !== undefined) {
            pending.onChunk?.(resp.chunk);
            if (resp.done) {
                pending.resolve(resp.data);
                this.pending.delete(resp.id);
            }
            return;
        }

        // Normal response
        pending.resolve(resp.data);
        this.pending.delete(resp.id);
    }

    disconnect(): void {
        this.socket?.destroy();
        this.socket = null;
    }

    isConnected(): boolean {
        return this.socket?.writable ?? false;
    }
}
