import * as vscode from 'vscode';

/**
 * Shows a proposed change as a real VS Code diff view and waits for explicit
 * user approval before writing anything to disk. This is the single choke
 * point every write in the extension (hooks, task execution) must go through --
 * nothing here writes silently.
 */
export async function proposeAndApply(opts: {
    uri: vscode.Uri;
    newContent: string;
    title: string;
}): Promise<'applied' | 'rejected' | 'unchanged'> {
    let existing = '';
    let fileExists = true;
    try {
        const bytes = await vscode.workspace.fs.readFile(opts.uri);
        existing = Buffer.from(bytes).toString('utf8');
    } catch {
        fileExists = false;
    }

    if (fileExists && existing === opts.newContent) {
        return 'unchanged';
    }

    // Stage the proposed version in a virtual, read-only document so the
    // built-in diff editor can compare it against the real file without
    // touching disk yet.
    const proposedUri = opts.uri.with({
        scheme: 'forgeide-proposed',
        path: opts.uri.path + '.proposed'
    });
    proposedContentProvider.set(proposedUri, opts.newContent);

    await vscode.commands.executeCommand(
        'vscode.diff',
        fileExists ? opts.uri : proposedUri.with({ scheme: 'forgeide-proposed', path: opts.uri.path + '.empty' }),
        proposedUri,
        `${opts.title} (proposed)`
    );

    const choice = await vscode.window.showInformationMessage(
        `Apply proposed change to ${vscode.workspace.asRelativePath(opts.uri)}?`,
        { modal: false },
        'Apply', 'Reject'
    );

    if (choice !== 'Apply') {
        return 'rejected';
    }

    const dir = opts.uri.with({ path: opts.uri.path.split('/').slice(0, -1).join('/') });
    await vscode.workspace.fs.createDirectory(dir);
    await vscode.workspace.fs.writeFile(opts.uri, Buffer.from(opts.newContent, 'utf8'));
    return 'applied';
}

/** Backing content provider for the virtual "proposed" side of diff views. */
class ProposedContentProvider implements vscode.TextDocumentContentProvider {
    private store = new Map<string, string>();
    private emitter = new vscode.EventEmitter<vscode.Uri>();
    onDidChange = this.emitter.event;

    set(uri: vscode.Uri, content: string) {
        this.store.set(uri.toString(), content);
        this.emitter.fire(uri);
    }

    provideTextDocumentContent(uri: vscode.Uri): string {
        return this.store.get(uri.toString()) ?? '';
    }
}

export const proposedContentProvider = new ProposedContentProvider();

export function registerDiffContentProvider(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider('forgeide-proposed', proposedContentProvider)
    );
}
