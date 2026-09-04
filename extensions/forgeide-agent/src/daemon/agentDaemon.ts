import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';

/**
 * AgentDaemon — local IPC server that runs as a long-lived process alongside
 * the IDE extension. The extension communicates with it over a Unix domain
 * socket (macOS/Linux) or a named pipe (Windows).
 *
 * The daemon owns all heavy subsystems so they survive across extension
 * reloads, and so background tasks keep running when the editor loses focus.
 *
 * Protocol: newline-delimited JSON over the socket.
 *   Request:  { id, command, payload }
 *   Response: { id, ok, data?, error?, stream? }
 *   Stream:   { id, stream: true, chunk, done? }
 */

export type DaemonCommand =
    | 'ping'
    | 'chat'
    | 'spec.create'
    | 'spec.advance'
    | 'spec.approve'
    | 'task.run'
    | 'task.verify'
    | 'hook.fire'
    | 'index.rebuild'
    | 'shutdown';

export interface DaemonRequest {
    id: string;
    command: DaemonCommand;
    payload?: unknown;
}

export interface DaemonResponse {
    id: string;
    ok: boolean;
    data?: unknown;
    error?: string;
    stream?: boolean;
    chunk?: string;
    done?: boolean;
}

type CommandHandler = (payload: unknown, send: (r: Partial<DaemonResponse>) => void) => Promise<void>;

export class AgentDaemon extends EventEmitter {
    private server: net.Server;
    private handlers = new Map<DaemonCommand, CommandHandler>();
    private connections = new Set<net.Socket>();
    private socketPath: string;

    constructor(socketPath?: string) {
        super();
        this.socketPath = socketPath ?? AgentDaemon.defaultSocketPath();
        this.server = net.createServer(sock => this.handleConnection(sock));
    }

    static defaultSocketPath(): string {
        if (process.platform === 'win32') {
            return '\\\\.\\pipe\\forgeide-agent';
        }
        return path.join(os.tmpdir(), 'forgeide-agent.sock');
    }

    /** Register a command handler. Call before start(). */
    on(command: DaemonCommand, handler: CommandHandler): this {
        this.handlers.set(command, handler);
        return this;
    }

    async start(): Promise<void> {
        // Remove stale socket file on Unix
        if (process.platform !== 'win32' && fs.existsSync(this.socketPath)) {
            fs.unlinkSync(this.socketPath);
        }

        await new Promise<void>((resolve, reject) => {
            this.server.listen(this.socketPath, () => resolve());
            this.server.once('error', reject);
        });

        console.log(`[AgentDaemon] listening on ${this.socketPath}`);
    }

    async stop(): Promise<void> {
        for (const sock of this.connections) sock.destroy();
        await new Promise<void>(resolve => this.server.close(() => resolve()));
        if (process.platform !== 'win32' && fs.existsSync(this.socketPath)) {
            fs.unlinkSync(this.socketPath);
        }
        console.log('[AgentDaemon] stopped.');
    }

    private handleConnection(sock: net.Socket): void {
        this.connections.add(sock);
        sock.on('close', () => this.connections.delete(sock));

        let buffer = '';
        sock.on('data', (chunk) => {
            buffer += chunk.toString();
            let nl: number;
            while ((nl = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, nl).trim();
                buffer = buffer.slice(nl + 1);
                if (!line) continue;
                try {
                    const req: DaemonRequest = JSON.parse(line);
                    this.dispatch(req, sock);
                } catch (e) {
                    this.send(sock, { id: '?', ok: false, error: `Parse error: ${e}` });
                }
            }
        });

        sock.on('error', (e) => console.error('[AgentDaemon] socket error:', e.message));
    }

    private async dispatch(req: DaemonRequest, sock: net.Socket): Promise<void> {
        if (req.command === 'ping') {
            this.send(sock, { id: req.id, ok: true, data: 'pong' });
            return;
        }
        if (req.command === 'shutdown') {
            this.send(sock, { id: req.id, ok: true, data: 'shutting down' });
            setImmediate(() => this.stop());
            return;
        }

        const handler = this.handlers.get(req.command);
        if (!handler) {
            this.send(sock, { id: req.id, ok: false, error: `Unknown command: ${req.command}` });
            return;
        }

        try {
            await handler(req.payload, (partial) => {
                this.send(sock, { id: req.id, ok: true, ...partial });
            });
        } catch (e: any) {
            this.send(sock, { id: req.id, ok: false, error: String(e?.message ?? e) });
        }
    }

    private send(sock: net.Socket, response: Partial<DaemonResponse>): void {
        if (!sock.writable) return;
        sock.write(JSON.stringify(response) + '\n');
    }

    getSocketPath(): string { return this.socketPath; }
}
