import * as vscode from 'vscode';
import * as path from 'path';

/**
 * KiroIgnore — reads .kiroignore in the workspace root and provides
 * isIgnored() to exclude paths from the codebase index, steering loader,
 * and skill loader.
 *
 * Syntax: same as .gitignore (lines starting with # are comments,
 * blank lines are skipped, leading / anchors to root, ** glob supported).
 */
export class KiroIgnore {
    private patterns: string[] = [];
    private loaded = false;

    constructor(private workspaceRoot: string) {}

    async load(): Promise<void> {
        if (this.loaded) return;
        this.loaded = true;
        try {
            const uri = vscode.Uri.file(path.join(this.workspaceRoot, '.kiroignore'));
            const bytes = await vscode.workspace.fs.readFile(uri);
            this.patterns = Buffer.from(bytes)
                .toString('utf8')
                .split('\n')
                .map(l => l.trim())
                .filter(l => l && !l.startsWith('#'));
        } catch {
            // No .kiroignore — nothing to ignore
        }
    }

    /**
     * Returns true if the given workspace-relative path should be excluded.
     */
    isIgnored(relativePath: string): boolean {
        const normalized = relativePath.replace(/\\/g, '/');
        return this.patterns.some(pattern => matchPattern(pattern, normalized));
    }

    getPatterns(): string[] { return [...this.patterns]; }
}

/**
 * Simple .gitignore-style pattern matcher.
 * Handles: exact, prefix double-star, *.ext, double-star/dir, negation (!pattern).
 */
function matchPattern(pattern: string, filePath: string): boolean {
    // Negation — caller should handle ordering; here we just return false for negated
    if (pattern.startsWith('!')) return false;

    // Convert glob to regex
    let p = pattern
        .replace(/\./g, '\\.')
        .replace(/\*\*\//g, '(?:.+/)?')
        .replace(/\*\*/g, '.*')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]');

    // Anchor to start if no leading /
    if (!pattern.startsWith('/')) p = `(?:^|/)${p}`;
    else p = `^${p.slice(1)}`;

    // Match directories (pattern ending without / matches both files and dirs)
    if (!pattern.endsWith('/')) p = `${p}(?:/.*)?$`;

    try {
        return new RegExp(p).test(filePath);
    } catch {
        return false;
    }
}
