import * as vscode from 'vscode';
import { SpecWebview } from './specWebview';

/**
 * IdeShell — registers the `forgeide.openIdeShell` command that opens the
 * full Gatework IDE shell webview. This is the primary entry point for users
 * who prefer the rich visual interface over the tree view sidebar.
 */
export function registerIdeShellCommand(
    context: vscode.ExtensionContext,
    specWebview: SpecWebview
): vscode.Disposable {
    return vscode.commands.registerCommand('forgeide.openIdeShell', async () => {
        await specWebview.open();
    });
}
