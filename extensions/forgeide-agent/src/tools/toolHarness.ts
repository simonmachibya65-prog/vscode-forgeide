import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as os from 'os';

/**
 * ToolHarness — unified interface for running and managing background
 * development processes (dev servers, build watchers, test runners).
 *
 * Maps to the three process-management tools:
 *   - control_bash_process (start / stop)
 *   - get_process_output   (tail stdout/stderr)
 *   - list_processes       (enumerate running processes)
 *
 * Design notes:
 *   - Processes are identified by a string terminalId, returned on start.
 *   - Output is buffered (up to MAX_BUFFER_LINES lines) so the agent can
 *     read it asynchronously after starting a server.
 *   - The same command+cwd combination reuses an existing process (idempotent
 *     start semantics — matching the Kiro control_pwsh_process behaviour).
 */

export type ProcessStatus = 'running' | 'stopped' | 'unknown';

export interface ProcessInfo {
    terminalId: string;
    command: string;
    cwd: string;
    pid?: number;
    status: ProcessStatus;
    startedAt: string;
    stoppedAt?: string;
}

const MAX_BUFFER_LINES = 500;

interface ManagedProcess {
    info: ProcessInfo;
    child: cp.ChildProcess;
    outputLines: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// ToolHarness
// ─────────────────────────────────────────────────────────────────────────────

export class ToolHarness implements vscode.Disposable {
    private processes = new Map<string, ManagedProcess>();
    private onChangeEmitter = new vscode.EventEmitter<ProcessInfo[]>();
    onProcessesChanged = this.onChangeEmitter.event;

    constructor(private outputChannel: vscode.OutputChannel) {}

    // ── control_bash_process ─────────────────────────────────────────────────

