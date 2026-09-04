export interface RankedFile {
    path: string;
    score: number;
}

export interface TaskLike {
    title: string;
    detail: string;
}

const STOP_WORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'he', 'her', 'his',
    'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'their',
    'them', 'then', 'there', 'they', 'this', 'to', 'was', 'we', 'were', 'what', 'when', 'where',
    'which', 'who', 'will', 'with', 'you', 'your', 'add', 'using', 'through', 'around', 'across'
]);

export function rankFilesForTask(
    task: TaskLike,
    files: Array<{ path: string; content: string }>
): RankedFile[] {
    const taskTerms = [...new Set(
        `${task.title} ${task.detail}`
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter((term) => term.length > 2 && !STOP_WORDS.has(term))
    )];

    const ranked = files
        .filter(file => !file.path.includes('/.kiro/') && !file.path.startsWith('.kiro/') && !file.path.includes('node_modules'))
        .map(file => {
            const normalizedPath = file.path.toLowerCase();
            const contentLower = file.content.toLowerCase();
            let score = 0;

            for (const term of taskTerms) {
                const termMatches = contentLower.split(term).length - 1;
                if (termMatches > 0) score += termMatches * 3;
                if (normalizedPath.includes(term)) score += 10;
                if (normalizedPath.includes(term.replace(/s$/, ''))) score += 4;
            }

            const titleLower = task.title.toLowerCase();
            const detailLower = task.detail.toLowerCase();
            if (normalizedPath.includes('auth') && (detailLower.includes('auth') || titleLower.includes('auth'))) score += 8;
            if (normalizedPath.includes('login') && (detailLower.includes('login') || titleLower.includes('login'))) score += 8;
            if (normalizedPath.includes('user') && (detailLower.includes('user') || titleLower.includes('user'))) score += 4;

            return { path: file.path, score };
        })
        .filter(file => file.score > 0)
        .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

    return ranked;
}
