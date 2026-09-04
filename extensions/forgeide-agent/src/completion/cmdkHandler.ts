import * as vscode from 'vscode';
import { ModelClient } from '../modelClient';
import { SpecsEngine } from '../specs/specsEngine';
import { SteeringLoader } from '../steering/steeringLoader';
import { proposeAndApply } from '../diff/diffPreview';
import { AutopilotManager } from '../agents/autopilot';
import { CheckpointManager } from '../agents/checkpointManager';

/**
 * CmdK handler — fast, scoped inline edit (Cursor-style Cmd-K).
 *
 * Opens an input box, takes the user's instruction, sends it to the model
 * with the selected text (or full file if no selection) as context, then
 * routes the result through diff-preview-and-approve (supervised) or writes
 * directly (autopilot). Either way, a checkpoint is created first.
 *
 * GATE: only fires if there is an active approved spec task. This ensures
 * inline edits stay within the spec-driven workflow.
 */
export class CmdKHandler {
    constructor(
        private model: ModelClient,
        private specsEngine: SpecsEngine,
        private steeringLoader: SteeringLoader,
        private autopilot: AutopilotManager,
        private checkpoints: CheckpointManager
    ) {}

    async execute(quick = false): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('ForgeIDE: open a file to use Cmd-K inline edit.');
            return;
        }

        // --- Gate check ---
        const specs = await this.specsEngine.listAll();
        const activeSpec = specs.find(s =>
            s.tasksApproved && s.tasks?.some(t => t.status === 'in_progress')
        );
        if (!quick && !activeSpec) {
            vscode.window.showWarningMessage(
                'ForgeIDE: no approved spec task is in progress. ' +
                'Approve a spec and mark a task in-progress before using Cmd-K.'
            );
            return;
        }
        const activeTask = activeSpec?.tasks?.find(t => t.status === 'in_progress');
        const gate = activeSpec && activeTask
            ? this.specsEngine.canGenerateCode(activeSpec, activeTask.id)
            : { allowed: quick, reason: 'Quick Edit is enabled.' };
        if (!quick && !gate.allowed) {
            vscode.window.showErrorMessage(`ForgeIDE: blocked — ${gate.reason}`);
            return;
        }

        // --- Get instruction ---
        const instruction = await vscode.window.showInputBox({
            prompt: `${quick ? 'Quick Edit' : 'Cmd-K'}: describe the edit${activeTask ? ` for "${activeTask.title}"` : ''}`,
            placeHolder: 'Extract this logic into a separate function',
            ignoreFocusOut: true
        });
        if (!instruction) return;

        const document = editor.document;
        const selection = editor.selection;
        const hasSelection = !selection.isEmpty;
        const selectedText = hasSelection
            ? document.getText(selection)
            : document.getText();
        const relPath = vscode.workspace.asRelativePath(document.uri);

        const cfg = vscode.workspace.getConfiguration('forgeide');
        const steeringDir = cfg.get<string>('steering.directory', '.kiro/steering');
        const steeringCtx = await this.steeringLoader.buildContextBlock(steeringDir, relPath);

        const system = [
            steeringCtx,
            `You are making a scoped inline edit to a file${activeTask ? ` as part of task: "${activeTask.title}"` : ''}.`,
            'Respond with ONLY the new content for the selected region (or full file if no selection).',
            'Match existing code style exactly. No explanation, no markdown fences.'
        ].filter(Boolean).join('\n');

        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'ForgeIDE: applying Cmd-K edit...' },
            async () => {
                try {
                    const newContent = await this.model.complete([
                        { role: 'system', content: system },
                        {
                            role: 'user',
                            content: `File: ${relPath}\nInstruction: ${instruction}\n\n` +
                                (hasSelection ? `Selection:\n${selectedText}` : `Full file:\n${selectedText}`)
                        }
                    ], { maxTokens: 4096 });

                    if (!newContent.trim()) return;

                    if (hasSelection) {
                        // Replace only the selection — build the full file content first
                        const fullText = document.getText();
                        const beforeSel = fullText.slice(0, document.offsetAt(selection.start));
                        const afterSel = fullText.slice(document.offsetAt(selection.end));
                        const fullNewContent = beforeSel + newContent + afterSel;

                        await this.checkpoints.create(`cmd-k: ${instruction.slice(0, 40)}`);

                        if (!quick && this.autopilot.isAutopilot()) {
                            await vscode.workspace.fs.writeFile(
                                document.uri,
                                Buffer.from(fullNewContent, 'utf8')
                            );
                        } else {
                            await proposeAndApply({
                                uri: document.uri,
                                newContent: fullNewContent,
                                title: `Cmd-K: ${instruction}`
                            });
                        }
                    } else {
                        await this.checkpoints.create(`cmd-k: ${instruction.slice(0, 40)}`);

                        if (!quick && this.autopilot.isAutopilot()) {
                            await vscode.workspace.fs.writeFile(
                                document.uri,
                                Buffer.from(newContent, 'utf8')
                            );
                        } else {
                            await proposeAndApply({
                                uri: document.uri,
                                newContent,
                                title: `Cmd-K: ${instruction}`
                            });
                        }
                    }
                } catch (e) {
                    vscode.window.showErrorMessage(`Cmd-K failed: ${e}`);
                }
            }
        );
    }

    registerCommand(): vscode.Disposable {
        return vscode.commands.registerCommand('forgeide.cmdK', () => this.execute());
    }

    registerQuickCommand(): vscode.Disposable {
        return vscode.commands.registerCommand('forgeide.quickEdit', () => this.execute(true));
    }
}
