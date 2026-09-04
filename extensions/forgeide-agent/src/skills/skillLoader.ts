import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';

/**
 * Agent Skills — portable instruction packages defined in SKILL.md files.
 *
 * Scope:
 *   - Global  — lives in ~/.kiro/skills/  (personal, applies to all projects)
 *   - Workspace — lives in .kiro/skills/  (team/project-specific)
 *
 * Activation:
 *   - Driven by the `description` field keywords in each SKILL.md frontmatter.
 *   - When the conversation context contains matching keywords, the skill is
 *     injected into the agent's system prompt.
 *   - More precise keyword phrasing = more reliable activation.
 *
 * SKILL.md format:
 *   ---
 *   name: My Skill
 *   description: Use when working with Stripe payments or billing
 *   scope: workspace          (optional: "global" | "workspace", default "workspace")
 *   priority: 10              (optional, higher = closer to end of context = wins)
 *   ---
 *   (instructions here — keep lean and actionable)
 *
 *   references/               (subfolder — detailed API specs, runbooks, etc.)
 *
 * Scripts:
 *   Skills can declare scripts for deterministic tasks. These are run via
 *   the ToolHarness rather than asking the LLM to generate code.
 */

export type SkillScope = 'global' | 'workspace';

export interface Skill {
    id: string;               // derived from file path
    name: string;
    description: string;      // keyword-rich activation phrase
    instructions: string;     // body of the SKILL.md (after frontmatter)
    scope: SkillScope;
    priority: number;
    sourcePath: string;       // absolute path to the SKILL.md file
    referencesDir?: string;   // absolute path to adjacent references/ dir, if present
    fromPower?: string;       // power name if loaded via a Power bundle
}

