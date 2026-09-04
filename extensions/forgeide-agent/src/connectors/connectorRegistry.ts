import * as vscode from 'vscode';
import { Connector as DaemonConnector, RiskClass } from '../daemon/types';
import { ToolSandbox } from '../tools/toolSandbox';

/**
 * ConnectorResult — result of a connector operation.
 */
export interface ConnectorResult {
    success: boolean;
    output: string;
    error?: string;
}

/**
 * Connector — extends the canonical daemon Connector interface.
 * applyGate is hardcoded "elevated" per the types contract — connector
 * deployments always require elevated approval.
 */
export interface Connector extends DaemonConnector {
    type: ConnectorType;
    name: string;
    /** Returns true if this connector is usable in the current workspace. */
    detect(workspaceRoot: string): Promise<boolean>;
    synth(cwd: string, sandbox: ToolSandbox): Promise<ConnectorResult>;
    plan(cwd: string, sandbox: ToolSandbox): Promise<ConnectorResult>;
    deploy(cwd: string, sandbox: ToolSandbox): Promise<ConnectorResult>;
    destroy(cwd: string, sandbox: ToolSandbox): Promise<ConnectorResult>;
    diff(cwd: string, sandbox: ToolSandbox): Promise<ConnectorResult>;
    readonly applyGate: "elevated"; // hardcoded — never safe
}

export type ConnectorType = 'cdk' | 'sam' | 'terraform' | 'pulumi' | 'cloudformation';

// ── CDK ──────────────────────────────────────────────────────────────────────
class CdkConnector implements Connector {
    readonly applyGate: "elevated" = "elevated";
    id = 'cdk';
    type: ConnectorType = 'cdk';
    name = 'AWS CDK';
    detects = ['cdk.json', '**/cdk.json'];

    async planPreview(diff: string): Promise<string> {
        return `CDK diff preview:\n${diff.slice(0, 500)}`;
    }

    async detect(root: string): Promise<boolean> {
        try { await vscode.workspace.fs.stat(vscode.Uri.file(`${root}/cdk.json`)); return true; }
        catch { return false; }
    }
    async synth(cwd: string, sandbox: ToolSandbox): Promise<ConnectorResult> {
        return run(sandbox, 'npx', ['cdk', 'synth'], cwd);
    }
    async plan(cwd: string, sandbox: ToolSandbox): Promise<ConnectorResult> {
        return run(sandbox, 'npx', ['cdk', 'diff'], cwd);
    }
    async deploy(cwd: string, sandbox: ToolSandbox): Promise<ConnectorResult> {
        return run(sandbox, 'npx', ['cdk', 'deploy', '--require-approval', 'never'], cwd);
    }
    async destroy(cwd: string, sandbox: ToolSandbox): Promise<ConnectorResult> {
        return run(sandbox, 'npx', ['cdk', 'destroy', '--force'], cwd);
    }
    async diff(cwd: string, sandbox: ToolSandbox): Promise<ConnectorResult> {
        return this.plan(cwd, sandbox);
    }
}

// ── SAM ──────────────────────────────────────────────────────────────────────
class SamConnector implements Connector {
    readonly applyGate: "elevated" = "elevated";
    id = 'sam';
    type: ConnectorType = 'sam';
    name = 'AWS SAM';
    detects = ['template.yaml', 'template.yml'];

    async planPreview(diff: string): Promise<string> {
        return `SAM validate preview:\n${diff.slice(0, 500)}`;
    }

    async detect(root: string): Promise<boolean> {
        try { await vscode.workspace.fs.stat(vscode.Uri.file(`${root}/template.yaml`)); return true; }
        catch { return false; }
    }
    async synth(cwd: string, sandbox: ToolSandbox): Promise<ConnectorResult> {
        return run(sandbox, 'sam', ['build'], cwd);
    }
    async plan(cwd: string, sandbox: ToolSandbox): Promise<ConnectorResult> {
        return run(sandbox, 'sam', ['validate'], cwd);
    }
    async deploy(cwd: string, sandbox: ToolSandbox): Promise<ConnectorResult> {
        return run(sandbox, 'sam', ['deploy', '--no-confirm-changeset'], cwd);
    }
    async destroy(cwd: string, sandbox: ToolSandbox): Promise<ConnectorResult> {
        return run(sandbox, 'sam', ['delete', '--no-prompts'], cwd);
    }
    async diff(cwd: string, sandbox: ToolSandbox): Promise<ConnectorResult> {
        return this.plan(cwd, sandbox);
    }
}

// ── Terraform ────────────────────────────────────────────────────────────────
class TerraformConnector implements Connector {
    readonly applyGate: "elevated" = "elevated";
    id = 'terraform';
    type: ConnectorType = 'terraform';
    name = 'Terraform';
    detects = ['**/*.tf', '*.tf'];

