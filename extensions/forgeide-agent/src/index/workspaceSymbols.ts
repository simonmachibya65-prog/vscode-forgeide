export function extractSymbolsFromText(text: string): string[] {
    const symbols = new Set<string>();
    const patterns = [
        /export\s+(?:async\s+)?function\s+(\w+)/g,
        /export\s+class\s+(\w+)/g,
        /export\s+interface\s+(\w+)/g,
        /export\s+type\s+(\w+)/g,
        /export\s+enum\s+(\w+)/g,
        /class\s+(\w+)/g,
        /function\s+(\w+)/g,
        /const\s+(\w+)/g,
        /let\s+(\w+)/g,
        /var\s+(\w+)/g,
        /\b(?:async\s+)?(\w+)\s*\([^)]*\)\s*=>/g
    ];

    for (const pattern of patterns) {
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text)) !== null) {
            const symbol = match[1];
            if (symbol && !symbol.startsWith('_')) symbols.add(symbol);
        }
    }

    return [...symbols].sort((a, b) => a.localeCompare(b));
}

export async function findWorkspaceSymbols(query: string, files: Array<{ path: string; content: string }>): Promise<Array<{ path: string; symbol: string; score: number }>> {
    const normalizedQuery = query.toLowerCase();
    const results = files
        .flatMap(file => extractSymbolsFromText(file.content).map(symbol => {
            const symbolLower = symbol.toLowerCase();
            const score = symbolLower.includes(normalizedQuery) ? 3 : 0;
            return { path: file.path, symbol, score };
        }))
        .filter(result => result.score > 0)
        .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.symbol.localeCompare(b.symbol));

    return results.slice(0, 20);
}
