import * as vscode from 'vscode';
import { AutopilotMode } from '../agents/autopilot';

type Provider = 'anthropic' | 'openai' | 'bedrock';

interface ModelOption {
    provider: Provider;
    model: string;
    label: string;
}

const KNOWN_MODELS: ModelOption[] = [
    { provider: 'anthropic', model: 'claude-sonnet-4-6',      label: 'Claude Sonnet 4.6 (Anthropic)' },
    { provider: 'anthropic', model: 'claude-opus-4-5',        label: 'Claude Opus 4.5 (Anthropic)' },
    { provider: 'anthropic', model: 'claude-haiku-3-5',       label: 'Claude Haiku 3.5 (Anthropic)' },
    { provider: 'openai',    model: 'gpt-4o',                 label: 'GPT-4o (OpenAI)' },
    { provider: 'openai',    model: 'gpt-4o-mini',            label: 'GPT-4o Mini (OpenAI)' },
    { provider: 'openai',    model: 'o3',                     label: 'o3 (OpenAI)' },
    { provider: 'bedrock',   model: 'anthropic.claude-3-sonnet-20240229-v1:0', label: 'Claude 3 Sonnet (Bedrock)' },
];

/**
 * ModelPicker — status bar item showing the active model + autopilot mode.
 * Click → QuickPick to switch model or toggle autopilot.
 */
export class ModelPicker implements vscode.Disposable {
    private item: vscode.StatusBarItem;

    constructor(private context: vscode.ExtensionContext) {
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.item.command = 'forgeide.pickModel';
        this.update();
        this.item.show();
        context.subscriptions.push(this.item);
    }

    update(autopilotMode?: AutopilotMode): void {
        const cfg = vscode.workspace.getConfiguration('forgeide');
        const provider = cfg.get<Provider>('model.provider', 'anthropic');
        const model = cfg.get<string>('model.name', 'claude-sonnet-4-6');
        const mode = autopilotMode
            ?? cfg.get<AutopilotMode>('gateMode', 'supervised');

        const modeIcon = mode === 'autopilot' ? '⚡' : '👁';
        const shortModel = model.split('-').slice(0, 3).join('-');
        this.item.text = `$(robot) ${shortModel} ${modeIcon}`;
        this.item.tooltip = `Provider: ${provider}\nModel: ${model}\nMode: ${mode}\nClick to change`;
    }

    /** Register the command that opens the model/mode picker QuickPick. */
    registerCommand(): vscode.Disposable {
        return vscode.commands.registerCommand('forgeide.pickModel', async () => {
            const cfg = vscode.workspace.getConfiguration('forgeide');
            const currentProvider = cfg.get<Provider>('model.provider', 'anthropic');
            const currentModel = cfg.get<string>('model.name', 'claude-sonnet-4-6');
            const currentMode = cfg.get<AutopilotMode>('gateMode', 'supervised');

            type PickItem = vscode.QuickPickItem & { action: 'model' | 'mode'; value: string };

            const items: PickItem[] = [
                // Separator
                { label: 'Models', kind: vscode.QuickPickItemKind.Separator, action: 'model', value: '' },
                ...KNOWN_MODELS.map(m => ({
                    label: m.label,
                    description: m.provider === currentProvider && m.model === currentModel ? '✓ active' : '',
                    action: 'model' as const,
                    value: `${m.provider}|${m.model}`
                })),
                { label: 'Custom model...', action: 'model', value: '__custom__' },
                // Separator
                { label: 'Execution Mode', kind: vscode.QuickPickItemKind.Separator, action: 'mode', value: '' },
                {
                    label: '👁 Supervised',
                    description: currentMode === 'supervised' ? '✓ active' : 'Diff preview required for every write',
                    action: 'mode',
                    value: 'supervised'
                },
                {
                    label: '⚡ Autopilot',
                    description: currentMode === 'autopilot' ? '✓ active' : 'Writes directly after spec approval',
                    action: 'mode',
                    value: 'autopilot'
                }
            ];

            const pick = await vscode.window.showQuickPick(items, {
                title: 'ForgeIDE: Select Model or Execution Mode',
                placeHolder: 'Choose a model or toggle autopilot mode'
            });
            if (!pick || !pick.value) return;

            if (pick.action === 'mode') {
                await cfg.update('gateMode', pick.value, vscode.ConfigurationTarget.Workspace);
                this.update(pick.value as AutopilotMode);
                vscode.window.showInformationMessage(`ForgeIDE: execution mode → ${pick.value}`);
            } else if (pick.value === '__custom__') {
                const custom = await vscode.window.showInputBox({
                    prompt: 'Enter model identifier',
                    value: currentModel
                });
                if (!custom) return;
                await cfg.update('model.name', custom, vscode.ConfigurationTarget.Workspace);
                this.update();
            } else {
                const [provider, model] = pick.value.split('|');
                await cfg.update('model.provider', provider, vscode.ConfigurationTarget.Workspace);
                await cfg.update('model.name', model, vscode.ConfigurationTarget.Workspace);
                this.update();
                vscode.window.showInformationMessage(`ForgeIDE: model → ${model}`);
            }
        });
    }

    dispose(): void {
        this.item.dispose();
    }
}
