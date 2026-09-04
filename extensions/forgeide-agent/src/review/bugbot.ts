import * as vscode from 'vscode';
import { ModelClient } from '../modelClient';
import { Spec, SpecTask } from '../specs/specsEngine';
import { fenceUntrustedContent } from '../security/promptGuard';

export interface BugBotIssue {
    severity: 'error' | 'warning' | 'suggestion';
    file: string;
    message: string;
    line?: number;
}

export interface BugBotReport {
    taskId: string;
    taskTitle: string;
    issues: BugBotIssue[];
    summary: string;
    approved: boolean;
}

const BUGBOT_SYSTEM_PROMPT = `You are a senior code reviewer performing an automated review of
proposed file changes generated for a spec task. Review the proposed changes against:
1. The task requirements and design — do the changes actually implement what was asked?
2. Correctness — obvious logic errors, off-by-ones, missing null checks.
3. Security — injection risks, hardcoded secrets, missing input validation.
4. Accessibility — if UI code, are ARIA labels, keyboard navigation, and contrast addressed?
5. Style — does the code match the surrounding style of the existing files?

Respond ONLY with JSON matching this schema:
{
  "issues": [
    { "severity": "error"|"warning"|"suggestion", "file": "path", "message": "...", "line": <number or null> }
  ],
  "summary": "One-sentence overall assessment.",
  "approved": true|false
}
"approved" is true if there are no errors (warnings and suggestions are acceptable).`;

/**
 * BugBot — automated diff review pass that runs after the model proposes file
 * changes but BEFORE the user is asked to Apply them. Gives a fast quality
 * signal without requiring a human to read every diff line.
 */
export class BugBot {
    constructor(
        private model: ModelClient,
        private outputChannel: vscode.OutputChannel
    ) {}

    /**
     * Review a set of proposed file changes against the spec task they belong to.
     * Returns a BugBotReport — if report.approved is false, the caller should
     * surface the issues to the user before proceeding.
     */
    async review(
        spec: Spec,
        task: SpecTask,
        proposedFiles: { path: string; content: string }[]
    ): Promise<BugBotReport> {
        const filesBlock = proposedFiles
            .map(f => fenceUntrustedContent(f.path, f.content))
            .join('\n\n');

        this.outputChannel.appendLine(
            `BugBot: reviewing ${proposedFiles.length} file(s) for task "${task.title}"...`
        );

        const raw = await this.model.complete([
            { role: 'system', content: BUGBOT_SYSTEM_PROMPT },
            {
                role: 'user',
                content: [
                    `Spec: ${spec.title}`,
                    `Requirements:\n${spec.requirements}`,
                    `Design:\n${spec.design}`,
                    `Task: ${task.title}\n${task.detail}`,
                    `Proposed changes:\n${filesBlock}`
                ].join('\n\n')
            }
        ], { maxTokens: 2048 });

        let report: BugBotReport;
        try {
            const parsed = JSON.parse(raw);
            report = {
                taskId: task.id,
                taskTitle: task.title,
                issues: parsed.issues ?? [],
                summary: parsed.summary ?? 'No summary.',
                approved: parsed.approved ?? false
            };
        } catch {
            // Model returned non-JSON — treat as an unblocking warning
            report = {
                taskId: task.id,
                taskTitle: task.title,
                issues: [{ severity: 'warning', file: '(all)', message: `BugBot parse error: ${raw.slice(0, 200)}` }],
                summary: 'BugBot could not parse its own output.',
                approved: true
            };
        }

        this.outputChannel.appendLine(
            `BugBot: ${report.issues.length} issue(s) — ` +
            `${report.approved ? 'approved' : 'BLOCKED'}. ${report.summary}`
        );
        return report;
    }

    /**
     * Shows the BugBot report in a VS Code notification and output channel.
     * Returns true if the user wants to proceed anyway (even if not approved).
     */
    async presentReport(report: BugBotReport): Promise<boolean> {
        if (report.issues.length === 0) {
            vscode.window.showInformationMessage(`BugBot: ✓ ${report.summary}`);
            return true;
        }

        const errors = report.issues.filter(i => i.severity === 'error');
        const warnings = report.issues.filter(i => i.severity === 'warning');
        const suggestions = report.issues.filter(i => i.severity === 'suggestion');

        this.outputChannel.appendLine(`\nBugBot Report — "${report.taskTitle}"`);
        this.outputChannel.appendLine('─'.repeat(50));
        for (const issue of report.issues) {
            const loc = issue.line ? `:${issue.line}` : '';
            this.outputChannel.appendLine(
                `[${issue.severity.toUpperCase()}] ${issue.file}${loc}: ${issue.message}`
            );
        }
        this.outputChannel.appendLine(`Summary: ${report.summary}`);
        this.outputChannel.show(true);

        const label = [
            errors.length ? `${errors.length} error(s)` : '',
            warnings.length ? `${warnings.length} warning(s)` : '',
            suggestions.length ? `${suggestions.length} suggestion(s)` : ''
        ].filter(Boolean).join(', ');

        if (!report.approved) {
            const choice = await vscode.window.showWarningMessage(
                `BugBot found issues: ${label}. ${report.summary}`,
                'View Report', 'Proceed Anyway', 'Cancel'
            );
            if (choice === 'View Report') {
                this.outputChannel.show();
                return false;
            }
            return choice === 'Proceed Anyway';
        } else {
            vscode.window.showInformationMessage(
                `BugBot: approved with ${label}. See output for details.`
            );
            return true;
        }
    }
}
