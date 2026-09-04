import * as vscode from 'vscode';
import { StreamHandle } from '../modelClient';

/**
 * ReasoningPanel — streams agent reasoning steps live into a VS Code output
 * channel and optionally into a dedicated webview panel, giving users full
 * visibility into what the agent is doing before the final diff appears.
 *
 * Usage:
 *   const panel = new ReasoningPanel(context);
 *   panel.start('Implementing task: Add login form');
 *   panel.append('Reading src/auth/login.ts...');
 *   // wire a StreamHandle so tokens appear as they arrive:
 *   panel.streamFrom(handle);
 *   await handle.result();
 *   panel.finish();
 */
export class ReasoningPanel implements vscode.Disposable {
    private outputChannel: vscode.OutputChannel;
    private webviewPanel: vscode.WebviewPanel | undefined;
    private buffer: string[] = [];

    constructor(private context: vscode.ExtensionContext) {
        this.outputChannel = vscode.window.createOutputChannel('ForgeIDE — Agent Reasoning');
    }

    /** Open the reasoning panel (output channel + optional webview). */
    start(title: string, showWebview = false): void {
        this.buffer = [];
        this.outputChannel.clear();
        this.outputChannel.appendLine(`▶ ${title}`);
        this.outputChannel.appendLine('─'.repeat(60));
        this.outputChannel.show(true);

        if (showWebview) {
            this.ensureWebview(title);
            this.updateWebview();
        }
    }

    /** Append a reasoning step. Call this for discrete steps (file reads, searches, decisions). */
    append(text: string): void {
        this.buffer.push(text);
        this.outputChannel.appendLine(text);
        if (this.webviewPanel) this.updateWebview();
    }

    /**
     * Wire a StreamHandle so every token from the model appears in the panel
     * as it arrives — gives the "thinking live" effect.
     */
    streamFrom(handle: StreamHandle): void {
        let lineBuffer = '';
        handle.onToken(token => {
            lineBuffer += token;
            // Flush complete lines to output channel
            const lines = lineBuffer.split('\n');
            lineBuffer = lines.pop() ?? '';
            for (const line of lines) {
                this.outputChannel.appendLine(line);
                this.buffer.push(line);
            }
        });
    }

    /** Mark reasoning complete. */
    finish(summary?: string): void {
        this.outputChannel.appendLine('─'.repeat(60));
        if (summary) this.outputChannel.appendLine(`✓ ${summary}`);
        if (this.webviewPanel) this.updateWebview();
    }

    private ensureWebview(title: string): void {
        if (this.webviewPanel) {
            this.webviewPanel.title = title;
            this.webviewPanel.reveal(vscode.ViewColumn.Beside, true);
            return;
        }
        this.webviewPanel = vscode.window.createWebviewPanel(
            'forgeide.reasoning',
            title,
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            { enableScripts: false, retainContextWhenHidden: true }
        );
        this.webviewPanel.onDidDispose(() => { this.webviewPanel = undefined; });
        this.context.subscriptions.push(this.webviewPanel);
    }

    private updateWebview(): void {
        if (!this.webviewPanel) return;
        const lines = this.buffer
            .map(l => `<div class="line">${escapeHtml(l)}</div>`)
            .join('');
        this.webviewPanel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  body { font-family: var(--vscode-editor-font-family, monospace);
         font-size: 13px; background: var(--vscode-editor-background);
         color: var(--vscode-editor-foreground); padding: 16px; margin: 0; }
  .line { padding: 1px 0; white-space: pre-wrap; word-break: break-all; }
  .line:last-child { color: var(--vscode-terminal-ansiBrightGreen); }
</style>
</head>
<body>${lines}
<script>window.scrollTo(0, document.body.scrollHeight);</script>
</body></html>`;
    }

    dispose(): void {
        this.outputChannel.dispose();
        this.webviewPanel?.dispose();
    }
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
