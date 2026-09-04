import * as vscode from 'vscode';
import * as path from 'path';
import { PowerManifest } from './powerManager';

/**
 * PowerBuilder — two capabilities:
 * 1. Convert a legacy POWER.md into the new plugin.json + directory structure.
 * 2. Scaffold a brand-new power from a quick-prompt wizard.
 */
export class PowerBuilder {

    /**
     * Interactive wizard: prompts for name/description/keywords then scaffolds
     * a new power directory under .kiro/powers/<id>/.
     */
    static async scaffold(): Promise<void> {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders?.length) {
            vscode.window.showErrorMessage('Open a workspace folder first.');
            return;
        }

        const name = await vscode.window.showInputBox({
            prompt: 'Power name (e.g. "Stripe Payments")',
            placeHolder: 'My Power'
        });
        if (!name) return;

        const description = await vscode.window.showInputBox({
            prompt: 'Short description — shown in the Powers panel',
            placeHolder: 'Adds Stripe API tools and billing conventions'
        });
        if (description === undefined) return;

        const keywordsRaw = await vscode.window.showInputBox({
            prompt: 'Activation keywords, comma-separated (context triggers)',
            placeHolder: 'payment, stripe, billing, invoice'
        });
        if (keywordsRaw === undefined) return;

        const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        const keywords = keywordsRaw.split(',').map(k => k.trim()).filter(Boolean);

        const manifest: PowerManifest = {
            id, name, description, keywords,
            version: '0.1.0',
            mcpServers: [],
            skills: ['skills/main.skill.md'],
            steering: []
        };

        const powerDir = vscode.Uri.joinPath(folders[0].uri, '.kiro', 'powers', id);

        // Create directory structure
        await vscode.workspace.fs.createDirectory(powerDir);
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(powerDir, 'skills'));
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(powerDir, 'steering'));

        // Write plugin.json
        await vscode.workspace.fs.writeFile(
            vscode.Uri.joinPath(powerDir, 'plugin.json'),
            Buffer.from(JSON.stringify(manifest, null, 2), 'utf8')
        );

        // Scaffold a starter SKILL.md
        const skillContent = [
            `# ${name} — Main Skill`,
            '',
            '## Description',
            description,
            '',
            '## Activation keywords',
            keywords.join(', '),
            '',
            '## Instructions',
            'When working with ' + keywords[0] + ', follow these conventions:',
            '- (Add your conventions here)',
            '',
            '## References',
            '- See `references/` for detailed API specs or runbooks.',
        ].join('\n');

        await vscode.workspace.fs.writeFile(
            vscode.Uri.joinPath(powerDir, 'skills', 'main.skill.md'),
            Buffer.from(skillContent, 'utf8')
        );

        // Scaffold mcp.json template
        const mcpTemplate = {
            mcpServers: [
                {
                    name: `${id}-server`,
                    transport: 'stdio',
                    command: 'npx',
                    args: [`-y @modelcontextprotocol/server-${id}`],
                    _comment: 'Replace with your actual MCP server command'
                }
            ]
        };
        await vscode.workspace.fs.writeFile(
            vscode.Uri.joinPath(powerDir, 'mcp.json'),
            Buffer.from(JSON.stringify(mcpTemplate, null, 2), 'utf8')
        );

        // Open plugin.json for the user
        const doc = await vscode.workspace.openTextDocument(
            vscode.Uri.joinPath(powerDir, 'plugin.json')
        );
        await vscode.window.showTextDocument(doc);

        vscode.window.showInformationMessage(
            `Power "${name}" scaffolded at .kiro/powers/${id}/. ` +
            `Edit plugin.json and skills/main.skill.md to complete it.`
        );
    }

    /**
     * Convert a POWER.md file the user has open (or picks) into the new
     * plugin.json + directory structure alongside it.
     */
    static async convertPowerMd(uri?: vscode.Uri): Promise<void> {
        if (!uri) {
            const picked = await vscode.window.showOpenDialog({
                filters: { 'Markdown': ['md'] },
                canSelectMany: false,
                openLabel: 'Convert POWER.md'
            });
            if (!picked?.length) return;
            uri = picked[0];
        }

        const bytes = await vscode.workspace.fs.readFile(uri);
        const content = Buffer.from(bytes).toString('utf8');
        const lines = content.split('\n');

        const name = lines.find(l => l.startsWith('# '))?.slice(2).trim() ?? 'My Power';
        const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        const kwLine = lines.find(l => /^keywords:/i.test(l));
        const keywords = kwLine
            ? kwLine.replace(/^keywords:/i, '').split(',').map(k => k.trim()).filter(Boolean)
            : [];

        const manifest: PowerManifest = {
            id, name,
            description: lines.find(l => l.startsWith('> '))?.slice(2).trim() ?? '',
            keywords, version: '1.0.0'
        };

        const dir = path.dirname(uri.fsPath);
        const pluginJsonUri = vscode.Uri.file(path.join(dir, 'plugin.json'));
        await vscode.workspace.fs.writeFile(
            pluginJsonUri,
            Buffer.from(JSON.stringify(manifest, null, 2), 'utf8')
        );

        const doc = await vscode.workspace.openTextDocument(pluginJsonUri);
        await vscode.window.showTextDocument(doc);
        vscode.window.showInformationMessage(`Converted POWER.md → plugin.json for "${name}".`);
    }
}
