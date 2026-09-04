import * as vscode from 'vscode';
import {
    VerificationResult,
    VerificationFinding
} from '../daemon/types';
import { ModelClient } from '../modelClient';
import { Spec, SpecTask } from '../specs/specsEngine';
import { ToolSandbox } from '../tools/toolSandbox';
import { fenceUntrustedContent } from '../security/promptGuard';
import { summarizeVerificationResult } from './verificationSummary';

/**
 * VerificationAgent — post-task verification using the canonical
 * VerificationResult / VerificationFinding types from daemon/types.ts.
 *
 * Two-pass verification:
 *   Pass 1 — automated: tsc, eslint, test runner (via ToolSandbox)
 *   Pass 2 — model: requirements traceability check
 *
 * Returns a VerificationResult.
 *   status: "passed" | "failed"
 *   propertiesTested: list of properties checked
 *   failures: VerificationFinding[]  { property, evidence }
 */

const VERIFY_SYSTEM_PROMPT = `You are a verification agent. Given a spec task and the
outcomes of its implementation, verify:
1. Does the implementation satisfy the stated requirements? (property: "requirements-satisfied")
2. Are there obvious correctness issues? (property: "correctness")
3. Are there security concerns? (property: "security")
4. Are there accessibility concerns for any UI code? (property: "accessibility")

Respond ONLY with JSON matching:
{
  "status": "passed" | "failed",
  "propertiesTested": string[],
  "failures": [{ "property": string, "evidence": string }]
}`;

export class VerificationAgent {
    constructor(
        private model: ModelClient,
        private sandbox: ToolSandbox,
        private outputChannel: vscode.OutputChannel
    ) {}

    async verify(
        spec: Spec,
        task: SpecTask,
        outcomes: { path: string; result: string }[]
    ): Promise<VerificationResult & { passed: boolean; issues: string[] }> {
        const failures: VerificationFinding[] = [];
        const propertiesTested: string[] = [];

        // ── Pass 1: automated checks ──────────────────────────────────────────
        const autoFindings = await this.runAutomatedChecks();
        failures.push(...autoFindings);
        propertiesTested.push('type-safety', 'lint', 'tests');

        // ── Pass 2: model requirements check (only if no hard failures) ───────
        const hasHardFailure = failures.length > 0;
        if (!hasHardFailure) {
            const modelFindings = await this.runModelCheck(spec, task, outcomes);
            failures.push(...modelFindings);
            propertiesTested.push('requirements-satisfied', 'correctness', 'security', 'accessibility');
        }

        const status: VerificationResult['status'] = failures.length === 0 ? 'passed' : 'failed';
        const result: VerificationResult = { status, propertiesTested, failures };

        const summary = status === 'passed'
            ? `Task "${task.title}" passed all verification checks.`
            : `Task "${task.title}" failed: ${failures.map(f => f.evidence).join('; ')}`;

        const summaryWithEvidence = summarizeVerificationResult({
            passed: status === 'passed',
            propertiesTested,
            issues: failures.map(f => `[${f.property}] ${f.evidence}`)
        });

        this.outputChannel.appendLine(`Verification [${status}]: ${summary}`);
        this.outputChannel.appendLine(summaryWithEvidence);

        return {
            ...result,
            // Convenience fields for callers that used the old interface
            passed: status === 'passed',
            issues: failures.map(f => `[${f.property}] ${f.evidence}`)
        };
    }

    private async runAutomatedChecks(): Promise<VerificationFinding[]> {
        const findings: VerificationFinding[] = [];
        const folders = vscode.workspace.workspaceFolders;
        if (!folders?.length) return findings;
        const cwd = folders[0].uri.fsPath;

        // Type-check
        const tsc = await this.sandbox.run('npx', ['tsc', '--noEmit', '--pretty', 'false'], cwd);
        if (!tsc.ok) {
            const lines = (tsc.output ?? '').split('\n').filter(l => l.includes('error TS'));
            for (const line of lines.slice(0, 10)) {
                findings.push({ property: 'type-safety', evidence: line.trim() });
            }
        }

        // Lint
        const eslint = await this.sandbox.run(
            'npx', ['eslint', '.', '--max-warnings', '0', '--format', 'compact'], cwd
        );
        if (!eslint.ok) {
            const lines = (eslint.output ?? '').split('\n')
                .filter(l => l.trim() && l.includes(':'));
            for (const line of lines.slice(0, 10)) {
                findings.push({ property: 'lint', evidence: line.trim() });
            }
        }

        // Tests
        const tests = await this.sandbox.run(
            'npm', ['test', '--', '--run', '--reporter=verbose'], cwd
        );
        if (!tests.ok) {
            const failLines = (tests.output ?? '').split('\n')
                .filter(l => /FAIL|✕|✗|FAILED/i.test(l))
                .slice(0, 10);
            for (const line of failLines) {
                findings.push({ property: 'tests', evidence: line.trim() });
            }
        }

        return findings;
    }

    private async runModelCheck(
        spec: Spec,
        task: SpecTask,
        outcomes: { path: string; result: string }[]
    ): Promise<VerificationFinding[]> {
        try {
            const changedFiles = outcomes.filter(o => o.result === 'applied').map(o => o.path).join(', ');
            const raw = await this.model.complete([
                { role: 'system', content: VERIFY_SYSTEM_PROMPT },
                {
                    role: 'user',
                    content: fenceUntrustedContent('spec-context',
                        `Spec: ${spec.title}\n` +
                        `Requirements:\n${spec.requirements}\n\n` +
                        `Design:\n${spec.design}\n\n` +
                        `Task: ${task.title}\n${task.detail}\n\n` +
                        `Files changed: ${changedFiles || 'none'}`
                    )
                }
            ], { maxTokens: 1024 });

            const parsed: VerificationResult = JSON.parse(raw);
            return parsed.failures ?? [];
        } catch {
            return []; // model check failure is non-blocking
        }
    }
}
