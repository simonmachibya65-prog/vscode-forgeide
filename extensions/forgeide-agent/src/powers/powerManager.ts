import * as vscode from 'vscode';
import * as path from 'path';
import { McpManager, McpServerConfig } from '../mcp/mcpManager';
import { SkillLoader } from '../skills/skillLoader';
import { WorkspaceResolver } from '../util/workspaceResolver';

/**
 * A Power bundles MCP tools + Agent Skills + knowledge into one installable
 * package. Dynamic contextual activation means a Power loads only when the
 * conversation context matches its keywords — avoiding "MCP context overload".
 *
 * Directory layout of an installed Power:
 *   .kiro/powers/<power-id>/
 *     plugin.json     — manifest (name, description, keywords, mcpServers, skills)
 *     skills/         — SKILL.md files
 *     mcp.json        — MCP server configs to connect when active
 *     steering/       — optional .md context extensions
 *     POWER.md        — legacy format (still supported, auto-converted on load)
 */

export interface PowerManifest {
    id: string;
    name: string;
    description: string;
    /** Keywords that trigger contextual activation of this power */
    keywords: string[];
    version: string;
    author?: string;
    mcpServers?: McpServerConfig[];
    skills?: string[];   // relative paths to SKILL.md files inside this power
    steering?: string[]; // relative paths to .md steering extensions
}

export interface InstalledPower {
    manifest: PowerManifest;
    dir: string;       // absolute path to the power directory
    active: boolean;   // currently loaded into context
    error?: string;
}

export class PowerManager implements vscode.Disposable {
    private powers = new Map<string, InstalledPower>();
    private activePowerIds = new Set<string>();
    private onChangeEmitter = new vscode.EventEmitter<InstalledPower[]>();
    onPowersChanged = this.onChangeEmitter.event;

    constructor(
        private mcpManager: McpManager,
        private skillLoader: SkillLoader,
        private outputChannel: vscode.OutputChannel
    ) {}

    /** Scan .kiro/powers/ in the workspace and load all installed powers. */
    async loadFromWorkspace(): Promise<void> {
        const powersDir = WorkspaceResolver.uri('.kiro/powers');
        if (!powersDir) return;
        let entries: [string, vscode.FileType][] = [];
        try {
            entries = await vscode.workspace.fs.readDirectory(powersDir);
        } catch {
            this.outputChannel.appendLine('Powers: no .kiro/powers/ directory found.');
            return;
        }

        this.powers.clear();
        for (const [name, type] of entries) {
            if (type !== vscode.FileType.Directory) continue;
            const powerDir = vscode.Uri.joinPath(powersDir, name);
            await this.loadPower(powerDir.fsPath);
        }
        this.outputChannel.appendLine(`Powers: loaded ${this.powers.size} power(s).`);
        this.onChangeEmitter.fire(this.list());
    }

    private async loadPower(dir: string): Promise<void> {
        // Try plugin.json first, fall back to POWER.md (legacy)
        const pluginJsonUri = vscode.Uri.file(path.join(dir, 'plugin.json'));
        const powerMdUri   = vscode.Uri.file(path.join(dir, 'POWER.md'));

        let manifest: PowerManifest | undefined;
        try {
            const bytes = await vscode.workspace.fs.readFile(pluginJsonUri);
            manifest = JSON.parse(Buffer.from(bytes).toString('utf8'));
        } catch {
            // Try POWER.md legacy format
            try {
                const bytes = await vscode.workspace.fs.readFile(powerMdUri);
                manifest = parsePowerMd(Buffer.from(bytes).toString('utf8'), path.basename(dir));
                // Auto-convert to plugin.json
                await vscode.workspace.fs.writeFile(
                    pluginJsonUri,
                    Buffer.from(JSON.stringify(manifest, null, 2), 'utf8')
                );
                this.outputChannel.appendLine(`Powers: converted POWER.md → plugin.json for "${manifest.name}"`);
            } catch {
                this.outputChannel.appendLine(`Powers: could not load power at ${dir}`);
                return;
            }
        }

        if (!manifest) return;
        manifest.id = manifest.id ?? path.basename(dir);

        this.powers.set(manifest.id, { manifest, dir, active: false });
    }

    /**
     * Contextual activation — call this with the current conversation text.
     * Powers whose keywords appear in the context are activated; others are
     * deactivated. This is the core mechanism that avoids MCP context overload.
     */
    async activateForContext(contextText: string): Promise<void> {
        const lower = contextText.toLowerCase();
        const toActivate   = new Set<string>();
        const toDeactivate = new Set<string>();

        for (const [id, power] of this.powers) {
            const matches = power.manifest.keywords.some(kw => lower.includes(kw.toLowerCase()));
            if (matches && !this.activePowerIds.has(id)) toActivate.add(id);
            if (!matches && this.activePowerIds.has(id)) toDeactivate.add(id);
        }

        for (const id of toDeactivate) await this.deactivate(id);
        for (const id of toActivate)   await this.activate(id);

        if (toActivate.size || toDeactivate.size) {
            this.onChangeEmitter.fire(this.list());
        }
    }

