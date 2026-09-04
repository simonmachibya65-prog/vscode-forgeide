import * as vscode from 'vscode';
import * as path from 'path';
import { ModelClient } from '../modelClient';
import { SpecTask, Spec } from './specsEngine';
import { proposeAndApply } from '../diff/diffPreview';
import { fenceUntrustedContent } from '../security/promptGuard';
import { CodebaseIndex } from '../index/codebaseIndex';
import { KiroIgnore } from '../index/kiroignore';
import { rankFilesForTask } from './taskFileRanking';
import { resolveWorkspacePath } from '../security/workspacePath';

interface ProposedFileChange {
    path: string;
    content: string;
}

const IMPLEMENT_SYSTEM_PROMPT = `You are implementing one task from an approved spec.
Given the task, the overall design, and the current content of relevant files, respond
ONLY with JSON: {"files": [{"path": "relative/path.ts", "content": "full new file content"}]}
Write complete file contents, not diffs or snippets. Only include files that actually
need to change for this task. Follow existing code style in the files you're given.`;

/**
 * TaskExecutor — implements one spec task.
 *
 * Auto-file-selection: uses CodebaseIndex to find the top relevant files
 * for each task (based on task title + detail keywords) and reads their
 * current content to send as context. This replaces the empty file list
 * that was previously passed in.
 */
export class TaskExecutor {
    constructor(
        private model: ModelClient,
        private workspaceRoot: vscode.Uri,
        private codebaseIndex?: CodebaseIndex
    ) {}

    async execute(
        spec: Spec,
        task: SpecTask,
        /** Explicit file overrides — if provided, used instead of auto-selection */
        explicitFiles: { path: string; content: string }[] = []
    ) {
        // Auto-select relevant files if none explicitly provided
        const relevantFiles = explicitFiles.length > 0
            ? explicitFiles
            : await this.autoSelectFiles(task);

        const filesContext = relevantFiles
            .map(f => fenceUntrustedContent(f.path, f.content))
            .join('\n\n');

        const raw = await this.model.complete([
            { role: 'system', content: IMPLEMENT_SYSTEM_PROMPT },
            {
                role: 'user',
                content: `Design:\n${spec.design}\n\nTask: ${task.title}\n${task.detail}\n\n` +
                    (filesContext
                        ? `Current relevant files:\n${filesContext}`
                        : '(No existing files found — create new files as needed.)')
            }
        ], { maxTokens: 8192 });

        let files: ProposedFileChange[];
        try {
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed?.files)) throw new Error('missing files array');
            files = parsed.files;
        } catch {
            throw new Error(
                `Model did not return valid JSON for task "${task.id}". Raw output:\n${raw.slice(0, 300)}`
            );
        }

        const outcomes: { path: string; result: 'applied' | 'rejected' | 'unchanged' }[] = [];
        for (const file of files) {
            if (typeof file?.path !== 'string' || typeof file?.content !== 'string') {
                throw new Error(`Model returned an invalid file change for task "${task.id}".`);
            }
            const resolvedPath = resolveWorkspacePath(this.workspaceRoot.fsPath, file.path);
            if (!resolvedPath) {
                throw new Error(`Refusing to write outside the workspace: "${file.path}".`);
            }
            const uri = vscode.Uri.file(path.normalize(resolvedPath));
            const result = await proposeAndApply({
                uri,
                newContent: file.content,
                title: `Task "${task.title}": ${file.path}`
            });
            outcomes.push({ path: file.path, result });
        }

        return outcomes;
    }

    /**
     * Auto-selects up to 8 relevant files for a task using:
     *   1. CodebaseIndex keyword search on task title + detail
     *   2. Reads the actual file content (capped at 6000 chars each)
     *   3. Filters out kiroignored files
     */
    private async autoSelectFiles(
        task: SpecTask
    ): Promise<{ path: string; content: string }[]> {
        if (!this.codebaseIndex) return [];

        const kiroignore = new KiroIgnore(this.workspaceRoot.fsPath);
        await kiroignore.load();

        const query = `${task.title} ${task.detail}`;
        const results = await this.codebaseIndex.search(query, 8);

        const files: { path: string; content: string }[] = [];
        for (const result of results) {
            if (kiroignore.isIgnored(result.relativePath)) continue;
            try {
                const uri = vscode.Uri.joinPath(this.workspaceRoot, result.relativePath);
                const bytes = await vscode.workspace.fs.readFile(uri);
                const content = Buffer.from(bytes).toString('utf8').slice(0, 6000);
                files.push({ path: result.relativePath, content });
            } catch {
                // File may have been deleted or is binary — skip
            }
        }

        if (files.length === 0) {
            const fallbackFiles = await this.listWorkspaceFiles();
            const ranked = rankFilesForTask(task, fallbackFiles).slice(0, 5);
            return ranked
                .map(entry => ({
                    path: entry.path,
                    content: fallbackFiles.find(file => file.path === entry.path)?.content ?? ''
                }))
                .filter(file => file.content.length > 0);
        }

        return rankFilesForTask(task, files)
            .slice(0, 5)
            .map(entry => ({
                path: entry.path,
                content: files.find(file => file.path === entry.path)?.content ?? ''
            }))
            .filter(file => file.content.length > 0);
    }

    private async listWorkspaceFiles(): Promise<Array<{ path: string; content: string }>> {
        const files: Array<{ path: string; content: string }> = [];
        const root = this.workspaceRoot.fsPath;

        try {
            const entries = await vscode.workspace.findFiles('**/*.{ts,tsx,js,jsx,py,go,java,cs,rs,rb,php,swift,kt,cpp,c,h}', '**/node_modules/**');
            for (const file of entries.slice(0, 100)) {
                try {
                    const relativePath = vscode.workspace.asRelativePath(file);
                    if (relativePath.startsWith('.kiro/') || relativePath.includes('node_modules')) continue;
                    const bytes = await vscode.workspace.fs.readFile(file);
                    const content = Buffer.from(bytes).toString('utf8').slice(0, 4000);
                    files.push({ path: relativePath, content });
                } catch {
                    // ignore unreadable files
                }
            }
        } catch {
            // ignore and return empty list
        }

        return files;
    }
}
