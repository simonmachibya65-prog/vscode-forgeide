export interface WorkspaceSearchHit {
    path: string;
    line: number;
    snippet: string;
}

export interface SearchQuickPickItem {
    label: string;
    description: string;
    path?: string;
    line?: number;
}

export function formatSearchResultText(query: string, hits: WorkspaceSearchHit[]): string {
    if (!hits.length) return `No matches for "${query}".`;
    return hits
        .map(hit => `${hit.path}:${hit.line}: ...${hit.snippet}...`)
        .join('\n');
}

export function buildSearchQuickPickItems(query: string, hits: WorkspaceSearchHit[]): SearchQuickPickItem[] {
    if (!hits.length) {
        return [{ label: `No matches for "${query}"`, description: 'Try a different search term' }];
    }
    return hits.map(hit => ({
        label: `${hit.path}:${hit.line}`,
        description: hit.snippet.trim(),
        path: hit.path,
        line: hit.line
    }));
}
