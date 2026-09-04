import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import { ModelClient } from '../modelClient';
import { proposeAndApply } from '../diff/diffPreview';
import { fenceUntrustedContent } from '../security/promptGuard';
import { WorkspaceResolver } from '../util/workspaceResolver';
import {
    HookDefinition as DaemonHookDefinition,
    HookAction,
    RiskClass
} from '../daemon/types';

/**
 * HookTrigger maps the daemon's HookDefinition.trigger values plus
 * VS Code file-watcher shortcuts used in the UI.
 */
export type HookTrigger =
    | 'save'        // alias for file.save
    | 'create'
    | 'delete'
    | 'manual'
    | 'preCommit'
    | 'onCommit'    // alias for git.commit
    | 'onPrOpen'    // alias for pr.opened
    | 'file.save'
    | 'git.commit'
    | 'pr.opened'
    | 'branch.create'
    | 'schedule';

/**
 * HookDefinition — extends the canonical daemon HookDefinition with
 * VS Code-specific fields (glob for file watchers, action string for
 * legacy AI-edit mode, enabled toggle).
 *
 * The `actions` array from daemon/types is the authoritative source for
 * multi-action hooks. The legacy `action` string field is kept for
 * backward compat with existing .kiro/hooks/*.json files.
 */
export interface HookDefinition extends Omit<DaemonHookDefinition, 'trigger'> {
    trigger: HookTrigger; // broader union than daemon type
    on: HookTrigger;      // alias kept for UI compat
    glob: string;
    /** Legacy single-action string (AI edit instruction or shell: prefix) */
    action: string;
    enabled: boolean;
    /** Declared risk class of this hook — re-verified by RiskPolicy at execution */
    riskClass?: RiskClass;
}

function isShellAction(action: string): boolean {
    return action.trimStart().startsWith('shell:');
}

function shellCommand(action: string): string {
    return action.trimStart().slice('shell:'.length).trim();
}

export class HooksEngine implements vscode.Disposable {
    private watchers: vscode.FileSystemWatcher[] = [];
    private hooks: HookDefinition[] = [];
    private onChangeEmitter = new vscode.EventEmitter<HookDefinition[]>();
    onHooksChanged = this.onChangeEmitter.event;

    constructor(
        private model: ModelClient,
        private outputChannel: vscode.OutputChannel
    ) {}

    getHooks(): HookDefinition[] {
        return this.hooks;
    }

    async loadFromWorkspace(hooksDirRelative: string) {
        this.disposeWatchers();
        const folder = WorkspaceResolver.active();
        if (!folder) return;

        const hooksDirUri = vscode.Uri.joinPath(folder.uri, hooksDirRelative);
        let entries: [string, vscode.FileType][] = [];
        try {
            entries = await vscode.workspace.fs.readDirectory(hooksDirUri);
        } catch {
            this.hooks = [];
            this.onChangeEmitter.fire(this.hooks);
            return;
        }

        this.hooks = [];
        for (const [name, type] of entries) {
            if (type !== vscode.FileType.File || !name.endsWith('.json')) continue;
            const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(hooksDirUri, name));
            try {
                const def: HookDefinition = JSON.parse(Buffer.from(bytes).toString('utf8'));
                this.hooks.push(def);
            } catch (e) {
                this.outputChannel.appendLine(`Failed to parse hook ${name}: ${e}`);
            }
        }

        for (const hook of this.hooks) {
            if (!hook.enabled || hook.on === 'manual' || hook.on === 'preCommit' ||
                hook.on === 'onCommit' || hook.on === 'onPrOpen') continue;
            const pattern = new vscode.RelativePattern(folder, hook.glob);
            const watcher = vscode.workspace.createFileSystemWatcher(pattern);
            if (hook.on === 'save') watcher.onDidChange(uri => this.run(hook, uri));
            if (hook.on === 'create') watcher.onDidCreate(uri => this.run(hook, uri));
            if (hook.on === 'delete') watcher.onDidDelete(uri => this.run(hook, uri));
            this.watchers.push(watcher);
        }

