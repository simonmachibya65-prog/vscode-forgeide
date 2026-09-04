import * as path from 'path';

export function resolveWorkspacePath(workspaceRoot: string, requestedPath: string): string | undefined {
    if (!requestedPath || path.isAbsolute(requestedPath)) return undefined;

    const root = path.resolve(workspaceRoot);
    const resolved = path.resolve(root, requestedPath);
    const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return undefined;
    return resolved;
}