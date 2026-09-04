import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as util from 'util';
import { ModelClient } from '../modelClient';
import { SteeringLoader } from '../steering/steeringLoader';

const exec = util.promisify(cp.exec);

const COMMIT_SYSTEM_PROMPT = `You are a Git commit message writer. Given a diff of staged changes,
write a concise, conventional-commits-style message:
  <type>(<scope>): <subject>

  [optional body — only if changes need explanation]
  [optional footer — breaking changes, issue refs]

Rules:
- type: feat | fix | refactor | docs | test | chore | perf | ci | build
- subject: imperative mood, ≤72 chars, no period at end
- body: wrapped at 72 chars, explains WHY not WHAT
- Respond with ONLY the commit message — no explanation, no markdown fences.`;

/**
 * CommitMessageProvider — integrates with VS Code's SCM API to provide
 * AI-generated commit messages based on staged changes.
 *
 * Usage:
 *   - The "ForgeIDE: Generate Commit Message" command fills the SCM input box.
 *   - Hooks can also call generateForStagedChanges() before a commit.
 */
export class CommitMessageProvider implements vscode.Disposable {
    private outputChannel: vscode.OutputChannel;

    constructor(
        private model: ModelClient,
        private steeringLoader: SteeringLoader
    ) {
        this.outputChannel = vscode.window.createOutputChannel('ForgeIDE — Commit Messages');
    }

    /** Generate a commit message and fill the SCM input box. */
    async generateAndFill(): Promise<void> {
        const diff = await this.getStagedDiff();
        if (!diff) {
            vscode.window.showInformationMessage(
                'ForgeIDE: No staged changes found. Stage some files first.'
            );
            return;
        }

        const message = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'ForgeIDE: generating commit message...' },
            () => this.generate(diff)
        );

        // Fill the SCM input box (works with Git extension and any SCM provider)
        const scmInput = this.getScmInputBox();
        if (scmInput) {
            scmInput.value = message;
            vscode.window.showInformationMessage('ForgeIDE: Commit message generated.');
        } else {
            // Fallback: open a document so the user can copy it
            const doc = await vscode.workspace.openTextDocument({
                content: message,
                language: 'plaintext'
            });
            await vscode.window.showTextDocument(doc);
        }

        this.outputChannel.appendLine(`Generated commit message:\n${message}`);
    }

    /** Generate a commit message string from staged diff. */
    async generateForStagedChanges(): Promise<string | undefined> {
        const diff = await this.getStagedDiff();
        if (!diff) return undefined;
        return this.generate(diff);
    }

    private async generate(diff: string): Promise<string> {
        const cfg = vscode.workspace.getConfiguration('forgeide');
        const steeringDir = cfg.get<string>('steering.directory', '.kiro/steering');
        const steeringCtx = await this.steeringLoader.buildContextBlock(steeringDir);

        const system = steeringCtx
            ? `${COMMIT_SYSTEM_PROMPT}\n\nAdditional project conventions:\n${steeringCtx}`
            : COMMIT_SYSTEM_PROMPT;

        // Cap diff at 12 000 chars to stay within token budget
        const cappedDiff = diff.length > 12_000
            ? diff.slice(0, 12_000) + '\n\n[diff truncated — too large to show in full]'
            : diff;

        return this.model.complete([
            { role: 'system', content: system },
            { role: 'user',   content: `Staged diff:\n\`\`\`diff\n${cappedDiff}\n\`\`\`` }
        ], { maxTokens: 512 });
    }

    private async getStagedDiff(): Promise<string | undefined> {
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!cwd) return undefined;
        try {
            const { stdout } = await exec('git diff --cached', { cwd });
            return stdout.trim() || undefined;
        } catch {
            return undefined;
        }
    }

    private getScmInputBox(): vscode.SourceControlInputBox | undefined {
        // VS Code exposes git.scm via the Git extension API
        const gitExt = vscode.extensions.getExtension<any>('vscode.git');
        if (!gitExt?.isActive) return undefined;
        const api = gitExt.exports?.getAPI?.(1);
        const repo = api?.repositories?.[0];
        return repo?.inputBox;
    }

    dispose(): void {
        this.outputChannel.dispose();
    }
}
