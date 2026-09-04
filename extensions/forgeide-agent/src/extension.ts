import * as vscode from 'vscode';
import { MultiProviderModelClient } from './modelClient';
import { SpecsEngine } from './specs/specsEngine';
import { SpecsTreeProvider } from './specs/specsTreeProvider';
import { TaskExecutor } from './specs/taskExecutor';
import { HooksEngine, HookDefinition } from './hooks/hooksEngine';
import { HooksTreeProvider } from './hooks/hooksTreeProvider';
import { SteeringLoader } from './steering/steeringLoader';
import { SteeringTreeProvider } from './steering/steeringTreeProvider';
import { McpManager } from './mcp/mcpManager';
import { McpTreeProvider } from './mcp/mcpTreeProvider';
import { registerChatParticipant } from './chat/chatParticipant';
import { proposeAndApply, registerDiffContentProvider } from './diff/diffPreview';
import { CheckpointManager } from './agents/checkpointManager';
import { AutopilotManager } from './agents/autopilot';
import { ReasoningPanel } from './agents/reasoningPanel';
import { BackgroundQueue } from './agents/backgroundQueue';
import { ModelPicker } from './ui/modelPicker';
import { SpecWebview } from './ui/specWebview';
import { registerIdeShellCommand } from './ui/ideShell';
import { ForgeInlineCompletionProvider } from './completion/inlineProvider';
import { CmdKHandler } from './completion/cmdkHandler';
import { CodebaseIndex } from './index/codebaseIndex';
import { BugBot } from './review/bugbot';
import { SkillLoader } from './skills/skillLoader';
import { SkillsTreeProvider } from './skills/skillsTreeProvider';
import { PowerManager } from './powers/powerManager';
import { PowerBuilder } from './powers/powerBuilder';
import { PowersTreeProvider } from './powers/powersTreeProvider';
import { AgentRegistry } from './agents/agentRegistry';
import { AgentRunner } from './agents/agentRunner';
import { AgentsTreeProvider } from './agents/agentsTreeProvider';
import { CheckpointsTreeProvider } from './agents/checkpointsTreeProvider';
import { VerificationAgent } from './agents/verificationAgent';
import { ToolHarness } from './tools/toolHarness';
import { ToolSandbox } from './tools/toolSandbox';
import { ConnectorRegistry } from './connectors/connectorRegistry';
import { ModelRouter } from './model/modelRouter';
import { DaemonProcess } from './daemon/daemonProcess';
import { KiroIgnore } from './index/kiroignore';
import { Orchestrator } from './daemon/orchestrator';
import { CloudBackgroundRunner } from './cloud/backgroundRunner';
import { WorkspaceResolver } from './util/workspaceResolver';
import { CommitMessageProvider } from './scm/commitMessageProvider';
import { ScmTreeProvider } from './scm/scmTreeProvider';
import { DeploymentHistoryStore, formatDeploymentHistory } from './deployment/deploymentHistory';
import { checkDeploymentHealth } from './deployment/deploymentHealth';
import { createDatabaseEnvExample, createDatabasePlan, createDeploymentPlan, detectMigrationCommand, detectProjectEnvironment, ProjectFile } from './environment/projectDetector';
import { gatherEditorContext } from './chat/contextGatherer';
import { searchWorkspaceMatches, searchWorkspace } from './chat/contextGatherer';
import { buildSearchQuickPickItems } from './chat/searchResultFormatter';

