import * as vscode from 'vscode';
import * as path from 'path';

/**
 * WorkspaceResolver — single place that resolves "which workspace folder"
 * for every subsystem. Replaces all hardcoded workspaceFolders[0] references.
 *
 * Multi-root strategy:
 *   - If there is only one folder, use it.
 *   - If there are multiple folders, pick the one that contains the currently
 *     active editor file (if any).
 *   - If no editor is open, default to the first folder.
 *   - Commands that need a specific folder can call pickFolder() to show
 *     a QuickPick.
 */
export class WorkspaceResolver {

    /** Returns the "active" workspace folder — the one containing the current editor. */
    static active(): vscode.WorkspaceFolder | undefined {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders?.length) return undefined;
        if (folders.length === 1) return folders[0];

        // Try to match against the active editor
        const activeUri = vscode.window.activeTextEditor?.document.uri;
        if (activeUri) {
            const match = vscode.workspace.getWorkspaceFolder(activeUri);
            if (match) return match;
        }
        return folders[0];
    }

    /** Returns the fsPath of the active workspace folder, or '' if none. */
    static root(): string {
        return this.active()?.uri.fsPath ?? '';
    }

    /** Resolves a workspace-relative config path against the active folder. */
    static resolve(relativePath: string): string {
        return path.join(this.root(), relativePath);
    }

    /** Resolves a Uri from a workspace-relative path against the active folder. */
    static uri(relativePath: string): vscode.Uri | undefined {
        const folder = this.active();
        if (!folder) return undefined;
        return vscode.Uri.joinPath(folder.uri, relativePath);
    }

    /** All open workspace folders. */
    static all(): readonly vscode.WorkspaceFolder[] {
        return vscode.workspace.workspaceFolders ?? [];
    }

    /**
     * Returns the workspace folder that contains the given Uri, or the
     * active folder if the Uri isn't inside any folder.
     */
    static forUri(uri: vscode.Uri): vscode.WorkspaceFolder | undefined {
        return vscode.workspace.getWorkspaceFolder(uri) ?? this.active();
    }

    /**
     * Shows a QuickPick if multiple folders are open. Returns the chosen
     * folder, or the only folder if there's just one.
     */
    static async pickFolder(placeHolder = 'Select workspace folder'): Promise<vscode.WorkspaceFolder | undefined> {
        const folders = vscode.workspace.workspaceFolders ?? [];
        if (folders.length === 0) return undefined;
        if (folders.length === 1) return folders[0];

        const pick = await vscode.window.showQuickPick(
            folders.map(f => ({ label: f.name, description: f.uri.fsPath, folder: f })),
            { placeHolder }
        );
        return pick?.folder;
    }

    /**
     * Runs a callback for every open workspace folder. Useful for hooks
     * and index operations that should cover the full multi-root workspace.
     */
    static async forEachFolder<T>(
        fn: (folder: vscode.WorkspaceFolder) => Promise<T>
    ): Promise<T[]> {
        const results: T[] = [];
        for (const folder of this.all()) {
            results.push(await fn(folder));
        }
        return results;
    }

    /**
     * Returns a RelativePattern that covers all workspace folders when doing
     * file watchers / findFiles across a multi-root workspace.
     */
    static globPattern(glob: string): vscode.GlobPattern {
        const folders = this.all();
        if (folders.length === 1) {
            return new vscode.RelativePattern(folders[0], glob);
        }
        // For multi-root, return a workspace-wide pattern
        return glob;
    }
}
