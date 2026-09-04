import * as vscode from 'vscode';

export type AutopilotMode = 'supervised' | 'autopilot';

/**
 * Autopilot vs. Supervised mode toggle.
 *
 * Supervised: every proposed file change opens a diff view and requires
 *   explicit "Apply" before writing to disk. The default — safe for
 *   unfamiliar codebases or first use of a spec.
 *
 * Autopilot: approved spec tasks write files directly without a per-file
 *   diff prompt. Still gated by canGenerateCode(); the diff preview step
 *   is skipped only, not the spec gate.
 *
 * The current mode is persisted in VS Code workspace state so it survives
 * window reloads, and shown in the status bar via modelPicker.ts.
 */
export class AutopilotManager {
    private static readonly STATE_KEY = 'forgeide.autopilotMode';
    private mode: AutopilotMode;
    private onChangeEmitter = new vscode.EventEmitter<AutopilotMode>();
    onModeChanged = this.onChangeEmitter.event;

    constructor(private context: vscode.ExtensionContext) {
        // Prefer workspace state, fall back to settings, then default supervised
        const stored = context.workspaceState.get<AutopilotMode>(AutopilotManager.STATE_KEY);
        const configured = vscode.workspace
            .getConfiguration('forgeide')
            .get<AutopilotMode>('gateMode', 'supervised');
        this.mode = stored ?? configured;
    }

    getMode(): AutopilotMode {
        return this.mode;
    }

    isAutopilot(): boolean {
        return this.mode === 'autopilot';
    }

    async setMode(mode: AutopilotMode): Promise<void> {
        this.mode = mode;
        await this.context.workspaceState.update(AutopilotManager.STATE_KEY, mode);
        await vscode.workspace
            .getConfiguration('forgeide')
            .update('gateMode', mode, vscode.ConfigurationTarget.Workspace);
        this.onChangeEmitter.fire(mode);
    }

    async toggle(): Promise<void> {
        await this.setMode(this.mode === 'supervised' ? 'autopilot' : 'supervised');
    }

    /** Registers the toggle command and returns a disposable. */
    registerCommand(): vscode.Disposable {
        return vscode.commands.registerCommand('forgeide.toggleAutopilot', async () => {
            await this.toggle();
            vscode.window.showInformationMessage(
                `ForgeIDE: switched to ${this.mode === 'autopilot' ? '⚡ Autopilot' : '👁 Supervised'} mode.`
            );
        });
    }
}