export async function activate(context: vscode.ExtensionContext) {
    const output = vscode.window.createOutputChannel('ForgeIDE');
    output.appendLine('ForgeIDE activating...');

    // --- Register diff content provider first (needed by taskExecutor + hooks) ---
    registerDiffContentProvider(context);

    const config = vscode.workspace.getConfiguration('forgeide');
    const workspaceFolder = WorkspaceResolver.active();
    const workspaceRoot   = WorkspaceResolver.root();
    const specsDir    = config.get<string>('specs.directory',    '.kiro/specs');
    const hooksDir    = config.get<string>('hooks.directory',    '.kiro/hooks');
    const steeringDir = config.get<string>('steering.directory', '.kiro/steering');
    const confirmShellCommand = async (command: string): Promise<boolean> => {
        if (!config.get<boolean>('terminal.confirmCommands', true)) return true;
        const choice = await vscode.window.showWarningMessage(
            `Run shell command?\n\n${command}`,
            { modal: true },
            'Run'
        );
        return choice === 'Run';
    };
    const inspectEnvironment = async (): Promise<ReturnType<typeof detectProjectEnvironment>> => {
        const files: ProjectFile[] = [];
        const entries = await vscode.workspace.findFiles(
            '**/*',
            '**/{node_modules,.git,dist,out,build,.next}/**'
        );
        for (const uri of entries.slice(0, 300)) {
            const relativePath = vscode.workspace.asRelativePath(uri);
            if (relativePath.toLowerCase() === 'package.json') {
                try {
                    const bytes = await vscode.workspace.fs.readFile(uri);
                    files.push({ path: relativePath, content: Buffer.from(bytes).toString('utf8') });
                } catch {
                    files.push({ path: relativePath });
                }
            } else {
                files.push({ path: relativePath });
            }
        }
        return detectProjectEnvironment(files);
    };
    const runGit = (args: string[]) => toolSandbox.run('git', args, workspaceRoot);
    const showGitResult = (label: string, result: { ok: boolean; output?: string; error?: string }) => {
        output.appendLine(`\n[${label}]\n${result.output ?? result.error ?? ''}`);
        output.show();
        if (!result.ok) vscode.window.showErrorMessage(`ForgeIDE: ${label} failed.`);
    };

    // -------------------------------------------------------------------------
    // Core subsystems
    // -------------------------------------------------------------------------
    const model          = new MultiProviderModelClient(context);
    const specsEngine    = new SpecsEngine(model, workspaceRoot, specsDir);
    const hooksEngine    = new HooksEngine(model, output);
    const steeringLoader = new SteeringLoader();
    const mcpManager     = new McpManager(output);

    // -------------------------------------------------------------------------
    // New subsystems
    // -------------------------------------------------------------------------
    const checkpoints    = new CheckpointManager(output);
    const autopilot      = new AutopilotManager(context);
    const reasoningPanel = new ReasoningPanel(context);
    const bgQueue        = new BackgroundQueue();
    const codebaseIndex  = new CodebaseIndex();
    const bugBot         = new BugBot(model, output);

    // TaskExecutor now receives codebaseIndex for auto-file-selection
    const taskExecutor = workspaceFolder
        ? new TaskExecutor(model, workspaceFolder.uri, codebaseIndex)
        : undefined;

    // ── Model Router ──────────────────────────────────────────────────────────
    const modelRouter = new ModelRouter(context);

    // ── Tool Sandbox + Connector Registry ────────────────────────────────────
    const toolSandbox = new ToolSandbox(workspaceRoot);
    toolSandbox.addDefaultRules();
    const connectorRegistry = new ConnectorRegistry(workspaceRoot, toolSandbox);
    const deploymentHistory = new DeploymentHistoryStore(workspaceRoot);

    // ── Verification Agent ────────────────────────────────────────────────────
    const verificationAgent = new VerificationAgent(model, toolSandbox, output);

    // ── Cloud Background Runner ───────────────────────────────────────────────
    const cloudRunner = new CloudBackgroundRunner();

    // ── SCM Commit Message Provider ───────────────────────────────────────────
    const commitMessageProvider = new CommitMessageProvider(model, steeringLoader);

    // ── Orchestrator ──────────────────────────────────────────────────────────
    const orchestrator = new Orchestrator(
        specsEngine, taskExecutor, verificationAgent,
        checkpoints, reasoningPanel, autopilot, model, output
    );

    // ── Agent Daemon + IPC Client ─────────────────────────────────────────────
    const daemonProcess = new DaemonProcess(context);
    const ipcClient = daemonProcess.client;

    // Wire in-process daemon command handlers using AgentDaemon directly
    const { AgentDaemon: AgentDaemonClass } = require('./daemon/agentDaemon');
    const inProcessDaemon: { on: Function; start: Function; stop: Function } = new AgentDaemonClass();
    inProcessDaemon.on('ping', async (_p: unknown, send: Function) => send({ data: 'pong' }));
    inProcessDaemon.on('spec.create', async (payload: any, send: Function) => {
        const spec = await specsEngine.createFromPrompt(payload.prompt);
        send({ data: spec });
    });
    inProcessDaemon.on('task.run', async (payload: any, send: Function) => {
        const spec = await specsEngine.load(payload.specId);
        const task = spec.tasks?.find((t: any) => t.id === payload.taskId);
        if (!task) { send({ data: { error: 'Task not found' } }); return; }
        const updated = await orchestrator.runTask(spec, task);
        send({ data: updated });
    });
    inProcessDaemon.on('index.rebuild', async (_p: unknown, send: Function) => {
        await codebaseIndex.buildIndex();
        send({ data: { summary: codebaseIndex.getSummary() } });
    });
    inProcessDaemon.start().catch((e: Error) =>
        output.appendLine(`In-process daemon failed to start: ${e.message}`)
    );

    // Start daemon as separate child process
    daemonProcess.ensureRunning().catch(e =>
        output.appendLine(`Agent daemon failed to start: ${e.message}`)
    );

    // -------------------------------------------------------------------------
    // Skills + Powers subsystems
    // -------------------------------------------------------------------------
    const skillLoader  = new SkillLoader();
    const powerManager = new PowerManager(mcpManager, skillLoader, output);

    await skillLoader.loadAll();
    await powerManager.loadFromWorkspace();

    // -------------------------------------------------------------------------
    // Agents + ToolHarness subsystems
    // -------------------------------------------------------------------------
    const toolHarness   = new ToolHarness(output);
    const agentRegistry = new AgentRegistry(output);
    const agentRunner   = new AgentRunner(model, agentRegistry, skillLoader, steeringLoader, toolHarness, output);

    await agentRegistry.loadAll();
    // Watch ~/.kiro/skills and .kiro/skills for changes and reload
    const skillsWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(
            workspaceFolder?.uri ?? vscode.Uri.file(''),
            '.kiro/skills/**/*.{md,skill.md}'
        )
    );
    const reloadSkills = async () => {
        await skillLoader.loadAll();
        skillsTree.refresh();
        output.appendLine('Skills: reloaded.');
    };
    skillsWatcher.onDidCreate(reloadSkills);
    skillsWatcher.onDidChange(reloadSkills);
    skillsWatcher.onDidDelete(reloadSkills);
    context.subscriptions.push(skillsWatcher);

    // Start background index build
    codebaseIndex.buildIndex().then(() => {
        output.appendLine(`Codebase index: ${codebaseIndex.getSummary()}`);
    });
    codebaseIndex.watchWorkspace();

    await hooksEngine.loadFromWorkspace(hooksDir);
    await mcpManager.loadFromSettings();

    // -------------------------------------------------------------------------
    // Tree views (sidebar)
    // -------------------------------------------------------------------------
    const specsTree        = new SpecsTreeProvider(specsEngine);
    const hooksTree        = new HooksTreeProvider();
    const steeringTree     = new SteeringTreeProvider(steeringLoader, steeringDir);
    const mcpTree          = new McpTreeProvider(mcpManager);
    const powersTree       = new PowersTreeProvider(powerManager);
    const skillsTree       = new SkillsTreeProvider(skillLoader);
    const agentsTree       = new AgentsTreeProvider(agentRegistry, context);
    const checkpointsTree  = new CheckpointsTreeProvider(checkpoints);
    const scmTree          = new ScmTreeProvider(workspaceRoot);
    await scmTree.refresh();

    hooksTree.setHooks(hooksEngine.getHooks());
    hooksEngine.onHooksChanged(hooks => hooksTree.setHooks(hooks));

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('forgeide.specsView',       specsTree),
        vscode.window.registerTreeDataProvider('forgeide.hooksView',       hooksTree),
        vscode.window.registerTreeDataProvider('forgeide.steeringView',    steeringTree),
        vscode.window.registerTreeDataProvider('forgeide.mcpView',         mcpTree),
        vscode.window.registerTreeDataProvider('forgeide.powersView',      powersTree),
        vscode.window.registerTreeDataProvider('forgeide.skillsView',      skillsTree),
        vscode.window.registerTreeDataProvider('forgeide.agentsView',      agentsTree),
        vscode.window.registerTreeDataProvider('forgeide.checkpointsView', checkpointsTree),
        vscode.window.registerTreeDataProvider('forgeide.scmView',         scmTree),
        scmTree
    );

    // -------------------------------------------------------------------------
    // UI: model picker status bar + autopilot
    // -------------------------------------------------------------------------
    const modelPicker = new ModelPicker(context);
    autopilot.onModeChanged(mode => modelPicker.update(mode));
    context.subscriptions.push(
        modelPicker,
        modelPicker.registerCommand(),
        autopilot.registerCommand()
    );

    // -------------------------------------------------------------------------
    // Chat participant
    // -------------------------------------------------------------------------
    registerChatParticipant(context, model, specsEngine, steeringLoader, mcpManager, skillLoader, powerManager, bugBot);

    // -------------------------------------------------------------------------
    // Inline completions (Tab ghost-text)
    // -------------------------------------------------------------------------
    if (config.get<boolean>('completion.enabled', true)) {
        context.subscriptions.push(
            ForgeInlineCompletionProvider.register(context, model, specsEngine, steeringLoader)
        );
    }

    // -------------------------------------------------------------------------
    // Cmd-K inline edit
    // -------------------------------------------------------------------------
    const cmdK = new CmdKHandler(model, specsEngine, steeringLoader, autopilot, checkpoints);
    context.subscriptions.push(cmdK.registerCommand(), cmdK.registerQuickCommand());

    context.subscriptions.push(vscode.commands.registerCommand('forgeide.askCodebase', async () => {
        const question = await vscode.window.showInputBox({
            prompt: 'Ask a question about this codebase',
            placeHolder: 'Where is authentication handled and how is it tested?'
        });
        if (!question) return;

        const editorContext = await gatherEditorContext();
        const indexedContext = await codebaseIndex.getEmbeddingContext(question, 8);
        const answer = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'ForgeIDE: asking the codebase...' },
            () => model.complete([
                {
                    role: 'system',
                    content: 'You are a codebase-aware engineering assistant. Answer from the provided context, state uncertainty clearly, and do not invent files or APIs. Do not modify files.'
                },
                {
                    role: 'user',
                    content: `Question: ${question}\n\n` +
                        (editorContext.activeFileSummary ? `Current editor context:\n${editorContext.activeFileSummary}\n\n` : '') +
                        (editorContext.diagnosticsSummary ? `Current diagnostics:\n${editorContext.diagnosticsSummary}\n\n` : '') +
                        (indexedContext || 'No indexed files matched the question.')
                }
            ], { maxTokens: 2048 })
        );
        output.appendLine(`\n[Ask Codebase]\nQ: ${question}\n\n${answer}`);
        output.show();
    }));

    // -------------------------------------------------------------------------
    // Spec webview + IDE shell command
    // -------------------------------------------------------------------------
    const specWebview = new SpecWebview(context, specsEngine);
    context.subscriptions.push(
        specWebview,
        registerIdeShellCommand(context, specWebview)
    );

    // ── Multi-root: reload when workspace folders change ──────────────────────
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(async () => {
            output.appendLine('Workspace folders changed — reloading ForgeIDE subsystems...');
            await hooksEngine.loadFromWorkspace(hooksDir);
            await skillLoader.loadAll();
            await powerManager.loadFromWorkspace();
            await agentRegistry.loadAll();
            await codebaseIndex.buildIndex();
            specsTree.refresh();
            steeringTree.refresh();
            skillsTree.refresh();
            powersTree.refresh();
            agentsTree.refresh();
        })
    );

    // Wire cloud runner handlers
    cloudRunner.register('spec.pipeline', async (task) => {        const { prompt } = task.payload as { prompt: string };
        const indexCtx = await codebaseIndex.getEmbeddingContext(prompt);
        return orchestrator.runFromPrompt(prompt, indexCtx);
    });
    cloudRunner.register('task.implement', async (task) => {
        const { specId, taskId } = task.payload as { specId: string; taskId: string };
        const spec = await specsEngine.load(specId);
        const specTask = spec.tasks?.find(t => t.id === taskId);
        if (!specTask) throw new Error(`Task ${taskId} not found`);
        return orchestrator.runTask(spec, specTask);
    });

    // -------------------------------------------------------------------------
    // Hook: wire onSave/onCreate/onDelete to hooksEngine for commit triggers
    // -------------------------------------------------------------------------
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(() => hooksEngine.fireTrigger('onCommit'))
    );

    // -------------------------------------------------------------------------
    // Commands
    // -------------------------------------------------------------------------
    context.subscriptions.push(

        // --- Spec lifecycle ---
        vscode.commands.registerCommand('forgeide.newSpec', async () => {
            const prompt = await vscode.window.showInputBox({
                prompt: 'Describe the feature you want to build',
                placeHolder: 'Add a review system for products'
            });
            if (!prompt) return;

            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'ForgeIDE: drafting requirements...' },
                async () => {
                    reasoningPanel.start(`New spec: ${prompt}`);
                    reasoningPanel.append('Generating requirements...');
                    const spec = await specsEngine.createFromPrompt(prompt);
                    reasoningPanel.finish(`Requirements drafted (${spec.requirementsCheck?.valid}/${spec.requirementsCheck?.total} EARS criteria valid)`);
                    specsTree.refresh();
                    // Open webview immediately so user can review + approve
                    await specWebview.open(spec.id);
                }
            );
        }),

        vscode.commands.registerCommand('forgeide.approveRequirements', async () => {
            const specs = await specsEngine.listAll();
            const pending = specs.filter(s => !s.requirementsApproved);
            if (!pending.length) { vscode.window.showInformationMessage('No specs pending requirements approval.'); return; }
            const pick = await vscode.window.showQuickPick(
                pending.map(s => ({ label: s.title, description: s.stage, spec: s })),
                { placeHolder: 'Approve requirements for which spec?' }
            );
            if (!pick) return;
            await specsEngine.approveRequirements(pick.spec);
            specsTree.refresh();
            vscode.window.showInformationMessage(`Requirements approved for "${pick.spec.title}".`);
        }),

        vscode.commands.registerCommand('forgeide.approveDesign', async () => {
            const specs = await specsEngine.listAll();
            const pending = specs.filter(s => s.requirementsApproved && !s.designApproved);
            if (!pending.length) { vscode.window.showInformationMessage('No specs pending design approval.'); return; }
            const pick = await vscode.window.showQuickPick(
                pending.map(s => ({ label: s.title, description: s.stage, spec: s })),
                { placeHolder: 'Approve design for which spec?' }
            );
            if (!pick) return;

            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'ForgeIDE: generating design...' },
                async () => {
                    reasoningPanel.start(`Design: ${pick.spec.title}`);
                    const indexCtx = await codebaseIndex.getEmbeddingContext(pick.spec.prompt);
                    reasoningPanel.append(`Codebase context: ${indexCtx || '(none)'}`);
                    const updated = await specsEngine.advanceToDesign(pick.spec, indexCtx);
                    await specsEngine.approveDesign(updated);
                    reasoningPanel.finish('Design generated and approved.');
                    specsTree.refresh();
                }
            );
        }),

        vscode.commands.registerCommand('forgeide.approveTasks', async () => {
            const specs = await specsEngine.listAll();
            const pending = specs.filter(s => s.designApproved && !s.tasksApproved);
            if (!pending.length) { vscode.window.showInformationMessage('No specs pending task approval.'); return; }
            const pick = await vscode.window.showQuickPick(
                pending.map(s => ({ label: s.title, description: s.stage, spec: s })),
                { placeHolder: 'Approve tasks for which spec?' }
            );
            if (!pick) return;

            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'ForgeIDE: generating tasks...' },
                async () => {
                    const withTasks = await specsEngine.advanceToTasks(pick.spec);
                    await specsEngine.approveTasks(withTasks);
                    specsTree.refresh();
                    vscode.window.showInformationMessage(
                        `Tasks approved for "${pick.spec.title}" — code generation unlocked.`
                    );
                }
            );
        }),

        // Legacy combined-stage approval (kept for backward compat)
        vscode.commands.registerCommand('forgeide.approveSpecStage', async () => {
            const specs = await specsEngine.listAll();
            const pending = specs.filter(s => !s.requirementsApproved || !s.designApproved || !s.tasksApproved);
            if (!pending.length) { vscode.window.showInformationMessage('No specs waiting for approval.'); return; }
            const pick = await vscode.window.showQuickPick(
                pending.map(s => ({ label: s.title, description: s.stage, spec: s })),
                { placeHolder: 'Advance which spec?' }
            );
            if (!pick) return;
            await vscode.commands.executeCommand(
                !pick.spec.requirementsApproved ? 'forgeide.approveRequirements'
                : !pick.spec.designApproved ? 'forgeide.approveDesign'
                : 'forgeide.approveTasks'
            );
        }),

        vscode.commands.registerCommand('forgeide.openSpecWebview', async (specId?: string) => {
            if (!specId) {
                const specs = await specsEngine.listAll();
                if (!specs.length) { vscode.window.showInformationMessage('No specs yet.'); return; }
                const pick = await vscode.window.showQuickPick(
                    specs.map(s => ({ label: s.title, description: s.stage, id: s.id }))
                );
                if (!pick) return;
                specId = pick.id;
            }
            await specWebview.open(specId);
        }),
        // --- Task implementation ---
        vscode.commands.registerCommand('forgeide.implementTask', async (specId?: string, taskId?: string) => {
            if (!taskExecutor) { vscode.window.showErrorMessage('Open a workspace folder before implementing tasks.'); return; }
            if (!specId || !taskId) return;

            const spec = await specsEngine.load(specId);
            const task = spec.tasks?.find(t => t.id === taskId);
            if (!task) return;

            // --- Gate check ---
            const gate = specsEngine.canGenerateCode(spec, taskId);
            if (!gate.allowed) {
                vscode.window.showErrorMessage(`ForgeIDE blocked: ${gate.reason}`);
                return;
            }

            await specsEngine.markTaskStatus(spec, taskId, 'in_progress');
            specsTree.refresh();

            // Enqueue as a background task
            bgQueue.enqueue(`Implement: ${task.title}`, async (token) => {
                try {
                    // Gather relevant files via codebase index
                    reasoningPanel.start(`Implementing: ${task.title}`, true);
                    reasoningPanel.append(`Searching codebase for context...`);
                    const indexCtx = await codebaseIndex.getEmbeddingContext(task.title + ' ' + task.detail);
                    reasoningPanel.append(indexCtx || 'No matching files found in index.');

                    // Create checkpoint before writing
                    await checkpoints.create(`before: ${task.title}`);

                    if (token.isCancellationRequested) return;

                    const outcomes = await taskExecutor.execute(spec, task, []);

                    reasoningPanel.finish(`Task complete: ${outcomes.map(o => o.path).join(', ')}`);
                    const allApplied = outcomes.every(o => o.result === 'applied' || o.result === 'unchanged');
                    await specsEngine.markTaskStatus(spec, taskId, allApplied ? 'done' : 'pending');
                    specsTree.refresh();
                    vscode.window.showInformationMessage(
                        `Task "${task.title}": ${outcomes.map(o => `${o.path} (${o.result})`).join(', ') || 'no files proposed'}`
                    );
                } catch (e) {
                    await specsEngine.markTaskStatus(spec, taskId, 'pending');
                    specsTree.refresh();
                    throw e;
                }
            });
        }),

        // --- Hooks ---
        vscode.commands.registerCommand('forgeide.addHook', async () => {
            const id = await vscode.window.showInputBox({ prompt: 'Hook id (e.g. update-tests-on-save)' });
            if (!id) return;
            const on = await vscode.window.showQuickPick(
                ['save', 'create', 'delete', 'manual', 'preCommit', 'onCommit', 'onPrOpen'],
                { placeHolder: 'When should this hook run?' }
            ) as HookDefinition['on'] | undefined;
            if (!on) return;
            const glob = await vscode.window.showInputBox({ prompt: 'File glob to watch', value: 'src/**/*.ts' });
            const actionMode = await vscode.window.showQuickPick(
                ['AI edit — model rewrites the file', 'Shell command — run a terminal command'],
                { placeHolder: 'What kind of action?' }
            );
            if (!actionMode || !glob) return;
            let action: string;
            if (actionMode.startsWith('Shell')) {
                const cmd = await vscode.window.showInputBox({ prompt: 'Shell command', value: 'npm test' });
                if (!cmd) return;
                action = `shell:${cmd}`;
            } else {
                const ai = await vscode.window.showInputBox({
                    prompt: 'What should the agent do?',
                    value: 'Update the matching test file to cover any new exported functions.'
                });
                if (!ai) return;
                action = ai;
            }

            if (!workspaceFolder) return;
            const hookUri = vscode.Uri.joinPath(workspaceFolder.uri, hooksDir, `${id}.json`);
            const definition: HookDefinition = { id, on, trigger: on, glob, action, enabled: true, actions: [], match: glob ? [glob] : [] };
            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(workspaceFolder.uri, hooksDir));
            await vscode.workspace.fs.writeFile(hookUri, Buffer.from(JSON.stringify(definition, null, 2)));
            await hooksEngine.loadFromWorkspace(hooksDir);
            vscode.window.showInformationMessage(`Hook "${id}" created.`);
        }),

        vscode.commands.registerCommand('forgeide.toggleHook', async (hook: HookDefinition) => {
            await hooksEngine.toggle(hook.id, hooksDir);
        }),

        vscode.commands.registerCommand('forgeide.runPreCommitHooks', async () => {
            const results = await hooksEngine.runPreCommitHooks();
            output.appendLine(`Pre-commit hooks: ${JSON.stringify(results, null, 2)}`);
        }),

        // --- Steering ---
        vscode.commands.registerCommand('forgeide.reloadSteering', async () => {
            steeringTree.refresh();
            const text = await steeringLoader.load(steeringDir);
            vscode.window.showInformationMessage(
                text ? 'Steering context reloaded.' : `No steering files found in ${steeringDir}`
            );
        }),

        // --- Skills ---
        vscode.commands.registerCommand('forgeide.reloadSkills', async () => {
            await skillLoader.loadAll();
            skillsTree.refresh();
            const all = skillLoader.getAllSkills();
            const gCount = skillLoader.getByScope('global').length;
            const wCount = skillLoader.getByScope('workspace').length;
            vscode.window.showInformationMessage(
                all.length
                    ? `Skills reloaded: ${wCount} workspace, ${gCount} global.`
                    : 'No skills found in ~/.kiro/skills or .kiro/skills.'
            );
        }),

        vscode.commands.registerCommand('forgeide.openSkill', async (filePath?: string) => {
            if (!filePath) return;
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
            await vscode.window.showTextDocument(doc);
        }),

        // --- MCP ---
        vscode.commands.registerCommand('forgeide.mcpConnect', async () => {
            const name = await vscode.window.showInputBox({ prompt: 'MCP server name' });
            if (!name) return;
            const transport = await vscode.window.showQuickPick(['stdio', 'sse'], { placeHolder: 'Transport' });
            if (!transport) return;
            if (transport === 'stdio') {
                const command = await vscode.window.showInputBox({ prompt: 'Command', value: 'npx' });
                const argsRaw = await vscode.window.showInputBox({ prompt: 'Args (space-separated)', value: '-y @modelcontextprotocol/server-github' });
                if (!command) return;
                await mcpManager.connect({ name, transport: 'stdio', command, args: (argsRaw ?? '').split(' ').filter(Boolean) });
            } else {
                const url = await vscode.window.showInputBox({ prompt: 'SSE URL' });
                if (!url) return;
                await mcpManager.connect({ name, transport: 'sse', url });
            }
        }),

        vscode.commands.registerCommand('forgeide.mcpDisconnect', async (row: { name: string }) => {
            await mcpManager.disconnect(row.name);
        }),

        // --- Checkpoints ---
        vscode.commands.registerCommand('forgeide.restoreCheckpoint', async () => {
            const list = checkpoints.list();
            if (!list.length) { vscode.window.showInformationMessage('No checkpoints yet.'); return; }
            const pick = await vscode.window.showQuickPick(
                list.map(c => ({
                    label: c.label,
                    description: `${c.fileCount} file(s) · ${new Date(c.createdAt).toLocaleTimeString()}`,
                    id: c.id
                })),
                { placeHolder: 'Restore which checkpoint?' }
            );
            if (!pick) return;
            await checkpoints.restore(pick.id);
        }),

        // --- Background tasks ---
        vscode.commands.registerCommand('forgeide.showBackgroundTasks', () => {
            const tasks = bgQueue.allTasks();
            if (!tasks.length) { vscode.window.showInformationMessage('No background tasks.'); return; }
            output.appendLine('\nBackground Tasks:\n' + tasks.map(t =>
                `  [${t.status}] ${t.label}`
            ).join('\n'));
            output.show();
        }),

        // --- SCM commit message ---
        vscode.commands.registerCommand('forgeide.generateCommitMessage', () =>
            commitMessageProvider.generateAndFill()
        ),

        vscode.commands.registerCommand('forgeide.refreshScm', async () => {
            await scmTree.refresh();
            vscode.window.showInformationMessage(`ForgeIDE: ${scmTree.getChildren().length} changed file(s).`);
        }),

        vscode.commands.registerCommand('forgeide.openScmFile', async (change: { path?: string }) => {
            if (!change?.path) return;
            const uri = vscode.Uri.joinPath(vscode.Uri.file(workspaceRoot), change.path);
            const document = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(document, { preview: true });
        }),

        vscode.commands.registerCommand('forgeide.gitStage', async (change: { path?: string }) => {
            if (!change?.path || !await confirmShellCommand(`git add -- ${change.path}`)) return;
            const result = await runGit(['add', '--', change.path]);
            await scmTree.refresh();
            showGitResult(`Git stage ${change.path}`, result);
        }),

        vscode.commands.registerCommand('forgeide.gitUnstage', async (change: { path?: string }) => {
            if (!change?.path || !await confirmShellCommand(`git reset HEAD -- ${change.path}`)) return;
            const result = await runGit(['reset', 'HEAD', '--', change.path]);
            await scmTree.refresh();
            showGitResult(`Git unstage ${change.path}`, result);
        }),

        vscode.commands.registerCommand('forgeide.gitCommit', async () => {
            const message = await vscode.window.showInputBox({ prompt: 'Commit message', placeHolder: 'feat: add database health checks' });
            if (!message || !await confirmShellCommand(`git commit -m "${message}"`)) return;
            const result = await runGit(['commit', '-m', message]);
            await scmTree.refresh();
            showGitResult('Git commit', result);
        }),

        vscode.commands.registerCommand('forgeide.gitPull', async () => {
            if (!await confirmShellCommand('git pull')) return;
            showGitResult('Git pull', await runGit(['pull']));
            await scmTree.refresh();
        }),

        vscode.commands.registerCommand('forgeide.gitPush', async () => {
            if (!await confirmShellCommand('git push')) return;
            showGitResult('Git push', await runGit(['push']));
            await scmTree.refresh();
        }),

        vscode.commands.registerCommand('forgeide.githubCreatePr', async () => {
            const title = await vscode.window.showInputBox({ prompt: 'Pull request title' });
            if (!title) return;
            const body = await vscode.window.showInputBox({ prompt: 'Pull request description' }) ?? '';
            const command = `gh pr create --title "${title}" --body "${body}"`;
            if (!await confirmShellCommand(command)) return;
            const result = await toolSandbox.run('gh', ['pr', 'create', '--title', title, '--body', body], workspaceRoot);
            showGitResult('GitHub pull request', result);
        }),

        vscode.commands.registerCommand('forgeide.showProblems', async () => {
            const problems = vscode.languages.getDiagnostics()
                .flatMap(([uri, diagnostics]) => diagnostics.map(diagnostic => ({ uri, diagnostic })))
                .sort((a, b) => a.uri.fsPath.localeCompare(b.uri.fsPath) ||
                    a.diagnostic.range.start.line - b.diagnostic.range.start.line);

            if (!problems.length) {
                vscode.window.showInformationMessage('ForgeIDE: No workspace problems found.');
                return;
            }

            const pick = await vscode.window.showQuickPick(problems.map(problem => ({
                label: `${problem.uri.fsPath.split(/[\\/]/).pop() ?? problem.uri.fsPath}:${problem.diagnostic.range.start.line + 1}`,
                description: problem.diagnostic.message,
                detail: vscode.DiagnosticSeverity[problem.diagnostic.severity],
                problem
            })), {
                title: `ForgeIDE problems (${problems.length})`,
                matchOnDescription: true,
                matchOnDetail: true,
                placeHolder: 'Choose a problem to open'
            });

            if (!pick) return;
            const document = await vscode.workspace.openTextDocument(pick.problem.uri);
            const editor = await vscode.window.showTextDocument(document, { preview: true });
            const position = pick.problem.diagnostic.range.start;
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(pick.problem.diagnostic.range, vscode.TextEditorRevealType.InCenter);
        }),

        vscode.commands.registerCommand('forgeide.runTests', async () => {
            const command = await vscode.window.showInputBox({
                prompt: 'Test command to run',
                value: config.get<string>('testing.command', 'npm test'),
                placeHolder: 'npm test, pytest, cargo test, or go test ./...'
            });
            if (!command) return;

            const result = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `ForgeIDE: running ${command}...` },
                () => toolHarness.runToCompletion(command, workspaceRoot, config.get<number>('testing.timeoutMs', 120000))
            );
            output.appendLine(`\n[Test command] ${command}\n${result.stdout}${result.stderr}`);
            output.show();
            if (result.exitCode === 0) {
                vscode.window.showInformationMessage('ForgeIDE: Tests passed.');
            } else {
                vscode.window.showErrorMessage(`ForgeIDE: Tests failed with exit code ${result.exitCode}.`);
            }
        }),

        // --- Codebase index ---
        vscode.commands.registerCommand('forgeide.rebuildIndex', async () => {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'ForgeIDE: rebuilding codebase index...' },
                () => codebaseIndex.buildIndex()
            );
            vscode.window.showInformationMessage(`Codebase index: ${codebaseIndex.getSummary()}`);
        }),

        vscode.commands.registerCommand('forgeide.searchWorkspace', async () => {
            const query = await vscode.window.showInputBox({
                prompt: 'Search this workspace',
                placeHolder: 'login auth user'
            });
            if (!query) return;

            const hits = await searchWorkspaceMatches(query, 25);
            const items = buildSearchQuickPickItems(query, hits);
            const pick = await vscode.window.showQuickPick(items
                .filter((item): item is { label: string; description: string; path: string; line: number } => !!item.path && typeof item.line === 'number')
                .map(item => ({
                    label: item.label,
                    description: item.description,
                    detail: 'Open file',
                    path: item.path as string,
                    line: item.line as number
                })), {
                title: `ForgeIDE search: "${query}"`,
                matchOnDescription: true,
                matchOnDetail: true,
                placeHolder: hits.length ? 'Choose a match to open' : 'No results'
            });

            if (!pick || !pick.path) return;
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(''), pick.path));
            const editor = await vscode.window.showTextDocument(doc, { preview: true });
            const line = Math.max(0, (pick.line ?? 1) - 1);
            const pos = new vscode.Position(line, 0);
            editor.selection = new vscode.Selection(pos, pos);
            editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        }),

        vscode.commands.registerCommand('forgeide.gotoSymbol', async () => {
            const query = await vscode.window.showInputBox({
                prompt: 'Go to symbol',
                placeHolder: 'UserService or createUser'
            });
            if (!query) return;

            const symbols = await codebaseIndex.findSymbols(query, 30);
            if (!symbols.length) {
                vscode.window.showInformationMessage(`No symbols matching "${query}" found.`);
                return;
            }

            const pick = await vscode.window.showQuickPick(symbols.map(symbol => ({
                label: symbol.symbol,
                description: symbol.path,
                path: symbol.path,
                score: symbol.score
            })), {
                title: `ForgeIDE symbols: "${query}"`,
                placeHolder: 'Choose a symbol to navigate'
            });

            if (!pick || !pick.path) return;
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(''), pick.path));
            const editor = await vscode.window.showTextDocument(doc, { preview: true });
            const text = doc.getText();
            const idx = text.indexOf(pick.label);
            const line = idx >= 0 ? text.slice(0, idx).split('\n').length - 1 : 0;
            const pos = new vscode.Position(line, 0);
            editor.selection = new vscode.Selection(pos, pos);
            editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        }),

        // --- Powers ---
        vscode.commands.registerCommand('forgeide.scaffoldPower', () => PowerBuilder.scaffold()),

        vscode.commands.registerCommand('forgeide.convertPowerMd', (uri?: vscode.Uri) =>
            PowerBuilder.convertPowerMd(uri)
        ),

        vscode.commands.registerCommand('forgeide.installPower', async () => {
            const picked = await vscode.window.showOpenDialog({
                canSelectFolders: true,
                canSelectFiles: false,
                openLabel: 'Install Power from Directory'
            });
            if (!picked?.length) return;
            await powerManager.install(picked[0].fsPath);
        }),

        vscode.commands.registerCommand('forgeide.activatePower', async (item?: { power?: { manifest?: { id?: string } } }) => {
            const id = item?.power?.manifest?.id ?? await pickPowerId('Activate which power?');
            if (id) await powerManager.activate(id);
        }),

        vscode.commands.registerCommand('forgeide.deactivatePower', async (item?: { power?: { manifest?: { id?: string } } }) => {
            const id = item?.power?.manifest?.id ?? await pickPowerId('Deactivate which power?');
            if (id) await powerManager.deactivate(id);
        }),

        vscode.commands.registerCommand('forgeide.uninstallPower', async (item?: { power?: { manifest?: { id?: string } } }) => {
            const id = item?.power?.manifest?.id ?? await pickPowerId('Uninstall which power?');
            if (!id) return;
            const confirm = await vscode.window.showWarningMessage(
                `Uninstall power "${id}"? This will delete its directory.`,
                { modal: true }, 'Uninstall'
            );
            if (confirm === 'Uninstall') await powerManager.uninstall(id);
        }),

        // --- Skills ---
        vscode.commands.registerCommand('forgeide.openSkill', async (filePath?: string) => {
            if (!filePath) return;
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
            await vscode.window.showTextDocument(doc);
        }),

        vscode.commands.registerCommand('forgeide.reloadSkills', async () => {
            await skillLoader.loadAll();
            skillsTree.refresh();
            vscode.window.showInformationMessage('ForgeIDE: Skills reloaded.');
        }),

        // --- Agents ---
        vscode.commands.registerCommand('forgeide.scaffoldAgent', () => agentRegistry.scaffold()),

        vscode.commands.registerCommand('forgeide.openAgent', async (filePath?: string) => {
            if (!filePath) return;
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
            await vscode.window.showTextDocument(doc);
        }),

        vscode.commands.registerCommand('forgeide.setActiveAgent', async (item?: { agent?: { id?: string } }) => {
            const id = item?.agent?.id ?? await pickAgentId(agentRegistry);
            if (!id) return;
            await agentRegistry.setActive(context, id);
            agentsTree.refresh();
            vscode.window.showInformationMessage(`ForgeIDE: Active agent set to "${id}".`);
        }),

        vscode.commands.registerCommand('forgeide.reloadAgents', async () => {
            await agentRegistry.loadAll();
            agentsTree.refresh();
            vscode.window.showInformationMessage('ForgeIDE: Agents reloaded.');
        }),

        vscode.commands.registerCommand('forgeide.runAgent', async () => {
            const editor = vscode.window.activeTextEditor;
            const selection = editor?.document.getText(editor.selection);
            const prompt = await vscode.window.showInputBox({
                prompt: 'Prompt for the active agent',
                placeHolder: 'Refactor this to use async/await',
                value: selection ? `Apply to the following code:\n\`\`\`\n${selection}\n\`\`\`` : ''
            });
            if (!prompt) return;

            const agent = agentRegistry.getActive(context);
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `ForgeIDE: Running agent "${agent.name}"...` },
                async () => {
                    reasoningPanel.start(`${agent.name}: ${prompt.slice(0, 60)}`);
                    try {
                        const result = await agentRunner.run(agent, {
                            prompt,
                            extraContext: editor ? `Active file: ${editor.document.fileName}` : undefined,
                            onToken: tok => reasoningPanel.append(tok)
                        });
                        reasoningPanel.finish(`Done in ${result.durationMs}ms.`);
                        output.appendLine('\n' + result.response);
                        output.show();
                    } catch (e) {
                        reasoningPanel.finish(`Error: ${e}`);
                        throw e;
                    }
                }
            );
        }),

        // --- Tool Harness (process management) ---
        vscode.commands.registerCommand('forgeide.startProcess', async () => {
            const command = await vscode.window.showInputBox({
                prompt: 'Command to run in background',
                placeHolder: 'npm run dev'
            });
            if (!command || !await confirmShellCommand(command)) return;
            const { terminalId, isReused } = toolHarness.startProcess(command);
            vscode.window.showInformationMessage(
                `ForgeIDE: process ${isReused ? 'reused' : 'started'} [${terminalId}]`
            );
        }),

        vscode.commands.registerCommand('forgeide.stopProcess', async () => {
            const procs = toolHarness.listProcesses().filter(p => p.status === 'running');
            if (!procs.length) { vscode.window.showInformationMessage('No running processes.'); return; }
            const pick = await vscode.window.showQuickPick(
                procs.map(p => ({ label: p.command, description: p.terminalId, id: p.terminalId })),
                { placeHolder: 'Stop which process?' }
            );
            if (!pick) return;
            const result = toolHarness.stopProcess(pick.id);
            vscode.window.showInformationMessage(`ForgeIDE: ${result.message}`);
        }),

        vscode.commands.registerCommand('forgeide.listProcesses', () => {
            const procs = toolHarness.listProcesses();
            if (!procs.length) { vscode.window.showInformationMessage('No managed processes.'); return; }
            output.appendLine('\nManaged Processes:\n' + procs.map(p =>
                `  [${p.status}] ${p.command} (${p.terminalId})`
            ).join('\n'));
            output.show();
        }),

        vscode.commands.registerCommand('forgeide.openTerminal', async () => {
            const command = await vscode.window.showInputBox({
                prompt: 'Optional command to run in the integrated terminal',
                placeHolder: 'npm run dev'
            });
            if (command === undefined) return;
            if (command && !await confirmShellCommand(command)) return;
            toolHarness.openTerminal(command, workspaceFolder?.uri.fsPath, 'ForgeIDE Terminal');
        }),

        vscode.commands.registerCommand('forgeide.runTask', async () => {
            const command = await vscode.window.showInputBox({
                prompt: 'Command to run as a workspace task',
                placeHolder: 'npm test'
            });
            if (!command) return;
            if (!await confirmShellCommand(command)) return;

            const task = new vscode.Task(
                { type: 'forgeide', command },
                vscode.TaskScope.Workspace,
                'ForgeIDE Task',
                'ForgeIDE',
                new vscode.ShellExecution(command),
                '$tsc'
            );
            await vscode.tasks.executeTask(task);
            if (!await confirmShellCommand(command)) return;
        }),

        // --- Orchestrator / Pipeline ---
        vscode.commands.registerCommand('forgeide.runPipeline', async () => {
            const prompt = await vscode.window.showInputBox({
                prompt: 'Describe the feature — full pipeline (requirements → design → tasks → implement → verify)',
                placeHolder: 'Add user authentication with JWT'
            });
            if (!prompt) return;
            cloudRunner.enqueue(`Pipeline: ${prompt}`, 'spec.pipeline', { prompt }, undefined);
            vscode.window.showInformationMessage(`ForgeIDE: Pipeline queued for "${prompt}".`);
        }),

        // --- Connector commands ---
        vscode.commands.registerCommand('forgeide.connector.detect', async () => {
            const detected = await connectorRegistry.detectAll();
            if (!detected.length) {
                vscode.window.showInformationMessage('No IaC connectors detected in workspace (CDK, SAM, Terraform, Pulumi).');
                return;
            }
            vscode.window.showInformationMessage(`Detected: ${detected.map(c => c.name).join(', ')}`);
        }),

        vscode.commands.registerCommand('forgeide.connector.plan', async () => {
            const detected = await connectorRegistry.detectAll();
            if (!detected.length) { vscode.window.showInformationMessage('No IaC connectors found.'); return; }
            const pick = await vscode.window.showQuickPick(
                detected.map(c => ({ label: c.name, description: c.type, type: c.type }))
            );
            if (!pick) return;
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `ForgeIDE: ${pick.label} plan...` },
                async () => {
                    const result = await connectorRegistry.run(pick.type, 'plan');
                    output.appendLine(`\n[${pick.label} plan]\n${result.output}`);
                    output.show();
                    if (!result.success) vscode.window.showErrorMessage(`Plan failed: ${result.error}`);
                }
            );
        }),

        vscode.commands.registerCommand('forgeide.connector.deploy', async () => {
            const detected = await connectorRegistry.detectAll();
            if (!detected.length) { vscode.window.showInformationMessage('No IaC connectors found.'); return; }
            const pick = await vscode.window.showQuickPick(
                detected.map(c => ({ label: c.name, description: c.type, type: c.type }))
            );
            if (!pick) return;
            const confirm = await vscode.window.showWarningMessage(
                `Deploy with ${pick.label}? This writes to your cloud account.`,
                { modal: true }, 'Deploy'
            );
            if (confirm !== 'Deploy') return;
            const startedAt = new Date().toISOString();
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `ForgeIDE: ${pick.label} deploy...` },
                async () => {
                    const result = await connectorRegistry.run(pick.type, 'deploy');
                    await deploymentHistory.record({
                        connector: pick.label,
                        success: result.success,
                        startedAt,
                        completedAt: new Date().toISOString()
                    });
                    output.appendLine(`\n[${pick.label} deploy]\n${result.output}`);
                    output.show();
                    if (result.success) vscode.window.showInformationMessage(`${pick.label} deploy complete.`);
                    else vscode.window.showErrorMessage(`Deploy failed: ${result.error}`);
                }
            );
        }),

        vscode.commands.registerCommand('forgeide.deploymentHistory', async () => {
            const records = await deploymentHistory.list();
            output.appendLine(`\nDeployment History\n${formatDeploymentHistory(records)}`);
            output.show();
        }),

        vscode.commands.registerCommand('forgeide.checkDeployment', async () => {
            const url = await vscode.window.showInputBox({
                prompt: 'Deployment health URL',
                placeHolder: 'https://your-app.example.com/health'
            });
            if (!url) return;
            const result = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'ForgeIDE: checking deployment health...' },
                () => checkDeploymentHealth(url)
            );
            output.appendLine(`\n[Deployment health] ${result.url}\n` +
                `status=${result.statusCode ?? 'unreachable'} latency=${result.latencyMs}ms` +
                (result.error ? ` error=${result.error}` : ''));
            output.show();
            if (result.ok) vscode.window.showInformationMessage(`ForgeIDE: Deployment healthy (${result.statusCode}).`);
            else vscode.window.showErrorMessage(`ForgeIDE: Deployment health check failed${result.statusCode ? ` (${result.statusCode})` : ''}.`);
        }),

        vscode.commands.registerCommand('forgeide.release', async () => {
            const environment = await inspectEnvironment();
            const connectors = await connectorRegistry.detectAll();
            if (!connectors.length) {
                vscode.window.showErrorMessage('ForgeIDE: Release blocked because no infrastructure connector was detected.');
                return;
            }

            const packageManager = environment.packageManager === 'unknown' ? 'npm' : environment.packageManager;
            const testScript = environment.scripts.find(script => /^test(:|$)/i.test(script));
            const buildCommand = environment.scripts.includes('build') ? `${packageManager} run build` : undefined;
            const testCommand = testScript ? `${packageManager} run ${testScript}` : undefined;
            const connector = connectors.length === 1
                ? connectors[0]
                : await vscode.window.showQuickPick(
                    connectors.map(item => ({ label: item.name, description: item.type, item })),
                    { placeHolder: 'Choose the infrastructure connector for this release' }
                ).then(pick => pick?.item);
            if (!connector) return;

            const runReleaseCommand = async (label: string, command: string, args: string[]): Promise<boolean> => {
                if (!await confirmShellCommand([command, ...args].join(' '))) return false;
                const result = await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: `ForgeIDE: ${label}...` },
                    () => toolSandbox.run(command, args, workspaceRoot)
                );
                output.appendLine(`\n[Release ${label}]\n${result.output ?? result.error ?? ''}`);
                output.show();
                if (!result.ok) vscode.window.showErrorMessage(`ForgeIDE: Release blocked by ${label}.`);
                return result.ok;
            };

            if (buildCommand) {
                const buildArgs = ['run', 'build'];
                if (!await runReleaseCommand('build', packageManager, buildArgs)) return;
            }
            if (testScript) {
                if (!await runReleaseCommand('tests', packageManager, ['run', testScript])) return;
            }

            const planApproval = await vscode.window.showWarningMessage(
                `Run ${connector.name} infrastructure plan before release?`,
                { modal: true },
                'Run Plan'
            );
            if (planApproval !== 'Run Plan') return;
            const planResult = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `ForgeIDE: ${connector.name} plan...` },
                () => connectorRegistry.run(connector.type, 'plan')
            );
            output.appendLine(`\n[Release infrastructure plan]\n${planResult.output}`);
            output.show();
            if (!planResult.success) {
                vscode.window.showErrorMessage(`ForgeIDE: Release blocked by ${connector.name} plan.`);
                return;
            }

            const deployApproval = await vscode.window.showWarningMessage(
                `Deploy this release with ${connector.name}? This changes cloud infrastructure.`,
                { modal: true },
                'Deploy Release'
            );
            if (deployApproval !== 'Deploy Release') return;
            const startedAt = new Date().toISOString();
            const deployResult = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `ForgeIDE: deploying with ${connector.name}...` },
                () => connectorRegistry.run(connector.type, 'deploy')
            );
            await deploymentHistory.record({
                connector: connector.name,
                success: deployResult.success,
                startedAt,
                completedAt: new Date().toISOString()
            });
            output.appendLine(`\n[Release deployment]\n${deployResult.output}`);
            output.show();
            if (!deployResult.success) {
                vscode.window.showErrorMessage(`ForgeIDE: Release deployment failed: ${deployResult.error ?? 'unknown error'}`);
                return;
            }

            const healthUrl = await vscode.window.showInputBox({
                prompt: 'Optional deployment health URL',
                placeHolder: 'https://your-app.example.com/health'
            });
            if (healthUrl) {
                const health = await checkDeploymentHealth(healthUrl);
                output.appendLine(`\n[Release health]\nstatus=${health.statusCode ?? 'unreachable'} latency=${health.latencyMs}ms${health.error ? ` error=${health.error}` : ''}`);
                output.show();
                if (!health.ok) vscode.window.showWarningMessage('ForgeIDE: Release deployed, but health verification failed.');
            }
            vscode.window.showInformationMessage(`ForgeIDE: ${connector.name} release completed.`);
        }),

        // --- Model router stats ---

        vscode.commands.registerCommand('forgeide.inspectEnvironment', async () => {
            const environment = await inspectEnvironment();
            output.appendLine(`\nProject Environment\n${JSON.stringify(environment, null, 2)}`);
            output.show();
        }),

        vscode.commands.registerCommand('forgeide.databasePlan', async () => {
            const environment = await inspectEnvironment();
            const plan = createDatabasePlan(environment);
            output.appendLine(`\nDatabase Plan\n${plan.map((step, index) => `${index + 1}. ${step}`).join('\n')}`);
            output.show();
        }),

        vscode.commands.registerCommand('forgeide.generateDatabaseEnv', async () => {
            const environment = await inspectEnvironment();
            const uri = vscode.Uri.joinPath(vscode.Uri.file(workspaceRoot), '.env.example');
            await proposeAndApply({
                uri,
                newContent: createDatabaseEnvExample(environment),
                title: 'ForgeIDE: Database environment template'
            });
        }),

        vscode.commands.registerCommand('forgeide.databaseMigrate', async () => {
            const environment = await inspectEnvironment();
            const migration = detectMigrationCommand(environment);
            if (!migration) {
                vscode.window.showInformationMessage('ForgeIDE: No supported database migration command detected.');
                return;
            }
            const confirm = await vscode.window.showWarningMessage(
                `Run database migration?\n\n${migration.description}\n\nBack up production data and verify the target environment first.`,
                { modal: true },
                'Run Migration'
            );
            if (confirm !== 'Run Migration') return;
            const result = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `ForgeIDE: running ${migration.description}...` },
                () => toolSandbox.run(migration.command, migration.args, workspaceRoot)
            );
            output.appendLine(`\n[Database migration] ${migration.description}\n${result.output ?? result.error ?? ''}`);
            output.show();
            if (result.ok) vscode.window.showInformationMessage('ForgeIDE: Database migration completed.');
            else vscode.window.showErrorMessage(`ForgeIDE: Database migration failed: ${result.error ?? 'unknown error'}`);
        }),

        vscode.commands.registerCommand('forgeide.deploymentPreflight', async () => {
            const environment = await inspectEnvironment();
            const connectors = await connectorRegistry.detectAll();
            const plan = createDeploymentPlan(environment, connectors.map(connector => connector.name));
            output.appendLine(`\nDeployment Preflight\n${plan.map((step, index) => `${index + 1}. ${step}`).join('\n')}`);
            output.show();
        }),
        vscode.commands.registerCommand('forgeide.routerStats', () => {
            const stats = modelRouter.getStats();
            const lines = stats.map(s =>
                `  ${s.modelId}: ${s.requests} requests, ${s.errors} errors, ${s.avgLatencyMs}ms avg`
            );
            output.appendLine('\nModel Router Stats:\n' + lines.join('\n'));
            output.show();
        }),

        // --- IPC daemon ---
        vscode.commands.registerCommand('forgeide.daemonPing', async () => {
            const ok = await ipcClient.ping();
            vscode.window.showInformationMessage(ok ? 'Agent daemon: running ✓' : 'Agent daemon: not reachable');
        }),

        // --- Cloud background runner ---
        vscode.commands.registerCommand('forgeide.showCloudTasks', () => {
            const tasks = cloudRunner.list();
            if (!tasks.length) { vscode.window.showInformationMessage('No cloud background tasks.'); return; }
            output.appendLine('\nCloud Background Tasks:\n' + tasks.map(t =>
                `  [${t.status}] ${t.label}`
            ).join('\n'));
            output.show();
        }),

        // --- Disposables ---
        hooksEngine,
        mcpManager,
        powerManager,
        agentRegistry,
        toolHarness,
        codebaseIndex,
        bgQueue,
        reasoningPanel,
        specWebview,
        cloudRunner,
        commitMessageProvider,
        { dispose: () => daemonProcess.stop() },
        { dispose: () => ipcClient.disconnect() },
        skillsWatcher
    );

    output.appendLine('ForgeIDE activated.');
    output.appendLine(`  Mode: ${autopilot.getMode()}`);
    output.appendLine(`  Specs dir: ${specsDir}`);
    output.appendLine(`  Hooks dir: ${hooksDir}`);
    output.appendLine(`  Steering dir: ${steeringDir}`);
    output.appendLine(`  Skills: ${skillLoader.getAllSkills().length} loaded (${skillLoader.getByScope('workspace').length} workspace, ${skillLoader.getByScope('global').length} global)`);
    output.appendLine(`  Powers: ${powerManager.list().length} installed`);
    output.appendLine(`  Agents: ${agentRegistry.listAll().length} registered (active: ${agentRegistry.getActive(context).name})`);
    output.appendLine(`  Model router: ${modelRouter.getStats().length} provider(s)`);
    output.appendLine(`  Daemon socket: ${require('./daemon/agentDaemon').AgentDaemon.defaultSocketPath()}`);
    output.appendLine(`  Connectors: auto-detecting IaC tools...`);
    connectorRegistry.detectAll().then(detected => {
        if (detected.length) output.appendLine(`  Connectors found: ${detected.map(c => c.name).join(', ')}`);
    });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function pickPowerId(placeholder: string): Promise<string | undefined> {
    return vscode.window.showInputBox({ prompt: placeholder, placeHolder: 'power-id' });
}

async function pickAgentId(registry: import('./agents/agentRegistry').AgentRegistry): Promise<string | undefined> {
    const pick = await vscode.window.showQuickPick(
        registry.listAll().map(a => ({ label: a.name, description: a.scope, id: a.id })),
        { placeHolder: 'Select agent' }
    );
    return pick?.id;
}

export function deactivate() {}
