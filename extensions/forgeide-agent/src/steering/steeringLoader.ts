import * as vscode from 'vscode';
import { WorkspaceResolver } from '../util/workspaceResolver';

export interface SteeringFile {
    name: string;
    content: string;
    scope: 'project' | 'org' | 'folder';
    /** Optional glob (from frontmatter) restricting when this file applies. Absent = always applies. */
    appliesTo?: string;
    /** Higher priority runs closer to end of context, wins on conflicting guidance. Default 0. */
    priority: number;
}

/**
 * Steering files support simple YAML-ish frontmatter:
 *
 *   ---
 *   appliesTo: "src/api/**"
 *   priority: 10
 *   scope: org
 *   ---
 *   Always validate request bodies with zod in this folder.
 *
 * Files without frontmatter apply everywhere at priority 0, project scope.
 * Files prefixed "org." are treated as org-scoped automatically.
 */
function parseFrontmatter(raw: string): { meta: Partial<SteeringFile>; body: string } {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!match) return { meta: {}, body: raw };

    const meta: Partial<SteeringFile> = {};
    for (const line of match[1].split('\n')) {
        const kv = line.match(/^(\w+):\s*(.+)$/);
        if (!kv) continue;
        const [, key, value] = kv;
        const clean = value.replace(/^["']|["']$/g, '');
        if (key === 'appliesTo') meta.appliesTo = clean;
        if (key === 'priority') meta.priority = Number(clean);
        if (key === 'scope') meta.scope = clean as SteeringFile['scope'];
    }
    return { meta, body: match[2] };
}

function globToRegex(glob: string): RegExp {
    const escaped = glob
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '§DOUBLESTAR§')
        .replace(/\*/g, '[^/]*')
        .replace(/§DOUBLESTAR§/g, '.*');
    return new RegExp(`^${escaped}$`);
}

export class SteeringLoader {
    async loadAll(steeringDirRelative: string): Promise<SteeringFile[]> {
        const results: SteeringFile[] = [];
        // Load from every open workspace folder for multi-root support
        for (const folder of WorkspaceResolver.all()) {
            const dirUri = vscode.Uri.joinPath(folder.uri, steeringDirRelative);
            let entries: [string, vscode.FileType][] = [];
            try {
                entries = await vscode.workspace.fs.readDirectory(dirUri);
            } catch {
                continue;
            }

            for (const [name, type] of entries) {
                if (type !== vscode.FileType.File || !name.endsWith('.md')) continue;
                const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dirUri, name));
                const { meta, body } = parseFrontmatter(Buffer.from(bytes).toString('utf8'));
                const inferredScope: SteeringFile['scope'] = meta.scope
                    ?? (name.startsWith('org.') ? 'org' : 'project');
                results.push({
                    name,
                    content: body.trim(),
                    scope: inferredScope,
                    appliesTo: meta.appliesTo,
                    priority: meta.priority ?? 0
                });
            }
        }
        return results.sort((a, b) => a.priority - b.priority);
    }

    /**
     * Loads and renders steering context, optionally scoped to the file currently
     * being worked on. Files with an `appliesTo` glob that doesn't match
     * `activeRelativePath` are excluded.
     */
    async load(steeringDirRelative: string, activeRelativePath?: string): Promise<string> {
        const applicable = await this.applicableFiles(steeringDirRelative, activeRelativePath);
        if (!applicable.length) return '';
        const sections = applicable.map(f => `# From ${f.name} [${f.scope}]\n${f.content}`);
        return `The following are project-specific rules and context that MUST be followed:\n\n` +
            sections.join('\n\n---\n\n');
    }

    /**
     * Returns a single context block string suitable for prepending to any AI call —
     * spec generation, chat, tab completion, Cmd-K, all of them.
     * Mirrors the SteeringStore.buildContextBlock() pattern from the reference implementation.
     */
    async buildContextBlock(steeringDirRelative: string, activeRelativePath?: string): Promise<string> {
        const applicable = await this.applicableFiles(steeringDirRelative, activeRelativePath);
        if (!applicable.length) return '';
        return (
            '## Project Steering (must be followed)\n\n' +
            applicable
                .map(f => `### ${f.name} [${f.scope}]\n${f.content}`)
                .join('\n\n')
        );
    }

    private async applicableFiles(
        steeringDirRelative: string,
        activeRelativePath?: string
    ): Promise<SteeringFile[]> {
        const files = await this.loadAll(steeringDirRelative);
        return files.filter(f => {
            if (!f.appliesTo) return true;
            if (!activeRelativePath) return true;
            return globToRegex(f.appliesTo).test(activeRelativePath);
        });
    }
}
