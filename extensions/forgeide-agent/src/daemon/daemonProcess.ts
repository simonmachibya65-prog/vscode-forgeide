import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { IpcClient } from './ipcClient';
import { AgentDaemon } from './agentDaemon';

/**
 * DaemonProcess — spawns the agent daemon as a separate Node.js child process
 * so it survives extension host reloads and window reloads.
 *
 * The daemon script is the compiled out/daemon/daemonEntry.js file.
 * On first activation we check if a daemon is already running on the socket
 * (ping test). If not, we spawn it. On deactivate we send 'shutdown'.
 */
export class DaemonProcess implements vscode.Disposable {
    private child: cp.ChildProcess | null = null;
    private readonly socketPath: string;
    readonly client: IpcClient;
    private outputChannel: vscode.OutputChannel;

    constructor(private context: vscode.ExtensionContext) {
        this.socketPath = AgentDaemon.defaultSocketPath();
        this.client = new IpcClient(this.socketPath);
        this.outputChannel = vscode.window.createOutputChannel('ForgeIDE — Daemon');
    }

    async ensureRunning(): Promise<void> {
        // Check if already running from a previous session
        const alive = await this.client.ping().catch(() => false);
        if (alive) {
            this.outputChannel.appendLine(`[daemon] reusing existing process on ${this.socketPath}`);
            return;
        }

        const entryScript = path.join(this.context.extensionPath, 'out', 'daemon', 'daemonEntry.js');
        if (!fs.existsSync(entryScript)) {
            this.outputChannel.appendLine(
                `[daemon] entry script not found at ${entryScript} — running in-process fallback`
            );
            return; // fall back to in-process daemon (already started in extension.ts)
        }

        this.outputChannel.appendLine(`[daemon] spawning ${entryScript}`);
        this.child = cp.fork(entryScript, [], {
            detached: true,   // keep alive after parent exits
            silent: true,
            env: {
                ...process.env,
                FORGEIDE_SOCKET: this.socketPath,
                FORGEIDE_WORKSPACE: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ''
            }
        });

        this.child.stdout?.on('data', d =>
            this.outputChannel.appendLine(`[daemon] ${d.toString().trim()}`));
        this.child.stderr?.on('data', d =>
            this.outputChannel.appendLine(`[daemon:err] ${d.toString().trim()}`));
        this.child.on('exit', (code) =>
            this.outputChannel.appendLine(`[daemon] exited with code ${code}`));

        // Unref so the daemon outlives the extension host
        this.child.unref();

        // Wait for daemon to be ready (up to 5 s)
        await this.waitForReady(5000);
    }

    private async waitForReady(timeoutMs: number): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            await delay(300);
            const ok = await this.client.ping().catch(() => false);
            if (ok) {
                this.outputChannel.appendLine('[daemon] ready');
                return;
            }
        }
        this.outputChannel.appendLine('[daemon] timed out waiting for ready — continuing anyway');
    }

    async stop(): Promise<void> {
        try {
            await this.client.send('shutdown').catch(() => {});
        } catch { /* already gone */ }
        this.client.disconnect();
        this.child = null;
    }

    dispose(): void {
        this.stop().catch(() => {});
        this.outputChannel.dispose();
    }
}

function delay(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}
