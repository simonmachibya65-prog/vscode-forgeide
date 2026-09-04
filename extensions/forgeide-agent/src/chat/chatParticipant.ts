import * as vscode from 'vscode';
import { ModelClient } from '../modelClient';
import { SpecsEngine } from '../specs/specsEngine';
import { SteeringLoader } from '../steering/steeringLoader';
import { McpManager } from '../mcp/mcpManager';
import { SkillLoader } from '../skills/skillLoader';
import { PowerManager } from '../powers/powerManager';
import { BugBot } from '../review/bugbot';
import { gatherEditorContext, searchWorkspace } from './contextGatherer';
import { fenceUntrustedContent } from '../security/promptGuard';

const TOOL_CALL_RE = /^TOOL:\s*(\w+)\s+"([^"]*)"\s*$/m;
const MAX_TOOL_HOPS = 4;

export function registerChatParticipant(
    context: vscode.ExtensionContext,
    model: ModelClient,
    specsEngine: SpecsEngine,
    steering: SteeringLoader,
    mcp: McpManager,
    skillLoader: SkillLoader,
    powerManager: PowerManager,
    bugBot: BugBot
) {
    const handler: vscode.ChatRequestHandler = async (request, _chatContext, stream, token) => {
        const config = vscode.workspace.getConfiguration('forgeide');
        const steeringDir = config.get<string>('steering.directory', '.kiro/steering');

        const editorCtx = await gatherEditorContext();
        const steeringContext = await steering.buildContextBlock(steeringDir, editorCtx.activeFileRelativePath);

        // ── Task 5: contextual power activation ───────────────────────────────
        // Activate powers whose keywords appear in the current prompt.
        // This runs on every turn — powers that no longer match are deactivated.
        await powerManager.activateForContext(request.prompt);
        const powersContext = await powerManager.getActiveSkillsContext(request.prompt);

        // Active skills context — keyword-matched against the prompt
        const skillsContext = skillLoader.buildContextBlock(request.prompt);

        // ── @forge spec ───────────────────────────────────────────────────────
        if (request.command === 'spec') {
            stream.progress('Drafting requirements...');
            const spec = await specsEngine.createFromPrompt(request.prompt);
            const check = spec.requirementsCheck;
            stream.markdown(`### Requirements for "${spec.prompt}"\n\n${spec.requirements}\n\n`);
            if (check) {
                stream.markdown(
                    `_EARS check: ${check.valid}/${check.total} acceptance criteria well-formed._\n\n`
                );
            }
            stream.markdown(
                `_Spec saved as \`${spec.id}\`. Open the **ForgeIDE Specs** panel to approve and continue._`
            );
            return;
        }

        // ── @forge implement ──────────────────────────────────────────────────
        if (request.command === 'implement') {
            stream.markdown(
                'Use the **ForgeIDE Specs** panel and click a task to implement it — that flow ' +
                'routes proposed file changes through a diff preview before anything is written.\n\n' +
                'Or run **ForgeIDE: Run Full Pipeline** from the command palette to run the complete ' +
                'requirements → design → tasks → implement → verify pipeline.'
            );
            return;
        }

        // ── @forge hooks ──────────────────────────────────────────────────────
        if (request.command === 'hooks') {
            stream.markdown(
                'Manage hooks from the **ForgeIDE Hooks** panel, or run **ForgeIDE: Add Agent Hook**.\n\n' +
                'Hook JSON shape:\n' +
                '```json\n' +
                '{ "id": "...", "on": "save|create|delete|manual|preCommit",\n' +
                '  "glob": "src/**/*.ts", "action": "shell:npm test", "enabled": true }\n' +
                '```\n\n' +
                'Prefix `action` with `shell:` to run a terminal command directly. ' +
                'Any other string is sent to the model as an AI-edit instruction.'
            );
            return;
        }

        // ── @forge review ─────────────────────────────────────────────────────
        if (request.command === 'review') {
            stream.progress('Running BugBot review on current spec tasks...');

            const specs = await specsEngine.listAll();
            const activeSpec = specs.find(s =>
                s.tasksApproved && s.tasks?.some(t => t.status === 'in_progress' || t.status === 'done')
            );

            if (!activeSpec) {
                stream.markdown(
                    '_No active spec with implemented tasks found. ' +
                    'Implement a task first, then run `@forge review`._'
                );
                return;
            }

            const reviewedTasks = (activeSpec.tasks ?? [])
                .filter(t => t.status === 'in_progress' || t.status === 'done');

            stream.markdown(`### BugBot Review — "${activeSpec.title}"\n\n`);

            for (const task of reviewedTasks) {
                stream.progress(`Reviewing task: ${task.title}...`);
                const report = await bugBot.review(activeSpec, task, []);

                const statusIcon = report.approved ? '✅' : '❌';
                stream.markdown(`**${statusIcon} ${task.title}**\n\n`);
                stream.markdown(`${report.summary}\n\n`);

                if (report.issues.length > 0) {
                    stream.markdown(
                        report.issues.map(i => `- ${i}`).join('\n') + '\n\n'
                    );
                }
            }

            stream.markdown(
                `_Review complete. ${reviewedTasks.length} task(s) checked._`
            );
            return;
        }

        // ── Freeform agentic chat with tool loop ──────────────────────────────
        const tools = mcp.listAllTools();
        const toolSummary = [
            'You have a "search" tool: respond with exactly: TOOL: search "your query"',
            tools.length
                ? `MCP tools available: ${tools.map(t => `${t.server}.${t.tool.name}`).join(', ')}. ` +
                  `Call with: TOOL: mcp "server.toolName {\\"arg\\":\\"value\\"}"`
                : 'No MCP tools connected.'
        ].join('\n');

        const systemParts = [
            'You are ForgeIDE\'s coding agent, embedded in the editor.',
            steeringContext,
            skillsContext,
            powersContext,
            toolSummary,
            'Be concise. Reference actual file paths from the workspace when relevant.'
        ].filter(Boolean);

        const messages: { role: 'user' | 'assistant' | 'system'; content: string }[] = [
            { role: 'system', content: systemParts.join('\n\n') },
            {
                role: 'user',
                content: [
                    editorCtx.activeFileSummary,
                    editorCtx.diagnosticsSummary
                        ? `Diagnostics:\n${editorCtx.diagnosticsSummary}`
                        : '',
                    request.prompt
                ].filter(Boolean).join('\n\n')
            }
        ];

        for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
            if (token.isCancellationRequested) return;

            stream.progress(hop === 0 ? 'Thinking...' : 'Continuing with tool results...');
            const handle = await model.stream(messages);
            handle.onToken(t => stream.markdown(t));
            const full = await handle.result();

            const toolMatch = full.match(TOOL_CALL_RE);
            if (!toolMatch) {
                // Already streamed token-by-token above
                return;
            }

            const [, toolName, arg] = toolMatch;
            messages.push({ role: 'assistant', content: full });

            let toolResult: string;
            if (toolName === 'search') {
                stream.progress(`Searching workspace for "${arg}"...`);
                toolResult = await searchWorkspace(arg);
            } else if (toolName === 'mcp') {
                const spaceIdx = arg.indexOf(' ');
                const toolPath = spaceIdx === -1 ? arg : arg.slice(0, spaceIdx);
                const argsJson = spaceIdx === -1 ? '{}' : arg.slice(spaceIdx + 1);
                const [serverName, mcpToolName] = toolPath.split('.');
                try {
                    const parsedArgs = JSON.parse(argsJson);
                    toolResult = await mcp.invokeTool(serverName, mcpToolName, parsedArgs);
                } catch (e) {
                    toolResult = `Tool call failed: ${e}`;
                }
            } else {
                toolResult = `Unknown tool "${toolName}".`;
            }

            messages.push({
                role: 'user',
                content: fenceUntrustedContent(`tool:${toolName}`, toolResult)
            });
        }

        stream.markdown(
            '_Stopped after multiple tool calls without a final answer — try a narrower question._'
        );
    };

    const participant = vscode.chat.createChatParticipant('forgeide.agent', handler);
    context.subscriptions.push(participant);
}
