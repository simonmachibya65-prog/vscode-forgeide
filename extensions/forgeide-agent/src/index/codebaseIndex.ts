import * as vscode from 'vscode';
import * as path from 'path';
import { KiroIgnore } from './kiroignore';
import { extractSymbolsFromText } from './workspaceSymbols';

export interface IndexEntry {
    relativePath: string;
    symbols: string[];   // function/class names extracted by simple regex
    lines: number;
    lastIndexed: number; // Date.now()
}

export interface SearchResult {
    relativePath: string;
    snippet: string;
    score: number;
}

/**
 * CodebaseIndex — a lightweight workspace index shared by chat, tab completion,
 * Cmd-K, and spec context gathering.
 *
 * Full embedding-based semantic search requires a hosted vector store and an
 * embeddings API — that's a backend service, not an extension feature. This
 * implementation provides:
 *
 *   1. Symbol index: scans all source files and extracts exported symbols so
 *      the model knows what exists without reading every file.
 *   2. Text search: fast keyword search across the index with basic TF-style
 *      scoring, used as the retrieval layer until real embeddings are wired.
 *   3. Seam for embeddings: getEmbeddingContext() is the method to replace
 *      once you have an embeddings endpoint — everything above it stays the same.
 *
 * The index is built lazily on first use and updated when files change.
 */
export class CodebaseIndex implements vscode.Disposable {
    private entries = new Map<string, IndexEntry>();
    private watcher: vscode.FileSystemWatcher | undefined;
    private indexing = false;
    private onChangeEmitter = new vscode.EventEmitter<void>();
    onIndexUpdated = this.onChangeEmitter.event;

    private static readonly SYMBOL_RE =
        /(?:export\s+)?(?:function|class|const|let|var|interface|type|enum)\s+(\w+)/g;
    private static readonly EXCLUDED = ['**/node_modules/**', '**/.git/**', '**/out/**', '**/*.map'];

    async buildIndex(): Promise<void> {
        if (this.indexing) return;
        this.indexing = true;
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const kiroignore = new KiroIgnore(workspaceRoot);
        await kiroignore.load();

        const files = await vscode.workspace.findFiles(
            '**/*.{ts,tsx,js,jsx,py,go,java,cs,rs,rb,php,swift,kt,cpp,c,h}',
            `{${CodebaseIndex.EXCLUDED.join(',')}}`
        );

        for (const file of files) {
            const rel = vscode.workspace.asRelativePath(file);
            if (kiroignore.isIgnored(rel)) continue;
            await this.indexFile(file);
        }

        this.indexing = false;
        this.onChangeEmitter.fire();
    }

    watchWorkspace(): void {
        this.watcher?.dispose();
        this.watcher = vscode.workspace.createFileSystemWatcher('**/*');
        this.watcher.onDidChange(uri => this.indexFile(uri).then(() => this.onChangeEmitter.fire()));
        this.watcher.onDidCreate(uri => this.indexFile(uri).then(() => this.onChangeEmitter.fire()));
        this.watcher.onDidDelete(uri => {
            const rel = vscode.workspace.asRelativePath(uri);
            this.entries.delete(rel);
            this.onChangeEmitter.fire();
        });
    }

    private async indexFile(uri: vscode.Uri): Promise<void> {
        // Skip binary / excluded files
        const rel = vscode.workspace.asRelativePath(uri);
        if (CodebaseIndex.EXCLUDED.some(p => rel.includes('node_modules') || rel.endsWith('.map'))) return;

        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            const text = Buffer.from(bytes).toString('utf8');
            if (text.length > 200_000) return; // skip very large files

            const symbols = extractSymbolsFromText(text);

            this.entries.set(rel, {
                relativePath: rel,
                symbols: [...new Set(symbols)],
                lines: text.split('\n').length,
                lastIndexed: Date.now()
            });
        } catch {
            // Binary or unreadable file — skip silently
        }
    }

    /**
     * Keyword search across indexed files. Returns up to `limit` results
     * ranked by simple term-frequency scoring.
     */
    async search(query: string, limit = 10): Promise<SearchResult[]> {
        const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
        const results: SearchResult[] = [];

        for (const [, entry] of this.entries) {
            const symbolText = entry.symbols.join(' ').toLowerCase();
            const score = terms.reduce((acc, term) => {
                const count = (symbolText.match(new RegExp(term, 'g')) ?? []).length;
                return acc + count;
            }, 0);
            if (score > 0) {
                results.push({
                    relativePath: entry.relativePath,
                    snippet: entry.symbols.slice(0, 8).join(', '),
                    score
                });
            }
        }

        return results.sort((a, b) => b.score - a.score).slice(0, limit);
    }

    async findSymbols(query: string, limit = 20): Promise<Array<{ path: string; symbol: string; score: number }>> {
        const matches: Array<{ path: string; symbol: string; score: number }> = [];
        const normalizedQuery = query.toLowerCase();

        for (const [, entry] of this.entries) {
            for (const symbol of entry.symbols) {
                const symbolLower = symbol.toLowerCase();
                const score = symbolLower.includes(normalizedQuery) ? 3 : 0;
                if (score > 0) {
                    matches.push({ path: entry.relativePath, symbol, score });
                }
            }
        }

        return matches
            .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.symbol.localeCompare(b.symbol))
            .slice(0, limit);
    }

    /**
     * Returns a compact context block for the model: top-N most relevant files
     * based on keyword search + symbol summary. This is the seam to replace with
     * real embedding retrieval once you have an embeddings endpoint.
     */
    async getEmbeddingContext(query: string, maxFiles = 5): Promise<string> {
        const results = await this.search(query, maxFiles);
        if (!results.length) return '';
        const lines = results.map(r =>
            `${r.relativePath} (${r.snippet || 'no symbols'})`
        );
        return `## Relevant files (codebase index)\n${lines.join('\n')}`;
    }

    /** Summary of the whole index — used in spec design context gathering. */
    getSummary(): string {
        const total = this.entries.size;
        const totalSymbols = [...this.entries.values()]
            .reduce((acc, e) => acc + e.symbols.length, 0);
        return `${total} files indexed, ${totalSymbols} symbols found.`;
    }

    getEntries(): IndexEntry[] {
        return [...this.entries.values()];
    }

    dispose(): void {
        this.watcher?.dispose();
    }
}