// ─────────────────────────────────────────────────────────────────────────────
// Frontmatter parser
// ─────────────────────────────────────────────────────────────────────────────
function parseFrontmatter(raw: string): { meta: Partial<Skill>; body: string } {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!match) return { meta: {}, body: raw };

    const meta: Partial<Skill> = {};
    for (const line of match[1].split('\n')) {
        const kv = line.match(/^(\w+):\s*(.+)$/);
        if (!kv) continue;
        const [, key, value] = kv;
        const clean = value.replace(/^["']|["']$/g, '').trim();
        if (key === 'name')        meta.name = clean;
        if (key === 'description') meta.description = clean;
        if (key === 'scope')       meta.scope = clean as SkillScope;
        if (key === 'priority')    meta.priority = Number(clean);
    }
    return { meta, body: match[2].trim() };
}

// ─────────────────────────────────────────────────────────────────────────────
// SkillLoader
// ─────────────────────────────────────────────────────────────────────────────
export class SkillLoader {
    /** All loaded skills (global + workspace), sorted by priority. */
    private skills: Skill[] = [];
    /** Extra steering blocks injected by active Powers. */
    private powerSteeringBlocks: string[] = [];

    // ── Load ──────────────────────────────────────────────────────────────────

    /**
     * Load skills from both global (~/.kiro/skills/) and workspace
     * (.kiro/skills/) directories. Call this on extension activation and
     * whenever the skills directories change.
     */
    async loadAll(): Promise<void> {
        const loaded: Skill[] = [];

        // Global skills
        const globalDir = path.join(os.homedir(), '.kiro', 'skills');
        loaded.push(...await this.loadFromDir(globalDir, undefined, 'global'));

        // Workspace skills
        const folders = vscode.workspace.workspaceFolders;
        if (folders?.length) {
            const wsDir = path.join(folders[0].uri.fsPath, '.kiro', 'skills');
            loaded.push(...await this.loadFromDir(wsDir, undefined, 'workspace'));
        }

        this.skills = loaded.sort((a, b) => a.priority - b.priority);
    }

    /**
     * Load skills from an arbitrary directory (used by PowerManager for
     * power-bundled skills). Pass `fromPower` to tag the source.
     */
    async loadFromDir(
        dir: string,
        contextText?: string,
        defaultScope: SkillScope = 'workspace',
        fromPower?: string
    ): Promise<Skill[]> {
        const dirUri = vscode.Uri.file(dir);
        let entries: [string, vscode.FileType][] = [];
        try {
            entries = await vscode.workspace.fs.readDirectory(dirUri);
        } catch {
            return [];
        }

        const skills: Skill[] = [];
        for (const [name, type] of entries) {
            if (type !== vscode.FileType.File) continue;
            if (!name.endsWith('.md') && !name.endsWith('.skill.md')) continue;

            const filePath = path.join(dir, name);
            try {
                const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
                const raw = Buffer.from(bytes).toString('utf8');
                const { meta, body } = parseFrontmatter(raw);

                const id = fromPower
                    ? `${fromPower}/${name.replace(/\.skill\.md$|\.md$/, '')}`
                    : `${defaultScope}/${name.replace(/\.skill\.md$|\.md$/, '')}`;

                const skill: Skill = {
                    id,
                    name:        meta.name ?? name.replace(/\.skill\.md$|\.md$/, ''),
                    description: meta.description ?? '',
                    instructions: body,
                    scope:       meta.scope ?? defaultScope,
                    priority:    meta.priority ?? 0,
                    sourcePath:  filePath,
                    fromPower
                };

                // Check for adjacent references/ directory
                const refDir = path.join(dir, 'references');
                try {
                    await vscode.workspace.fs.stat(vscode.Uri.file(refDir));
                    skill.referencesDir = refDir;
                } catch { /* no references dir */ }

                skills.push(skill);
            } catch (e) {
                // Skip unreadable files silently
            }
        }

        // If contextText provided, filter to matching skills only
        if (contextText !== undefined) {
            return skills.filter(s => this.matchesContext(s, contextText));
        }
        return skills;
    }

    // ── Contextual activation ─────────────────────────────────────────────────

    /**
     * Returns true if the skill's description keywords appear in contextText.
     * Precise description phrasing = more reliable triggering.
     */
    matchesContext(skill: Skill, contextText: string): boolean {
        if (!skill.description) return false;
        const lower = contextText.toLowerCase();
        // Split description into keyword phrases and check each
        const phrases = skill.description
            .split(/[,;|]/)
            .map(p => p.trim().toLowerCase())
            .filter(Boolean);
        return phrases.some(phrase => lower.includes(phrase));
    }

    /**
     * Returns all skills that match the current conversation context.
     * Called on every chat turn to decide what to inject.
     */
    getActiveSkills(contextText: string): Skill[] {
        return this.skills
            .filter(s => this.matchesContext(s, contextText))
            .sort((a, b) => a.priority - b.priority);
    }

    // ── Context block ─────────────────────────────────────────────────────────

    /**
     * Build the skills context block to inject into the agent's system prompt.
     * Only includes skills whose description matches contextText.
     */
    buildContextBlock(contextText: string): string {
        const active = this.getActiveSkills(contextText);
        if (!active.length && !this.powerSteeringBlocks.length) return '';

        const sections: string[] = [];

        if (active.length) {
            sections.push(
                '## Agent Skills (active for this context)\n\n' +
                active.map(s =>
                    `### ${s.name} [${s.scope}${s.fromPower ? ` · ${s.fromPower}` : ''}]\n${s.instructions}`
                ).join('\n\n---\n\n')
            );
        }

        if (this.powerSteeringBlocks.length) {
            sections.push(this.powerSteeringBlocks.join('\n\n'));
        }

        return sections.join('\n\n');
    }

    // ── Power steering integration ────────────────────────────────────────────

    /**
     * Called by PowerManager when a Power activates. Loads its steering/*.md
     * files and stores them as extra context blocks.
     */
    async loadPowerSteering(steeringDir: string): Promise<void> {
        const dirUri = vscode.Uri.file(steeringDir);
        let entries: [string, vscode.FileType][] = [];
        try {
            entries = await vscode.workspace.fs.readDirectory(dirUri);
        } catch {
            return;
        }

        for (const [name, type] of entries) {
            if (type !== vscode.FileType.File || !name.endsWith('.md')) continue;
            try {
                const bytes = await vscode.workspace.fs.readFile(
                    vscode.Uri.file(path.join(steeringDir, name))
                );
                const { body } = parseFrontmatter(Buffer.from(bytes).toString('utf8'));
                const block = `## Power steering: ${name}\n${body.trim()}`;
                if (!this.powerSteeringBlocks.includes(block)) {
                    this.powerSteeringBlocks.push(block);
                }
            } catch { /* skip */ }
        }
    }

    clearPowerSteering(): void {
        this.powerSteeringBlocks = [];
    }

    // ── Accessors ─────────────────────────────────────────────────────────────

    getAllSkills(): Skill[] {
        return [...this.skills];
    }

    getByScope(scope: SkillScope): Skill[] {
        return this.skills.filter(s => s.scope === scope);
    }

    getById(id: string): Skill | undefined {
        return this.skills.find(s => s.id === id);
    }
}