    /**
     * Start a background process. If an identical command+cwd is already
     * running, returns the existing process (isReused = true).
     */
    startProcess(command: string, cwd?: string): { terminalId: string; isReused: boolean } {
        const resolvedCwd = cwd
            ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
            ?? os.homedir();

        // Idempotent: reuse if same command+cwd already running
        for (const [id, proc] of this.processes) {
            if (
                proc.info.command === command &&
                proc.info.cwd === resolvedCwd &&
                proc.info.status === 'running'
            ) {
                this.outputChannel.appendLine(
                    `ToolHarness: reusing existing process [${id}] for "${command}"`
                );
                return { terminalId: id, isReused: true };
            }
        }

        const terminalId = `proc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const info: ProcessInfo = {
            terminalId,
            command,
            cwd: resolvedCwd,
            status: 'running',
            startedAt: new Date().toISOString()
        };

        const child = cp.spawn(command, {
            cwd: resolvedCwd,
            shell: true,
            env: { ...process.env }
        });

        info.pid = child.pid;

        const managed: ManagedProcess = { info, child, outputLines: [] };
        this.processes.set(terminalId, managed);

        const appendLine = (line: string) => {
            managed.outputLines.push(line);
            if (managed.outputLines.length > MAX_BUFFER_LINES) {
                managed.outputLines.splice(0, managed.outputLines.length - MAX_BUFFER_LINES);
            }
            this.outputChannel.appendLine(`[${terminalId}] ${line}`);
        };

        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');

        let stdoutBuf = '';
        child.stdout?.on('data', (chunk: string) => {
            stdoutBuf += chunk;
            let idx: number;
            while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
                appendLine(stdoutBuf.slice(0, idx));
                stdoutBuf = stdoutBuf.slice(idx + 1);
            }
        });

        let stderrBuf = '';
        child.stderr?.on('data', (chunk: string) => {
            stderrBuf += chunk;
            let idx: number;
            while ((idx = stderrBuf.indexOf('\n')) !== -1) {
                appendLine('[stderr] ' + stderrBuf.slice(0, idx));
                stderrBuf = stderrBuf.slice(idx + 1);
            }
        });

        child.on('close', (code) => {
            if (stdoutBuf) appendLine(stdoutBuf);
            if (stderrBuf) appendLine('[stderr] ' + stderrBuf);
            info.status = 'stopped';
            info.stoppedAt = new Date().toISOString();
            appendLine(`[exited code=${code}]`);
            this.onChangeEmitter.fire(this.listProcesses());
        });

        child.on('error', (err) => {
            info.status = 'stopped';
            info.stoppedAt = new Date().toISOString();
            appendLine(`[error] ${err.message}`);
            this.onChangeEmitter.fire(this.listProcesses());
        });

        this.outputChannel.appendLine(
            `ToolHarness: started [${terminalId}] "${command}" in ${resolvedCwd} (pid ${child.pid})`
        );
        this.onChangeEmitter.fire(this.listProcesses());
        return { terminalId, isReused: false };
    }

    /**
     * Stop a background process by terminalId.
     */
    stopProcess(terminalId: string): { success: boolean; message: string } {
        const proc = this.processes.get(terminalId);
        if (!proc) {
            return { success: false, message: `No process with id "${terminalId}".` };
        }
        if (proc.info.status !== 'running') {
            return { success: false, message: `Process [${terminalId}] is already stopped.` };
        }

        try {
            // On Windows, use taskkill to kill the whole process tree
            if (process.platform === 'win32' && proc.child.pid) {
                cp.execSync(`taskkill /PID ${proc.child.pid} /T /F`, { stdio: 'ignore' });
            } else {
                proc.child.kill('SIGTERM');
                // Grace period then SIGKILL
                setTimeout(() => {
                    if (proc.info.status === 'running') {
                        proc.child.kill('SIGKILL');
                    }
                }, 3000);
            }
        } catch {
            proc.child.kill();
        }

        proc.info.status = 'stopped';
        proc.info.stoppedAt = new Date().toISOString();
        this.outputChannel.appendLine(`ToolHarness: stopped [${terminalId}]`);
        this.onChangeEmitter.fire(this.listProcesses());

        // Clean up the process entry after a short delay
        setTimeout(() => {
            this.processes.delete(terminalId);
            this.onChangeEmitter.fire(this.listProcesses());
        }, 5000);

        return { success: true, message: `Process [${terminalId}] stopped.` };
    }

    // ── get_process_output ───────────────────────────────────────────────────

    /**
     * Get buffered output from a running process.
     * @param lines  Maximum number of recent lines to return (default: 100)
     */
    getProcessOutput(terminalId: string, lines = 100): string {
        const proc = this.processes.get(terminalId);
        if (!proc) return `No process with id "${terminalId}".`;
        const recent = proc.outputLines.slice(-lines);
        return recent.join('\n');
    }

    // ── list_processes ───────────────────────────────────────────────────────

    /** List all managed processes (running and recently stopped). */
    listProcesses(): ProcessInfo[] {
        return [...this.processes.values()].map(p => ({ ...p.info }));
    }

    // ── VS Code terminal integration ──────────────────────────────────────────

    /**
     * Open a VS Code terminal for a long-running command instead of spawning
     * a hidden child process. Use this when the user wants to see the output
     * in the integrated terminal (e.g. npm run dev).
     */
    openTerminal(command: string, cwd?: string, name?: string): vscode.Terminal {
        const terminal = vscode.window.createTerminal({
            name: name ?? command.split(' ')[0],
            cwd: cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
        });
        terminal.show();
        terminal.sendText(command);
        return terminal;
    }

    // ── Quick-run (one-shot) ──────────────────────────────────────────────────

    /**
     * Run a command to completion and return its stdout+stderr.
     * For short-lived commands like tests, linters, build steps.
     * @param timeoutMs  Maximum execution time in ms (default: 30 000)
     */
    runToCompletion(
        command: string,
        cwd?: string,
        timeoutMs = 30_000
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
        return new Promise((resolve) => {
            const resolvedCwd = cwd
                ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
                ?? os.homedir();

            cp.exec(command, { cwd: resolvedCwd, timeout: timeoutMs }, (err, stdout, stderr) => {
                resolve({
                    stdout: stdout ?? '',
                    stderr: stderr ?? '',
                    exitCode: err?.code ?? 0
                });
            });
        });
    }

    dispose(): void {
        // Terminate all running processes on extension deactivation
        for (const [id, proc] of this.processes) {
            if (proc.info.status === 'running') {
                this.stopProcess(id);
            }
        }
        this.onChangeEmitter.dispose();
    }
}