        this.outputChannel.appendLine(
            `Loaded ${this.hooks.length} hook(s), ${this.watchers.length} file watcher(s) active.`
        );
        this.onChangeEmitter.fire(this.hooks);
    }

    async toggle(hookId: string, hooksDirRelative: string) {
        const folder = WorkspaceResolver.active();
        if (!folder) return;
        const hook = this.hooks.find(h => h.id === hookId);
        if (!hook) return;
        hook.enabled = !hook.enabled;
        const uri = vscode.Uri.joinPath(folder.uri, hooksDirRelative, `${hookId}.json`);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(hook, null, 2)));
        await this.loadFromWorkspace(hooksDirRelative);
    }

    /** Fire all hooks matching a named trigger (used for onCommit, onPrOpen, manual). */
    async fireTrigger(trigger: HookTrigger): Promise<void> {
        const folder = WorkspaceResolver.active();
        if (!folder) return;
        const matching = this.hooks.filter(h => h.enabled && h.on === trigger);
        for (const hook of matching) {
            const files = await vscode.workspace.findFiles(
                new vscode.RelativePattern(folder, hook.glob), '**/node_modules/**'
            );
            for (const uri of files) {
                await this.run(hook, uri);
            }
        }
    }

    async runPreCommitHooks(): Promise<{ id: string; outcomes: string[] }[]> {
        const folder = WorkspaceResolver.active();
        if (!folder) return [];
        const results: { id: string; outcomes: string[] }[] = [];
        for (const hook of this.hooks.filter(h => h.enabled && h.on === 'preCommit')) {
            const matches = await vscode.workspace.findFiles(
                new vscode.RelativePattern(folder, hook.glob), '**/node_modules/**'
            );
            const outcomes: string[] = [];
            for (const uri of matches) {
                const result = await this.run(hook, uri);
                outcomes.push(`${vscode.workspace.asRelativePath(uri)}: ${result}`);
            }
            results.push({ id: hook.id, outcomes });
        }
        return results;
    }

    private async run(
        hook: HookDefinition,
        uri: vscode.Uri
    ): Promise<'applied' | 'rejected' | 'unchanged' | 'skipped' | 'shell-ok' | 'shell-error'> {
        this.outputChannel.appendLine(`Hook "${hook.id}" triggered by ${uri.fsPath}`);

        const proceed = await vscode.window.showInformationMessage(
            `Hook "${hook.action}" wants to run on ${path.basename(uri.fsPath)}. Proceed?`,
            'Run', 'Skip'
        );
        if (proceed !== 'Run') return 'skipped';

        // --- Shell-command mode ---
        if (isShellAction(hook.action)) {
            const cmd = shellCommand(hook.action);
            return new Promise(resolve => {
                const cwd = WorkspaceResolver.root() || process.cwd();
                cp.exec(cmd, { cwd }, (err, stdout, stderr) => {
                    if (err) {
                        this.outputChannel.appendLine(`Hook "${hook.id}" shell error: ${err.message}\n${stderr}`);
                        vscode.window.showErrorMessage(`Hook "${hook.id}" failed: ${err.message}`);
                        resolve('shell-error');
                    } else {
                        this.outputChannel.appendLine(`Hook "${hook.id}" shell OK:\n${stdout || stderr}`);
                        resolve('shell-ok');
                    }
                });
            });
        }

        // --- AI-edit mode ---
        let fileContent = '';
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            fileContent = Buffer.from(bytes).toString('utf8');
        } catch {
            // file may have been deleted; proceed with empty content
        }

        const result = await this.model.complete([
            {
                role: 'system',
                content: `You are executing an automated development hook. Instruction: ${hook.action}\n` +
                    `Respond with the exact new full file content to write, and nothing else, if a change ` +
                    `is warranted. If no change is needed, respond with exactly: NO_CHANGE`
            },
            {
                role: 'user',
                content: `File: ${uri.fsPath}\n\n${fenceUntrustedContent(uri.fsPath, fileContent)}`
            }
        ]);

        if (result.trim() === 'NO_CHANGE') {
            this.outputChannel.appendLine(`Hook "${hook.id}": no change needed.`);
            return 'unchanged';
        }

        const outcome = await proposeAndApply({
            uri,
            newContent: result,
            title: `Hook "${hook.id}"`
        });
        this.outputChannel.appendLine(`Hook "${hook.id}": ${outcome}.`);
        return outcome;
    }

    private disposeWatchers() {
        this.watchers.forEach(w => w.dispose());
        this.watchers = [];
    }

    dispose() {
        this.disposeWatchers();
    }
}