    async planPreview(diff: string): Promise<string> {
        return `Terraform plan preview:\n${diff.slice(0, 500)}`;
    }

    async detect(root: string): Promise<boolean> {
        try {
            const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(root));
            return entries.some(([n]) => n.endsWith('.tf'));
        } catch { return false; }
    }
    async synth(cwd: string, sandbox: ToolSandbox): Promise<ConnectorResult> {
        return run(sandbox, 'terraform', ['init', '-input=false'], cwd);
    }
    async plan(cwd: string, sandbox: ToolSandbox): Promise<ConnectorResult> {
        return run(sandbox, 'terraform', ['plan', '-input=false'], cwd);
    }
    async deploy(cwd: string, sandbox: ToolSandbox): Promise<ConnectorResult> {
        return run(sandbox, 'terraform', ['apply', '-auto-approve', '-input=false'], cwd);
    }
    async destroy(cwd: string, sandbox: ToolSandbox): Promise<ConnectorResult> {
        return run(sandbox, 'terraform', ['destroy', '-auto-approve', '-input=false'], cwd);
    }
    async diff(cwd: string, sandbox: ToolSandbox): Promise<ConnectorResult> {
        return this.plan(cwd, sandbox);
    }
}

// ── Pulumi ───────────────────────────────────────────────────────────────────
class PulumiConnector implements Connector {
    readonly applyGate: "elevated" = "elevated";
    id = 'pulumi';
    type: ConnectorType = 'pulumi';
    name = 'Pulumi';
    detects = ['Pulumi.yaml', 'Pulumi.yml'];

    async planPreview(diff: string): Promise<string> {
        return `Pulumi preview:\n${diff.slice(0, 500)}`;
    }

    async detect(root: string): Promise<boolean> {
        try { await vscode.workspace.fs.stat(vscode.Uri.file(`${root}/Pulumi.yaml`)); return true; }
        catch { return false; }
    }
    async synth(cwd: string, sandbox: ToolSandbox): Promise<ConnectorResult> {
        return run(sandbox, 'pulumi', ['preview'], cwd);
    }
    async plan(cwd: string, sandbox: ToolSandbox): Promise<ConnectorResult> {
        return this.synth(cwd, sandbox);
    }
    async deploy(cwd: string, sandbox: ToolSandbox): Promise<ConnectorResult> {
        return run(sandbox, 'pulumi', ['up', '--yes'], cwd);
    }
    async destroy(cwd: string, sandbox: ToolSandbox): Promise<ConnectorResult> {
        return run(sandbox, 'pulumi', ['destroy', '--yes'], cwd);
    }
    async diff(cwd: string, sandbox: ToolSandbox): Promise<ConnectorResult> {
        return this.synth(cwd, sandbox);
    }
}

// ── Registry ─────────────────────────────────────────────────────────────────
export class ConnectorRegistry {
    private connectors: Connector[] = [
        new CdkConnector(),
        new SamConnector(),
        new TerraformConnector(),
        new PulumiConnector()
    ];

    constructor(
        private workspaceRoot: string,
        private sandbox: ToolSandbox
    ) {
        // Extend sandbox allowlist with IaC tooling
        sandbox.allow({ command: 'cdk',       timeoutMs: 180_000 });
        sandbox.allow({ command: 'sam',       timeoutMs: 180_000 });
        sandbox.allow({ command: 'terraform', timeoutMs: 180_000 });
        sandbox.allow({ command: 'pulumi',    timeoutMs: 180_000 });
    }

    /** Returns connectors detected in the current workspace. */
    async detectAll(): Promise<Connector[]> {
        const results: Connector[] = [];
        for (const c of this.connectors) {
            if (await c.detect(this.workspaceRoot)) results.push(c);
        }
        return results;
    }

    get(type: ConnectorType): Connector | undefined {
        return this.connectors.find(c => c.type === type);
    }

    async run(type: ConnectorType, action: 'synth' | 'plan' | 'deploy' | 'destroy' | 'diff'): Promise<ConnectorResult> {
        const connector = this.get(type);
        if (!connector) return { success: false, output: '', error: `No connector for "${type}"` };
        return connector[action](this.workspaceRoot, this.sandbox);
    }

    listAll(): Connector[] { return [...this.connectors]; }
}

// ── Shared helper ─────────────────────────────────────────────────────────────
async function run(sandbox: ToolSandbox, cmd: string, args: string[], cwd: string): Promise<ConnectorResult> {
    const result = await sandbox.run(cmd, args, cwd);
    return {
        success: result.ok,
        output: result.output ?? '',
        error: result.ok ? undefined : result.error
    };
}
