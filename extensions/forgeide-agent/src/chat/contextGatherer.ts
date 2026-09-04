import * as vscode from 'vscode';
import { fenceUntrustedContent } from '../security/promptGuard';
import { formatSearchResultText, WorkspaceSearchHit } from './searchResultFormatter';

export interface GatheredContext {
    activeFileRelativePath?: string;
    activeFileSummary?: string;
    diagnosticsSummary?: string;
}

/**
 * Pulls lightweight, always-useful context from the editor: what file is
 * open, what's selected (or a truncated view of the file if nothing's
 * selected), and any diagnostics (errors/warnings) on it. Kept intentionally
 * small -- this rides along on every chat turn, so it shouldn't balloon
 * token usage the way dumping whole files would.
 */
export async function gatherEditorContext(): Promise<GatheredContext> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return {};

    const relPath = vscode.workspace.asRelativePath(editor.document.uri);
    const selection = editor.selection;
    const hasSelection = !selection.isEmpty;

    const text = hasSelection
        ? editor.document.getText(selection)
        : editor.document.getText().slice(0, 4000); // cap unselected full-file dumps

    const diagnostics = vscode.languages.getDiagnostics(editor.document.uri);
    const diagnosticsSummary = diagnostics.length
        ? diagnostics
            .slice(0, 10)
            .map(d => `Line ${d.range.start.line + 1}: [${vscode.DiagnosticSeverity[d.severity]}] ${d.message}`)
            .join('\n')
        : undefined;

    return {
        activeFileRelativePath: relPath,
        activeFileSummary: fenceUntrustedContent(
            relPath + (hasSelection ? ' (selection)' : ' (truncated to 4000 chars)'),
            text
        ),
        diagnosticsSummary
    };
}

/**
 * Simple workspace text search the model can request via the "search" tool
 * (see chatParticipant.ts's tool loop). Wraps vscode.workspace.findFiles +
 * a basic per-file text scan rather than shelling out to ripgrep directly,
 * so it works the same on every platform without a bundled binary.
 */
export async function searchWorkspaceMatches(query: string, maxResults = 20): Promise<WorkspaceSearchHit[]> {
    const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 500);
    const hits: WorkspaceSearchHit[] = [];

    for (const file of files) {
        if (hits.length >= maxResults) break;
        let text: string;
        try {
            text = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');
        } catch {
            continue;
        }
        const idx = text.indexOf(query);
        if (idx === -1) continue;
        const lineNumber = text.slice(0, idx).split('\n').length;
        const snippet = text.slice(Math.max(0, idx - 40), idx + query.length + 40).replace(/\n/g, ' ');
        hits.push({
            path: vscode.workspace.asRelativePath(file),
            line: lineNumber,
            snippet
        });
    }

    return hits;
}

export async function searchWorkspace(query: string, maxResults = 20): Promise<string> {
    const hits = await searchWorkspaceMatches(query, maxResults);
    const formatted = formatSearchResultText(query, hits);
    return hits.length ? fenceUntrustedContent(`workspace search: "${query}"`, formatted) : formatted;
}