    async activate(id: string): Promise<void> {
        const power = this.powers.get(id);
        if (!power || power.active) return;

        this.outputChannel.appendLine(`Powers: activating "${power.manifest.name}"`);

        // Connect MCP servers declared in this power
        for (const serverCfg of power.manifest.mcpServers ?? []) {
            await this.mcpManager.connect(serverCfg);
        }

        // Load power-bundled steering extensions
        const steeringDir = path.join(power.dir, 'steering');
        await this.skillLoader.loadPowerSteering(steeringDir);

        power.active = true;
        this.activePowerIds.add(id);
        this.onChangeEmitter.fire(this.list());
    }

    async deactivate(id: string): Promise<void> {
        const power = this.powers.get(id);
        if (!power || !power.active) return;

        this.outputChannel.appendLine(`Powers: deactivating "${power.manifest.name}"`);

        // Disconnect MCP servers that belong exclusively to this power
        for (const serverCfg of power.manifest.mcpServers ?? []) {
            await this.mcpManager.disconnect(serverCfg.name);
        }

        power.active = false;
        this.activePowerIds.delete(id);
        this.onChangeEmitter.fire(this.list());
    }

    /**
     * Install a power from a directory path (e.g., from a downloaded zip).
     * Copies it into .kiro/powers/ and loads it.
     */
    async install(sourcePath: string): Promise<void> {
        const folder = WorkspaceResolver.active();
        if (!folder) throw new Error('No workspace open.');

        const id = path.basename(sourcePath);
        const destUri = vscode.Uri.joinPath(folder.uri, '.kiro', 'powers', id);
        await vscode.workspace.fs.copy(
            vscode.Uri.file(sourcePath), destUri, { overwrite: true }
        );
        await this.loadPower(destUri.fsPath);
        this.onChangeEmitter.fire(this.list());
        vscode.window.showInformationMessage(`Power "${id}" installed.`);
    }

    async uninstall(id: string): Promise<void> {
        const power = this.powers.get(id);
        if (!power) return;
        if (power.active) await this.deactivate(id);

        await vscode.workspace.fs.delete(vscode.Uri.file(power.dir), { recursive: true });
        this.powers.delete(id);
        this.onChangeEmitter.fire(this.list());
        vscode.window.showInformationMessage(`Power "${id}" uninstalled.`);
    }

    /** Returns active skills context block from all currently active powers. */
    async getActiveSkillsContext(contextText: string): Promise<string> {
        const blocks: string[] = [];
        for (const [, power] of this.powers) {
            if (!power.active) continue;
            const skillsDir = path.join(power.dir, 'skills');
            const skills = await this.skillLoader.loadFromDir(skillsDir, contextText, 'workspace', power.manifest.id);
            if (skills.length) {
                const section = skills
                    .map(s => `### ${s.name}\n${s.instructions}`)
                    .join('\n\n---\n\n');
                blocks.push(`## Skills from power: ${power.manifest.name}\n\n${section}`);
            }
        }
        return blocks.join('\n\n');
    }

    list(): InstalledPower[] {
        return [...this.powers.values()];
    }

    getActive(): InstalledPower[] {
        return [...this.powers.values()].filter(p => p.active);
    }

    dispose(): void {
        this.onChangeEmitter.dispose();
    }
}

// ── Legacy POWER.md parser ────────────────────────────────────────────────────
function parsePowerMd(content: string, fallbackId: string): PowerManifest {
    const lines = content.split('\n');
    const name = lines.find(l => l.startsWith('# '))?.slice(2).trim() ?? fallbackId;
    const description = lines.find(l => l.startsWith('> '))?.slice(2).trim()
        ?? lines.find(l => l.trim() && !l.startsWith('#'))?.trim()
        ?? '';

    // Extract keywords from a "keywords:" or "## Keywords" section
    const kwLine = lines.find(l => /^keywords:/i.test(l));
    const keywords = kwLine
        ? kwLine.replace(/^keywords:/i, '').split(',').map(k => k.trim()).filter(Boolean)
        : extractKeywordsFromText(content);

    return {
        id: fallbackId,
        name,
        description,
        keywords,
        version: '1.0.0'
    };
}

function extractKeywordsFromText(text: string): string[] {
    // Pull nouns from heading lines as heuristic keywords
    return text
        .split('\n')
        .filter(l => l.startsWith('## ') || l.startsWith('### '))
        .map(l => l.replace(/^#+\s*/, '').trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 10);
}
