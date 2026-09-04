import * as vscode from 'vscode';
import { ModelClient } from '../modelClient';
import { SpecsEngine } from '../specs/specsEngine';
import { SteeringLoader } from '../steering/steeringLoader';

/**
 * InlineCompletionProvider — Tab multi-line ghost-text completions.
 *
 * IMPORTANT: Every completion request goes through canGenerateCode() first.
 * If there is no approved spec with an active task for the current file, the
 * provider returns nothing. This is what makes tab completion a "Kiro-style"
 * feature rather than a free code-generation escape hatch.
 *
 * Trigger: the user pauses typing for ~600 ms (VS Code fires inline completion
 * requests automatically). The provider sends the prefix + a small suffix
 * window to the model and streams back a single completion.
 */
export class ForgeInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
    /** Debounce — only call the model if the user hasn't typed for this long (ms). */
    private static readonly DEBOUNCE_MS = 600;
    private lastRequestTime = 0;

    constructor(
        private model: ModelClient,
        private specsEngine: SpecsEngine,
        private steeringLoader: SteeringLoader
    ) {}

    async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionList | undefined> {
        // Simple debounce: if a newer request came in shortly after, skip this one
        const now = Date.now();
        this.lastRequestTime = now;
        await delay(ForgeInlineCompletionProvider.DEBOUNCE_MS);
        if (this.lastRequestTime !== now || token.isCancellationRequested) return undefined;

        // --- Gate check ---
        const specs = await this.specsEngine.listAll();
        const activeSpec = specs.find(s =>
            s.tasksApproved &&
            s.tasks?.some(t => t.status === 'in_progress')
        );
        if (!activeSpec) return undefined; // no approved task in progress — no completions

        const activeTask = activeSpec.tasks?.find(t => t.status === 'in_progress');
        const gate = this.specsEngine.canGenerateCode(activeSpec, activeTask?.id);
        if (!gate.allowed) return undefined;

        if (token.isCancellationRequested) return undefined;

        // --- Build prompt ---
        const cfg = vscode.workspace.getConfiguration('forgeide');
        const steeringDir = cfg.get<string>('steering.directory', '.kiro/steering');
        const relPath = vscode.workspace.asRelativePath(document.uri);
        const steeringCtx = await this.steeringLoader.buildContextBlock(steeringDir, relPath);

        const offset = document.offsetAt(position);
        const fullText = document.getText();
        const prefix = fullText.slice(Math.max(0, offset - 2000), offset);
        const suffix = fullText.slice(offset, Math.min(fullText.length, offset + 400));

        const system = [
            steeringCtx,
            `You are a code completion engine. The user is implementing task: "${activeTask?.title}".`,
            `Task detail: ${activeTask?.detail}`,
            `Current file: ${relPath}`,
            'Output ONLY the completion text to insert at the cursor — no explanation, no markdown fences.',
            'Keep completions focused: 1-15 lines. Match existing indentation and style exactly.'
        ].filter(Boolean).join('\n');

        try {
            const completion = await this.model.complete([
                { role: 'system', content: system },
                {
                    role: 'user',
                    content: `<prefix>${prefix}</prefix><suffix>${suffix}</suffix>\nComplete at cursor:`
                }
            ], { maxTokens: 256 });

            if (!completion.trim() || token.isCancellationRequested) return undefined;

            return {
                items: [
                    new vscode.InlineCompletionItem(
                        completion,
                        new vscode.Range(position, position)
                    )
                ]
            };
        } catch {
            return undefined;
        }
    }

    /** Register this provider for all language IDs. */
    static register(
        context: vscode.ExtensionContext,
        model: ModelClient,
        specsEngine: SpecsEngine,
        steeringLoader: SteeringLoader
    ): vscode.Disposable {
        const provider = new ForgeInlineCompletionProvider(model, specsEngine, steeringLoader);
        return vscode.languages.registerInlineCompletionItemProvider(
            { pattern: '**' }, // all files
            provider
        );
    }
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
