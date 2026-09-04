import * as vscode from 'vscode';
import { SpecsEngine, Spec, SpecTask } from '../specs/specsEngine';

export class SpecWebview implements vscode.Disposable {
    private panel: vscode.WebviewPanel | undefined;
    private currentSpec: Spec | undefined;
    private allSpecs: Spec[] = [];

    constructor(
        private context: vscode.ExtensionContext,
        private specsEngine: SpecsEngine
    ) {}

    async open(specId?: string): Promise<void> {
        this.allSpecs = await this.specsEngine.listAll();
        this.currentSpec = specId
            ? (this.allSpecs.find(s => s.id === specId) ?? this.allSpecs[0])
            : this.allSpecs[0];

        if (!this.panel) {
            this.panel = vscode.window.createWebviewPanel(
                'forgeide.ideShell', 'ForgeIDE',
                vscode.ViewColumn.One,
                { enableScripts: true, retainContextWhenHidden: true }
            );
            this.panel.onDidDispose(() => { this.panel = undefined; });
            this.context.subscriptions.push(this.panel);
        } else {
            this.panel.reveal(vscode.ViewColumn.One);
        }
        this.render();
        this.panel.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.command) {
                case 'selectSpec':
                    this.currentSpec = this.allSpecs.find(s => s.id === msg.id);
                    this.render(); break;
                case 'approveRequirements':
                    if (!this.currentSpec) break;
                    this.currentSpec = await this.specsEngine.approveRequirements(this.currentSpec);
                    this.allSpecs = await this.specsEngine.listAll();
                    this.render();
                    vscode.window.showInformationMessage('Requirements approved.'); break;
                case 'approveDesign':
                    if (!this.currentSpec) break;
                    this.currentSpec = await this.specsEngine.approveDesign(this.currentSpec);
                    this.allSpecs = await this.specsEngine.listAll();
                    this.render();
                    vscode.window.showInformationMessage('Design approved.'); break;
                case 'approveTasks':
                    if (!this.currentSpec) break;
                    this.currentSpec = await this.specsEngine.approveTasks(this.currentSpec);
                    this.allSpecs = await this.specsEngine.listAll();
                    this.render();
                    vscode.window.showInformationMessage('Tasks approved — code generation unlocked.'); break;
                case 'implementTask':
                    if (!this.currentSpec) break;
                    await vscode.commands.executeCommand('forgeide.implementTask', this.currentSpec.id, msg.taskId);
                    this.currentSpec = await this.specsEngine.load(this.currentSpec.id);
                    this.allSpecs = await this.specsEngine.listAll();
                    this.render(); break;
                case 'newSpec':
                    await vscode.commands.executeCommand('forgeide.newSpec');
                    this.allSpecs = await this.specsEngine.listAll();
                    this.currentSpec = this.allSpecs[0];
                    this.render(); break;
                case 'pickModel':
                    await vscode.commands.executeCommand('forgeide.pickModel'); break;
                case 'toggleAutopilot':
                    await vscode.commands.executeCommand('forgeide.toggleAutopilot'); break;
            }
        });
    }

    private render(): void {
        if (!this.panel) return;
        this.panel.title = this.currentSpec ? `ForgeIDE — ${this.currentSpec.title}` : 'ForgeIDE';
        this.panel.webview.html = buildHtml(this.currentSpec, this.allSpecs);
    }

    dispose(): void { this.panel?.dispose(); }
}

// =============================================================================
// PART 2 — buildHtml: document wrapper + menu bar + focus bar + rail + sidebar
// =============================================================================

function buildHtml(spec: Spec | undefined, specs: Spec[]): string {
    const cfg = vscode.workspace.getConfiguration('forgeide');
    const isAutopilot = cfg.get<string>('gateMode', 'supervised') === 'autopilot';
    const gateStatus = spec
        ? (!spec.requirementsApproved ? 'Requirements pending'
            : !spec.designApproved ? 'Design pending'
            : !spec.tasksApproved ? 'Tasks pending' : 'Unlocked')
        : 'No spec';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline';">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>
<script>const vscode = acquireVsCodeApi();</script>
<div class="shell">

${menuBar(isAutopilot)}
${focusBar()}

<div class="main-row" id="mainRow">
${rail()}
<div class="rail-tip" id="railTip"></div>
${sidebar(spec, specs)}
${editorColumn(spec)}
${agentPanel(spec)}
</div>

${bottomPanel()}
${statusBar(gateStatus, isAutopilot)}

</div>
${JS}
</body></html>`;
}

// ── Menu bar ──────────────────────────────────────────────────────────────────
function menuBar(isAutopilot: boolean): string {
    return `<div class="menubar">
  <div class="brand">${I.LOGO} ForgeIDE</div>
  <span class="item">File</span><span class="item">Edit</span>
  <span class="item">Selection</span><span class="item">View</span>
  <span class="item">Go</span><span class="item">Run</span>
  <span class="item">Terminal</span><span class="item">Help</span>
  <div class="spacer"></div>
  <div class="mode-toggle" id="modeToggle">
    <div class="mode-opt${!isAutopilot ? ' active' : ''}" data-agentmode="supervised">Supervised</div>
    <div class="mode-opt${isAutopilot ? ' active' : ''}" data-agentmode="autopilot">Autopilot</div>
  </div>
</div>`;
}

// ── Focus bar ─────────────────────────────────────────────────────────────────
function focusBar(): string {
    return `<div class="focusbar">
  <div class="focus-tab">${I.FOCUS} Agent Focus</div>
  <div class="spacer"></div>
  <div class="layout-toggles" id="layoutToggles">
    <div class="layout-btn on" data-layout="sidebar"  title="Toggle sidebar">${I.LAY_SIDEBAR}</div>
    <div class="layout-btn on" data-layout="split"    title="Toggle split">${I.LAY_SPLIT}</div>
    <div class="layout-btn on" data-layout="bottom"   title="Toggle bottom panel">${I.LAY_BOTTOM}</div>
    <div class="layout-btn on" data-layout="agent"    title="Toggle agent chat">${I.LAY_CHAT}</div>
  </div>
</div>`;
}

// ── Activity rail ─────────────────────────────────────────────────────────────
function rail(): string {
    return `<div class="rail" id="rail">
  <div class="rail-icon" data-view="explorer"   data-tip="Explorer">${I.EXPLORER}</div>
  <div class="rail-icon" data-view="search"     data-tip="Search">${I.SEARCH}</div>
  <div class="rail-icon" data-view="scm"        data-tip="Source Control · 3 changes">${I.GIT}<span class="badge"></span></div>
  <div class="rail-icon active" data-view="specs" data-tip="Specs">${I.SPECS}</div>
  <div class="rail-icon" data-view="debug"      data-tip="Run &amp; Debug">${I.DEBUG}</div>
  <div class="rail-icon" data-view="testing"    data-tip="Testing">${I.TEST}</div>
  <div class="rail-icon" data-view="extensions" data-tip="Extensions">${I.EXT}</div>
  <div class="rail-spacer"></div>
  <div class="rail-icon bottom" data-view="mcp"      data-tip="Agents &amp; MCP">${I.AGENTS}</div>
  <div class="rail-icon bottom" data-view="remote"   data-tip="Remote">${I.REMOTE}</div>
  <div class="rail-icon account bottom" data-view="account" data-tip="Account">${I.ACCOUNT}<span class="avatar-badge">${I.CHECK_TINY}</span></div>
  <div class="rail-icon bottom" data-view="settings" data-tip="Settings" style="margin-bottom:8px">${I.SETTINGS}</div>
</div>`;
}

// ── Sidebar (all panels) ──────────────────────────────────────────────────────
function sidebar(spec: Spec | undefined, specs: Spec[]): string {
    return `<div class="sidebar" id="sidebarEl">

  <!-- Explorer -->
  <div class="panel" data-panel="explorer">
    <div class="panel-title"><span>Explorer</span>
      <div class="icon-actions">
        <div class="picon" title="New file">${I.NEW_FILE}</div>
        <div class="picon" title="New folder">${I.NEW_FOLDER}</div>
        <div class="picon" title="Refresh">${I.REFRESH}</div>
        <div class="picon on" title="Collapse">${I.COLLAPSE}</div>
        <div class="picon" title="More">${I.MORE}</div>
      </div>
    </div>
    <div class="file-row tree" data-open="true"><span class="icon">▾</span> gatework/</div>
    <div class="file-row tree" style="padding-left:44px" data-open="true"><span class="icon">▾</span> src</div>
    <div class="file-row tree" style="padding-left:58px" data-open="true"><span class="icon">▾</span> auth</div>
    <div class="file-row tree" style="padding-left:72px" data-file="refresh-token.ts"><span class="icon">TS</span> refresh-token.ts<span class="meta">M</span></div>
    <div class="file-row tree" style="padding-left:72px" data-file="auth.service.ts"><span class="icon">TS</span> auth.service.ts</div>
    <div class="file-row tree" style="padding-left:72px" data-file="login.controller.ts"><span class="icon">TS</span> login.controller.ts</div>
    <div class="file-row tree" style="padding-left:58px"><span class="icon">▸</span> billing</div>
    <div class="file-row tree" style="padding-left:44px"><span class="icon">▸</span> tests</div>
    <div class="file-row tree" style="padding-left:44px"><span class="icon">{}</span> package.json</div>
    <div class="divider"></div>
    <div class="sub-label" style="padding-left:14px">Open editors</div>
    <div class="file-row" data-file="refresh-token.ts"><span class="icon">TS</span> refresh-token.ts</div>
    <div class="file-row" data-file="auth.service.ts"><span class="icon">TS</span> auth.service.ts</div>
  </div>

  <!-- Search -->
  <div class="panel" data-panel="search">
    <div class="panel-title"><span>Search</span></div>
    <div class="search-box"><input type="text" value="rotateRefreshToken" placeholder="Search workspace"></div>
    <div class="search-box"><input type="text" placeholder="Files to include"></div>
    <div class="search-toggles">
      <div class="search-toggle on">Aa</div>
      <div class="search-toggle">Ab</div>
      <div class="search-toggle">.*</div>
    </div>
    <div class="divider"></div>
    <div class="search-result-file"><span>src/auth/refresh-token.ts</span><span class="count">3</span></div>
    <div class="search-result-line">3: export function <mark>rotateRefreshToken</mark>(token: string) {</div>
    <div class="search-result-line">17: return <mark>rotateRefreshToken</mark>Result;</div>
    <div class="search-result-file"><span>src/auth/auth.service.ts</span><span class="count">1</span></div>
    <div class="search-result-line">44: await <mark>rotateRefreshToken</mark>(session.token);</div>
  </div>

  <!-- Source Control -->
  <div class="panel" data-panel="scm">
    <div class="panel-title"><span>Source Control</span><span class="add">⟳</span></div>
    <div class="commit-box">
      <textarea placeholder="Message (Ctrl+Enter to commit)">feat(auth): scaffold refresh token rotation</textarea>
      <button class="commit-btn">Commit — 3 staged</button>
    </div>
    <div class="sub-label" style="padding-left:14px">Staged — 2</div>
    <div class="scm-row">refresh-token.ts<span class="stat M">M</span></div>
    <div class="scm-row">auth.service.ts<span class="stat M">M</span></div>
    <div class="sub-label" style="padding-left:14px">Changes — 1</div>
    <div class="scm-row">refresh-token.test.ts<span class="stat A">A</span></div>
    <div class="divider"></div>
    <div class="file-row">⎇ main</div>
    <div class="file-row">⎇ feat/refresh-rotation</div>
    <div class="file-row">origin — up to date</div>
  </div>

  <!-- Specs (default active) -->
  <div class="panel active" data-panel="specs">
    <div class="panel-title"><span>Specs</span><span class="add" onclick="vscode.postMessage({command:'newSpec'})">+</span></div>
    ${specs.length === 0
        ? `<div class="file-row" style="color:var(--text-faint);padding:10px 14px">No specs yet — click + to create</div>`
        : specs.map(s => sidebarSpecItem(s, s.id === spec?.id)).join('')}
    <div class="divider"></div>
    <div class="panel-title" style="padding-top:6px"><span>Steering</span><span class="add">+</span></div>
    <div class="file-row"><span class="icon">▤</span> conventions.md</div>
    <div class="file-row"><span class="icon">▤</span> org.security-baseline.md</div>
    <div class="file-row"><span class="icon">▤</span> tech-stack.md<span class="meta">always-on</span></div>
    <div class="divider"></div>
    <div class="panel-title" style="padding-top:6px"><span>Hooks</span><span class="add">+</span></div>
    <div class="hook-row"><div class="hname">on-save → lint + format</div><div class="hdesc">Runs eslint --fix and prettier on every save</div></div>
    <div class="hook-row"><div class="hname">on-commit → run tests</div><div class="hdesc">Blocks commit if unit tests fail</div></div>
    <div class="hook-row"><div class="hname">on-task-complete → update tasks.md</div><div class="hdesc">Checks off task and posts a summary</div></div>
  </div>

  <!-- Debug -->
  <div class="panel" data-panel="debug">
    <div class="panel-title"><span>Run &amp; Debug</span><span class="add">+</span></div>
    <div class="debug-toolbar">
      <div class="icon-btn">${I.PLAY}</div>
      <div class="icon-btn">${I.STEPOVER}</div>
      <div class="icon-btn">${I.STEPINTO}</div>
      <div class="icon-btn">${I.RESTART}</div>
      <div class="icon-btn">${I.STOP}</div>
    </div>
    <div class="sub-label" style="padding-left:14px">Variables</div>
    <div class="var-row"><b>token</b><span class="val">"eyJhbGciOi..."</span></div>
    <div class="var-row"><b>expiresAt</b><span class="val">1725456000</span></div>
    <div class="var-row"><b>session.userId</b><span class="val">"usr_8f21"</span></div>
    <div class="sub-label" style="padding-left:14px">Call stack</div>
    <div class="stack-row top">rotateRefreshToken() refresh-token.ts:14</div>
    <div class="stack-row">handleRefresh() auth.service.ts:41</div>
    <div class="stack-row">router.post() index.ts:22</div>
    <div class="sub-label" style="padding-left:14px">Breakpoints</div>
    <div class="bp-row"><div class="bp-dot"></div> refresh-token.ts:14</div>
    <div class="bp-row"><div class="bp-dot"></div> auth.service.ts:41</div>
  </div>

  <!-- Testing -->
  <div class="panel" data-panel="testing">
    <div class="panel-title"><span>Testing</span><span class="add">▶</span></div>
    <div class="test-row suite"><span class="test-icon pass">✓</span> auth/login.test.ts</div>
    <div class="test-row" style="padding-left:36px"><span class="test-icon pass">✓</span> logs in with valid credentials</div>
    <div class="test-row" style="padding-left:36px"><span class="test-icon pass">✓</span> rejects invalid password</div>
    <div class="test-row suite"><span class="test-icon fail">✕</span> auth/refresh-token.test.ts</div>
    <div class="test-row" style="padding-left:36px"><span class="test-icon fail">✕</span> rotates token before expiry</div>
    <div class="test-row" style="padding-left:36px"><span class="test-icon pending">○</span> rejects reused token</div>
    <div class="test-row suite"><span class="test-icon pending">○</span> billing/webhook.test.ts</div>
    <div class="divider"></div>
    <div class="file-row">3 passed · 1 failed · 1 pending</div>
  </div>

  <!-- Extensions -->
  <div class="panel" data-panel="extensions">
    <div class="panel-title"><span>Extensions</span></div>
    <div class="search-box"><input type="text" placeholder="Search extensions"></div>
    <div class="sub-label" style="padding-left:14px">Installed</div>
    <div class="ext-row"><div class="ext-icon">TS</div><div><div class="ext-name">TypeScript Language Pack</div><div class="ext-desc">IntelliSense, refactors, inline types</div><span class="ext-btn installed">Installed</span></div></div>
    <div class="ext-row"><div class="ext-icon">◈</div><div><div class="ext-name">ESLint</div><div class="ext-desc">Integrates ESLint into the editor</div><span class="ext-btn installed">Installed</span></div></div>
    <div class="ext-row"><div class="ext-icon">▤</div><div><div class="ext-name">Spec Diagrams</div><div class="ext-desc">Renders Mermaid diagrams in design.md</div><span class="ext-btn installed">Installed</span></div></div>
    <div class="sub-label" style="padding-left:14px">Recommended</div>
    <div class="ext-row"><div class="ext-icon">🐘</div><div><div class="ext-name">Postgres Explorer</div><div class="ext-desc">Browse schemas from the sidebar</div><span class="ext-btn install">Install</span></div></div>
    <div class="ext-row"><div class="ext-icon">🐳</div><div><div class="ext-name">Docker</div><div class="ext-desc">Manage containers &amp; compose files</div><span class="ext-btn install">Install</span></div></div>
  </div>

  <!-- MCP -->
  <div class="panel" data-panel="mcp">
    <div class="panel-title"><span>MCP Servers</span><span class="add">+</span></div>
    <div class="mcp-row"><div class="mcp-dot"></div><div class="mcp-name">postgres</div><div class="mcp-tools">6 tools</div></div>
    <div class="mcp-row"><div class="mcp-dot"></div><div class="mcp-name">github</div><div class="mcp-tools">11 tools</div></div>
    <div class="mcp-row"><div class="mcp-dot off"></div><div class="mcp-name">stripe</div><div class="mcp-tools">disconnected</div></div>
    <div class="divider"></div>
    <div class="panel-title" style="padding-top:6px"><span>Agent Rules</span></div>
    <div class="file-row"><span class="icon">▤</span> conventions.md</div>
    <div class="file-row"><span class="icon">▤</span> org.security-baseline.md</div>
    <div class="divider"></div>
    <div class="panel-title" style="padding-top:6px"><span>Autopilot Sessions</span></div>
    <div class="hook-row"><div class="hname">Rate limiting — running</div><div class="hdesc">3 of 5 tasks complete</div></div>
    <div class="hook-row"><div class="hname">Search indexing — queued</div><div class="hdesc">Waiting on design.md approval</div></div>
  </div>

  <!-- Remote -->
  <div class="panel" data-panel="remote">
    <div class="panel-title"><span>Remote</span><span class="add">+</span></div>
    <div class="sub-label" style="padding-left:14px">SSH targets</div>
    <div class="file-row">dev-box<span class="meta">connected</span></div>
    <div class="file-row">staging-01</div>
    <div class="sub-label" style="padding-left:14px">Dev containers</div>
    <div class="file-row">.devcontainer/node20</div>
    <div class="sub-label" style="padding-left:14px">Port forwarding</div>
    <div class="file-row">3000 → local:3000</div>
    <div class="file-row">5432 → local:5432</div>
  </div>

  <!-- Account -->
  <div class="panel" data-panel="account">
    <div class="panel-title"><span>Account</span></div>
    <div class="ext-row"><div class="ext-icon">🟣</div><div><div class="ext-name">Signed in</div><div class="ext-desc">jordan@forgeide.dev · Pro plan</div></div></div>
    <div class="divider"></div>
    <div class="sub-label" style="padding-left:14px">Usage</div>
    <div class="file-row">Agent requests — 412 / 1000 this cycle</div>
    <div class="file-row">Autopilot minutes — 38 / 200</div>
    <div class="divider"></div>
    <div class="file-row">Manage subscription</div>
    <div class="file-row">Sign out</div>
  </div>

  <!-- Settings -->
  <div class="panel" data-panel="settings">
    <div class="panel-title"><span>Settings</span></div>
    <div class="sub-label" style="padding-left:14px">Editor</div>
    <div class="file-row">Font size — 12.5px</div>
    <div class="file-row">Tab size — 2 spaces</div>
    <div class="file-row">Format on save — On</div>
    <div class="sub-label" style="padding-left:14px">Agent</div>
    <div class="file-row">Default mode — Supervised</div>
    <div class="file-row">Default model — Claude Sonnet 4.6</div>
    <div class="sub-label" style="padding-left:14px">Gates</div>
    <div class="file-row">Require approval before codegen — On</div>
    <div class="file-row">Require approval before commit — On</div>
  </div>

</div>`;
}

// =============================================================================
// PART 3 — Editor column, agent panel, bottom panel, status bar
// =============================================================================

function editorColumn(spec: Spec | undefined): string {
    const specTabId = spec ? `spec:${esc(spec.id)}` : 'spec:none';
    return `<div class="editor-col" id="editorCol">
  <div class="tabs" id="tabs">
    ${spec ? `<div class="tab active" data-tab="${specTabId}">${I.SPECS_SM} ${esc(spec.title)}</div>` : ''}
    <div class="tab" data-tab="refresh-token.ts">refresh-token.ts <span class="dirty"></span></div>
    <div class="tab" data-tab="auth.service.ts">auth.service.ts</div>
  </div>
  <div class="breadcrumb" id="breadcrumb">
    ${spec
        ? `<span class="seg">Specs</span> › <span class="seg">${esc(spec.title)}</span>`
        : `<span class="seg">ForgeIDE</span>`}
  </div>
  <div class="view-body">

    <!-- Spec detail -->
    <div class="view-panel active" data-view-panel="${specTabId}">
      ${spec ? specDetailView(spec) : '<div style="color:var(--text-faint);padding:20px">Select a spec from the sidebar.</div>'}
    </div>

    <!-- refresh-token.ts -->
    <div class="view-panel" data-view-panel="refresh-token.ts">
      <div class="gate-banner" id="gateBanner">
        ${I.LOCK} Task "Refresh token rotation" is locked — approve it in the Tasks phase to generate code
        <button onclick="approveGate()">Approve &amp; unlock</button>
      </div>
      <div class="editor-split">
        <div class="editor-body" id="rtCode">
          <div class="code-line"><span class="line-num">1</span><span class="cm">// Blocked: awaiting task approval</span></div>
          <div class="code-line"><span class="line-num">2</span></div>
          <div class="code-line"><span class="line-num">3</span><span class="kw">export</span> <span class="kw">function</span> <span class="fn">rotateRefreshToken</span>(token<span class="kw">:</span> <span class="kw">string</span>) {</div>
          <div class="code-line"><span class="line-num">4</span>&nbsp;&nbsp;<span class="cm">// implementation pending gate approval</span></div>
          <div class="code-line"><span class="line-num">5</span>}</div>
        </div>
        <div class="minimap"></div>
      </div>
    </div>

    <!-- auth.service.ts -->
    <div class="view-panel" data-view-panel="auth.service.ts">
      <div class="editor-split">
        <div class="editor-body">
          <div class="code-line"><span class="line-num">1</span><span class="kw">import</span> { signAccessToken } <span class="kw">from</span> <span class="str">'./tokens'</span>;</div>
          <div class="code-line"><span class="line-num">2</span></div>
          <div class="code-line"><span class="line-num">3</span><span class="kw">export</span> <span class="kw">async</span> <span class="kw">function</span> <span class="fn">handleRefresh</span>(sessionId<span class="kw">:</span> <span class="kw">string</span>) {</div>
          <div class="code-line"><span class="line-num">4</span>&nbsp;&nbsp;<span class="kw">const</span> session <span class="kw">=</span> <span class="kw">await</span> <span class="fn">getSession</span>(sessionId);</div>
          <div class="code-line"><span class="line-num">5</span>&nbsp;&nbsp;<span class="kw">return</span> <span class="fn">signAccessToken</span>(session.userId, { ttl<span class="kw">:</span> <span class="num">900</span> });</div>
          <div class="code-line"><span class="line-num">6</span>}</div>
        </div>
        <div class="minimap"></div>
      </div>
    </div>

  </div>
</div>`;
}

// ── Spec detail view (phase tabs + content) ───────────────────────────────────
function specDetailView(spec: Spec): string {
    const doneTasks = spec.tasks?.filter(t => t.status === 'done').length ?? 0;
    const totalTasks = spec.tasks?.length ?? 0;

    const taskRows = (spec.tasks ?? []).map((t: SpecTask, i: number) => `
    <li style="margin-bottom:8px">
      ${t.status === 'done' ? '☑' : '☐'} ${i + 1}.
      ${t.status === 'done'
        ? esc(t.title)
        : `<b style="color:var(--text)">${esc(t.title)}</b>`}
      ${spec.tasksApproved && t.status !== 'done'
        ? `<button class="impl-btn" onclick="vscode.postMessage({command:'implementTask',taskId:'${esc(t.id)}'})">Implement</button>`
        : ''}
    </li>`).join('');

    const gateInTask = !spec.tasksApproved
        ? `<div class="gate-banner" style="margin:14px 0 0">
            ${I.LOCK}
            ${!spec.requirementsApproved
                ? 'Approve <b>Requirements</b> to continue'
                : !spec.designApproved
                ? 'Approve <b>Design</b> to continue'
                : 'Approve <b>Tasks</b> to unlock code generation'}
            <button onclick="vscode.postMessage({command:'${
                !spec.requirementsApproved ? 'approveRequirements'
                : !spec.designApproved ? 'approveDesign'
                : 'approveTasks'}'})">Approve &amp; unlock</button>
           </div>`
        : `<div class="gate-banner ok" style="margin:14px 0 0">${I.CHECK} All phases approved — code generation is unlocked</div>`;

    return `<div class="spec-detail">
  <div class="spec-detail-header">
    <h1>${esc(spec.title)}</h1>
    <div class="sub">.kiro/specs/${esc(spec.id)}/ — ${doneTasks} of ${totalTasks} tasks complete</div>
  </div>

  <div class="phase-tabs">
    <div class="phase-tab" data-phase="requirements">
      <span class="dot ${spec.requirementsApproved ? 'done' : 'active'}"></span> Requirements
    </div>
    <div class="phase-tab" data-phase="design">
      <span class="dot ${spec.designApproved ? 'done' : spec.requirementsApproved ? 'active' : 'locked'}"></span> Design
    </div>
    <div class="phase-tab active" data-phase="tasks">
      <span class="dot ${spec.tasksApproved ? 'done' : spec.designApproved ? 'active' : 'locked'}"></span> Tasks
    </div>
  </div>

  <!-- Requirements -->
  <div class="phase-content" data-phase-content="requirements">
    ${spec.requirements
        ? spec.requirements.split('\n\n').map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('')
        : '<p style="color:var(--text-faint)">Requirements not generated yet.</p>'}
    <div class="approve-row">
      ${spec.requirementsApproved
        ? '<button class="approve" disabled>✓ Approved</button>'
        : '<button class="approve" onclick="vscode.postMessage({command:\'approveRequirements\'})">Approve Requirements</button>'}
      <button class="revise" ${spec.requirementsApproved ? 'disabled' : ''}>Request Revision</button>
    </div>
  </div>

  <!-- Design -->
  <div class="phase-content" data-phase-content="design">
    ${spec.design
        ? spec.design.split('\n\n').map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('')
        : `<p style="color:var(--text-faint)">${spec.requirementsApproved ? 'Design not generated yet.' : 'Locked — approve requirements first.'}</p>`}
    <div class="approve-row">
      ${spec.designApproved
        ? '<button class="approve" disabled>✓ Approved</button>'
        : `<button class="approve" ${!spec.requirementsApproved ? 'disabled' : ''} onclick="vscode.postMessage({command:'approveDesign'})">Approve Design</button>`}
      <button class="revise" ${!spec.requirementsApproved ? 'disabled' : ''}>Request Revision</button>
    </div>
  </div>

  <!-- Tasks -->
  <div class="phase-content active" data-phase-content="tasks">
    ${spec.tasks?.length
        ? `<ul style="list-style:none;margin-left:0">${taskRows}</ul>`
        : `<p style="color:var(--text-faint)">${spec.designApproved ? 'Tasks not generated yet.' : 'Locked — approve design first.'}</p>`}
    ${gateInTask}
  </div>
</div>`;
}

// ── Agent panel ───────────────────────────────────────────────────────────────
function agentPanel(spec: Spec | undefined): string {
    const locked = spec ? !spec.tasksApproved : true;
    const lockPhase = spec
        ? (!spec.requirementsApproved ? 'Requirements' : !spec.designApproved ? 'Design' : 'Tasks')
        : 'Spec';

    return `<div class="agent-panel" id="agentPanelEl">
  <div class="agent-header">
    <div class="agent-modes" id="agentModes">
      <div class="mode-btn active" data-mode="chat">Chat</div>
      <div class="mode-btn" data-mode="composer">Composer</div>
      <div class="mode-btn" data-mode="autopilot">Autopilot</div>
    </div>
    <div class="agent-toolrow">
      <select class="model-picker" onchange="vscode.postMessage({command:'pickModel'})">
        <option>Claude Sonnet 4.6</option>
        <option>Claude Opus 4.6</option>
        <option>GPT-4o</option>
        <option>Gemini 2.5</option>
      </select>
      <div class="icon-btn" id="rulesBtn" title="Agent rules">${I.RULES}</div>
      <div class="icon-btn" id="canvasBtn" title="Canvas">${I.CANVAS}</div>
    </div>
  </div>

  <div class="agent-body">

    <!-- Chat -->
    <div class="agent-view active" data-agentview="chat">
      <div class="agent-tags">
        ${spec ? `<span class="tag">@${esc(spec.title.slice(0,20))}</span>` : ''}
        <span class="tag">@design.md</span>
        <span class="tag">+ context</span>
      </div>
      <div class="agent-msg"><div class="role">You</div><div class="body">Generate the refresh token rotation task</div></div>
      <div class="agent-msg from-agent">
        <div class="role">Agent</div>
        <div class="body">${locked
            ? `Task is locked — the <b>${lockPhase}</b> phase hasn't been approved yet. Approve it in the Specs panel to unlock code generation.`
            : 'All phases approved. Click <b>Implement</b> on any task or describe what you need below.'}</div>
        <div class="tool-call"><span class="tname">check_gate</span>(task: 3) → ${locked ? 'locked' : 'unlocked'}</div>
      </div>
      <div id="chatMessages"></div>
    </div>

    <!-- Composer -->
    <div class="agent-view" data-agentview="composer">
      <div class="agent-tags"><span class="tag">3 files changed</span></div>
      <div class="composer-file">
        <div class="cf-head"><span>refresh-token.ts</span><span>+9 −1</span></div>
        <div class="cf-diff">
          <div class="diff-line rm">- // implementation pending gate approval</div>
          <div class="diff-line add">+ const hashed = hash(token);</div>
          <div class="diff-line add">+ const record = await db.refreshTokens.find(hashed);</div>
          <div class="diff-line add">+ if (!record || record.revokedAt) throw new Unauthorized();</div>
          <div class="diff-line add">+ await db.refreshTokens.revoke(record.id);</div>
          <div class="diff-line add">+ return issueNewPair(record.userId);</div>
        </div>
        <div class="composer-actions">
          <button class="accept" onclick="acceptDiff(this)">Accept</button>
          <button class="reject" onclick="rejectDiff(this)">Reject</button>
        </div>
      </div>
      <div class="composer-file">
        <div class="cf-head"><span>refresh-token.test.ts</span><span>+14 new</span></div>
        <div class="cf-diff">
          <div class="diff-line add">+ it('rejects reused token', async () => {</div>
          <div class="diff-line add">+   await rotateRefreshToken(token);</div>
          <div class="diff-line add">+   await expect(rotateRefreshToken(token)).rejects.toThrow();</div>
          <div class="diff-line add">+ });</div>
        </div>
        <div class="composer-actions">
          <button class="accept" onclick="acceptDiff(this)">Accept</button>
          <button class="reject" onclick="rejectDiff(this)">Reject</button>
        </div>
      </div>
    </div>

    <!-- Autopilot -->
    <div class="agent-view" data-agentview="autopilot">
      <div class="autopilot-banner">⚡ Autopilot — approved tasks only, changes open a diff before writing.</div>
      <div class="queue-item"><div class="qstatus done"></div> Session token model — merged</div>
      <div class="queue-item"><div class="qstatus done"></div> Login endpoint — merged</div>
      <div class="queue-item"><div class="qstatus running"></div> Refresh token rotation — writing tests</div>
      <div class="queue-item"><div class="qstatus queued"></div> Rate limiting — waiting on gate</div>
      <div class="queue-item"><div class="qstatus queued"></div> Password reset — waiting on design</div>
    </div>

  </div>
  <div class="agent-input"><input type="text" id="agentInput" placeholder="Ask, or approve a phase to unlock..."></div>
</div>`;
}

// ── Bottom panel ──────────────────────────────────────────────────────────────
function bottomPanel(): string {
    return `<div class="bottom-panel" id="bottomPanelEl">
  <div class="bottom-tabs" id="bottomTabs">
    <div class="bottom-tab active" data-bt="terminal">Terminal</div>
    <div class="bottom-tab" data-bt="problems">Problems (2)</div>
    <div class="bottom-tab" data-bt="output">Output</div>
    <div class="bottom-tab" data-bt="debugconsole">Debug Console</div>
    <div class="spacer"></div>
    <div class="bt-icon">${I.SPLIT_TERM}</div>
    <div class="bt-icon">${I.MAXIMIZE}</div>
  </div>
  <div class="bottom-body">
    <div class="bottom-view active" data-btview="terminal">
      <div class="terminal-body">
        <div><span class="prompt">➜</span> npm test</div>
        <div>&nbsp;&nbsp;PASS&nbsp; src/auth/login.test.ts (4 passed)</div>
        <div>&nbsp;&nbsp;FAIL&nbsp; src/auth/refresh-token.test.ts (1 failed, 1 pending)</div>
        <div><span class="hookline">[hook] on-save → lint + format — completed in 340ms</span></div>
        <div><span class="prompt">➜</span> _</div>
      </div>
    </div>
    <div class="bottom-view" data-btview="problems">
      <div class="problem-row"><span class="sev warn">▲</span> 'record' is possibly undefined before the null check<span class="loc">refresh-token.ts:12</span></div>
      <div class="problem-row"><span class="sev err">✕</span> Test "rotates token before expiry" failed: expected 200, got 401<span class="loc">refresh-token.test.ts:9</span></div>
    </div>
    <div class="bottom-view" data-btview="output">
      <div class="output-body">
        [12:04:03] Spec — Tasks phase updated<br>
        [12:04:05] Gate check: task 3 → approved<br>
        [12:04:06] Hook "on-task-complete" registered<br>
        [12:05:41] Extension host started
      </div>
    </div>
    <div class="bottom-view" data-btview="debugconsole">
      <div class="output-body">
        &gt; console.log(session)<br>
        { userId: 'usr_8f21', issuedAt: 1725455100, ttl: 900 }
      </div>
    </div>
  </div>
</div>`;
}

// ── Status bar ────────────────────────────────────────────────────────────────
function statusBar(gateStatus: string, isAutopilot: boolean): string {
    return `<div class="statusbar">
  <span class="item">⎇ main</span>
  <span class="sep">·</span>
  <span class="item">SSH: dev-box</span>
  <span class="sep">·</span>
  <span class="item" id="gateStatus">Gate: ${esc(gateStatus)}</span>
  <span class="sep">·</span>
  <span class="item" id="modeStatus">${isAutopilot ? 'Autopilot mode' : 'Supervised mode'}</span>
  <div class="right">
    <span class="item">${I.WIFI}</span>
    <span class="item">${I.ERR} 0</span>
    <span class="item">${I.WARN} 4</span>
    <span class="item">TypeScript</span>
    <span class="item">UTF-8</span>
    <span class="item">Ln 3, Col 42</span>
  </div>
</div>`;
}

// =============================================================================
// PART 4 — JavaScript (all interactions, injected as a <script> block)
// =============================================================================

const JS = `<script>
(function () {

  // ── Rail → sidebar panel switching + tooltips ────────────────────────────
  const rail = document.getElementById('rail');
  const railTip = document.getElementById('railTip');
  rail.querySelectorAll('.rail-icon').forEach(icon => {
    icon.addEventListener('click', () => {
      rail.querySelectorAll('.rail-icon').forEach(i => i.classList.remove('active'));
      icon.classList.add('active');
      const view = icon.dataset.view;
      document.querySelectorAll('.panel').forEach(p =>
        p.classList.toggle('active', p.dataset.panel === view));
    });
    icon.addEventListener('mouseenter', () => {
      railTip.textContent = icon.dataset.tip || '';
      railTip.style.display = 'block';
      railTip.style.top = icon.getBoundingClientRect().top + 'px';
    });
    icon.addEventListener('mouseleave', () => { railTip.style.display = 'none'; });
  });

  // ── Tab switching ────────────────────────────────────────────────────────
  const tabsEl = document.getElementById('tabs');
  const breadcrumb = document.getElementById('breadcrumb');
  function activateTab(key) {
    tabsEl.querySelectorAll('.tab').forEach(t =>
      t.classList.toggle('active', t.dataset.tab === key));
    document.querySelectorAll('.view-panel').forEach(v =>
      v.classList.toggle('active', v.dataset.viewPanel === key));
    if (key.startsWith('spec:')) {
      breadcrumb.innerHTML = '<span class="seg">Specs</span> › <span class="seg">User auth flow</span>';
    } else {
      breadcrumb.innerHTML =
        '<span class="seg">src</span> › <span class="seg">auth</span> › <span class="seg">' + key + '</span>';
    }
  }
  tabsEl.querySelectorAll('.tab').forEach(tab =>
    tab.addEventListener('click', () => activateTab(tab.dataset.tab)));
  document.querySelectorAll('[data-file]').forEach(row =>
    row.addEventListener('click', () => {
      const f = row.dataset.file;
      if (document.querySelector('.view-panel[data-view-panel="' + f + '"]')) activateTab(f);
    }));

  // ── Phase tabs inside spec detail ────────────────────────────────────────
  document.querySelectorAll('.phase-tab').forEach(pt =>
    pt.addEventListener('click', () => {
      document.querySelectorAll('.phase-tab').forEach(p => p.classList.remove('active'));
      pt.classList.add('active');
      document.querySelectorAll('.phase-content').forEach(pc =>
        pc.classList.toggle('active', pc.dataset.phaseContent === pt.dataset.phase));
    }));

  // ── Spec item selection ──────────────────────────────────────────────────
  document.querySelectorAll('.spec-item[data-id]').forEach(item =>
    item.addEventListener('click', () =>
      vscode.postMessage({ command: 'selectSpec', id: item.dataset.id })));

  // ── Agent mode switching ─────────────────────────────────────────────────
  document.querySelectorAll('#agentModes .mode-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      document.querySelectorAll('#agentModes .mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.agent-view').forEach(v =>
        v.classList.toggle('active', v.dataset.agentview === btn.dataset.mode));
    }));

  // ── Supervised / Autopilot toggle in menu bar ────────────────────────────
  document.getElementById('modeToggle').querySelectorAll('.mode-opt').forEach(opt =>
    opt.addEventListener('click', () => {
      document.getElementById('modeToggle').querySelectorAll('.mode-opt')
        .forEach(o => o.classList.remove('active'));
      opt.classList.add('active');
      const isAuto = opt.dataset.agentmode === 'autopilot';
      document.getElementById('modeStatus').textContent =
        isAuto ? 'Autopilot mode' : 'Supervised mode';
      if (isAuto) {
        document.querySelectorAll('#agentModes .mode-btn').forEach(b =>
          b.classList.toggle('active', b.dataset.mode === 'autopilot'));
        document.querySelectorAll('.agent-view').forEach(v =>
          v.classList.toggle('active', v.dataset.agentview === 'autopilot'));
      }
      vscode.postMessage({ command: 'toggleAutopilot' });
    }));

  // ── Bottom panel tab switching ───────────────────────────────────────────
  document.querySelectorAll('#bottomTabs .bottom-tab').forEach(bt =>
    bt.addEventListener('click', () => {
      document.querySelectorAll('#bottomTabs .bottom-tab').forEach(b => b.classList.remove('active'));
      bt.classList.add('active');
      document.querySelectorAll('.bottom-view').forEach(v =>
        v.classList.toggle('active', v.dataset.btview === bt.dataset.bt));
    }));

  // ── Layout toggles (sidebar / split / bottom / agent) ───────────────────
  document.querySelectorAll('#layoutToggles .layout-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      btn.classList.toggle('on');
      const on = btn.classList.contains('on');
      const layout = btn.dataset.layout;
      const mainRow = document.getElementById('mainRow');
      if (layout === 'sidebar') {
        document.getElementById('sidebarEl').style.display = on ? '' : 'none';
        mainRow.style.gridTemplateColumns = on ? '' : '48px 0 1fr minmax(260px,320px)';
      }
      if (layout === 'agent')  document.getElementById('agentPanelEl').style.display = on ? 'flex' : 'none';
      if (layout === 'bottom') document.getElementById('bottomPanelEl').style.display = on ? 'flex' : 'none';
    }));

  // ── Icon btn toggles ─────────────────────────────────────────────────────
  document.getElementById('rulesBtn').addEventListener('click', function() { this.classList.toggle('on'); });
  document.getElementById('canvasBtn').addEventListener('click', function() { this.classList.toggle('on'); });

  // ── Search toggles ───────────────────────────────────────────────────────
  document.querySelectorAll('.search-toggle').forEach(t =>
    t.addEventListener('click', () => t.classList.toggle('on')));

  // ── Explorer tree expand / collapse ──────────────────────────────────────
  document.querySelectorAll('.file-row.tree[data-open]').forEach(row =>
    row.addEventListener('click', () => {
      const open = row.dataset.open === 'true';
      row.dataset.open = open ? 'false' : 'true';
      const icon = row.querySelector('.icon');
      if (icon) icon.textContent = open ? '▸' : '▾';
    }));

  // ── Gate approval ────────────────────────────────────────────────────────
  window.approveGate = function () {
    const banner = document.getElementById('gateBanner');
    if (banner) {
      banner.className = 'gate-banner ok';
      banner.innerHTML = '✓ Task 3 approved — code generation unlocked';
    }
    document.getElementById('rtCode').innerHTML = [
      '<div class="code-line"><span class="line-num">1</span><span class="kw">import</span> { hash } <span class="kw">from</span> <span class="str">\\'../crypto\\'</span>;</div>',
      '<div class="code-line"><span class="line-num">2</span></div>',
      '<div class="code-line"><span class="line-num">3</span><span class="kw">export</span> <span class="kw">async</span> <span class="kw">function</span> <span class="fn">rotateRefreshToken</span>(token<span class="kw">:</span> <span class="kw">string</span>) {</div>',
      '<div class="code-line"><span class="line-num">4</span>&nbsp;&nbsp;<span class="kw">const</span> hashed <span class="kw">=</span> <span class="fn">hash</span>(token);</div>',
      '<div class="code-line"><span class="line-num">5</span>&nbsp;&nbsp;<span class="kw">const</span> record <span class="kw">=</span> <span class="kw">await</span> db.refreshTokens.<span class="fn">find</span>(hashed);</div>',
      '<div class="code-line"><span class="line-num">6</span>&nbsp;&nbsp;<span class="kw">if</span> (!record || record.revokedAt) <span class="kw">throw new</span> <span class="fn">Unauthorized</span>();</div>',
      '<div class="code-line"><span class="line-num">7</span>&nbsp;&nbsp;<span class="kw">await</span> db.refreshTokens.<span class="fn">revoke</span>(record.id);</div>',
      '<div class="code-line"><span class="line-num">8</span>&nbsp;&nbsp;<span class="kw">return</span> <span class="fn">issueNewPair</span>(record.userId);</div>',
      '<div class="code-line"><span class="line-num">9</span>}</div>'
    ].join('');
    document.getElementById('gateStatus').textContent = 'Gate: Task 3 unlocked';
    document.querySelectorAll('.task-row').forEach(r => {
      if (r.textContent.includes('Refresh token rotation')) {
        r.classList.add('done');
        const chk = r.querySelector('.task-check');
        if (chk) { chk.classList.add('done'); chk.textContent = '✓'; }
      }
    });
    activateTab('refresh-token.ts');
  };

  // ── Composer accept / reject ─────────────────────────────────────────────
  window.acceptDiff = function (btn) {
    const file = btn.closest('.composer-file');
    file.style.opacity = '0.4';
    file.style.pointerEvents = 'none';
    btn.textContent = '✓ Accepted';
    btn.style.background = 'var(--green-dim)';
    btn.style.color = 'var(--green)';
  };
  window.rejectDiff = function (btn) {
    btn.closest('.composer-file').remove();
  };

  // ── Agent chat input — send on Enter ─────────────────────────────────────
  document.getElementById('agentInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && this.value.trim()) {
      const chatMessages = document.getElementById('chatMessages');
      const msg = document.createElement('div');
      msg.className = 'agent-msg';
      msg.innerHTML =
        '<div class="role">You</div><div class="body">' + this.value + '</div>';
      chatMessages.appendChild(msg);
      this.value = '';
      msg.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  });

})();
</script>`;

// =============================================================================
// PART 5 — CSS (Gatework v2 design tokens + complete layout)
// =============================================================================

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
:root{
  --bg:#19161d;--surface:#28242e;--surface-raised:#322d39;--surface-hover:#352f3d;
  --border:#211d25;--text:#ececec;--text-dim:#b3aeb9;--text-faint:#6b6772;
  --purple:#8b5cf6;--purple-line:#b080ff;--purple-badge:#7138cc;
  --purple-dim:rgba(139,92,246,0.16);
  --green:#4ade80;--green-dim:rgba(74,222,128,0.14);
  --amber:#fbbf24;--amber-dim:rgba(251,191,36,0.14);
  --red:#f87171;--red-dim:rgba(248,113,113,0.14);--blue:#60a5fa;
}
*{box-sizing:border-box;margin:0;padding:0;}
body{background:var(--bg);color:var(--text);font-family:'Inter',sans-serif;font-size:12.5px;height:100vh;overflow:hidden;}
button,input,select,textarea{font-family:inherit;}
::-webkit-scrollbar{width:8px;height:8px;}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px;}
::-webkit-scrollbar-track{background:transparent;}

/* Shell: menubar(30) + focusbar(34) + main(1fr) + bottom(190) + statusbar(22) */
.shell{display:grid;grid-template-rows:30px 34px 1fr 190px 22px;height:100vh;}

/* ── Menu bar ── */
.menubar{background:var(--bg);border-bottom:1px solid var(--border);display:flex;align-items:center;padding:0 10px;gap:16px;font-size:12px;color:var(--text-dim);}
.menubar .brand{color:var(--text);font-weight:600;display:flex;align-items:center;gap:6px;margin-right:8px;}
.menubar .brand svg{width:14px;height:14px;}
.menubar span.item{cursor:pointer;}
.menubar span.item:hover{color:var(--text);}
.menubar .spacer{flex:1;}
.menubar .mode-toggle{display:flex;align-items:center;gap:6px;background:var(--surface-raised);border:1px solid var(--border);border-radius:5px;padding:3px 4px;}
.menubar .mode-opt{padding:2px 9px;border-radius:4px;font-size:10.5px;font-weight:600;cursor:pointer;color:var(--text-faint);}
.menubar .mode-opt.active{background:var(--purple-dim);color:var(--purple);}

/* ── Focus bar ── */
.focusbar{background:var(--bg);border-bottom:1px solid var(--border);display:flex;align-items:stretch;padding:0 10px;}
.focus-tab{display:flex;align-items:center;gap:7px;padding:8px 10px 7px;font-size:12px;color:var(--text-dim);border-bottom:2px solid var(--purple-line);cursor:pointer;}
.focus-tab svg{width:15px;height:15px;}
.focusbar .spacer{flex:1;}
.layout-toggles{display:flex;align-items:center;gap:3px;padding:6px 0;}
.layout-btn{width:26px;height:24px;border-radius:5px;display:flex;align-items:center;justify-content:center;color:var(--text-faint);cursor:pointer;}
.layout-btn:hover{background:var(--surface-hover);color:var(--text);}
.layout-btn.on{color:var(--text);}
.layout-btn svg{width:17px;height:17px;}

/* ── Main row ── */
.main-row{display:grid;grid-template-columns:48px minmax(230px,290px) 1fr minmax(260px,320px);overflow:hidden;}

/* ── Rail ── */
.rail{background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;align-items:center;padding-top:10px;gap:2px;}
.rail-icon{width:32px;height:32px;display:flex;align-items:center;justify-content:center;border-radius:6px;color:var(--text-faint);cursor:pointer;position:relative;}
.rail-icon:hover{color:var(--text-dim);background:var(--surface-raised);}
.rail-icon.active{background:var(--purple-dim);color:var(--purple);}
.rail-icon svg{width:17px;height:17px;}
.rail-icon .badge{position:absolute;top:2px;right:2px;width:6px;height:6px;border-radius:50%;background:var(--amber);}
.rail-spacer{flex:1;}
.rail-tip{position:fixed;left:52px;background:var(--surface-raised);border:1px solid var(--border);padding:3px 8px;border-radius:4px;font-size:11px;pointer-events:none;z-index:50;display:none;white-space:nowrap;}
.rail-icon.account .avatar-badge{position:absolute;bottom:-1px;right:-2px;width:13px;height:13px;border-radius:50%;background:var(--purple-badge);border:2px solid var(--surface);display:flex;align-items:center;justify-content:center;}
.rail-icon.account .avatar-badge svg{width:7.5px;height:7.5px;color:#fff;}

/* ── Sidebar ── */
.sidebar{background:var(--surface);border-right:1px solid var(--border);overflow:hidden;position:relative;}
.panel{display:none;flex-direction:column;height:100%;overflow-y:auto;}
.panel.active{display:flex;}
.panel-title{padding:10px 14px 8px;font-weight:600;font-size:10.5px;letter-spacing:0.06em;text-transform:uppercase;color:var(--text-dim);display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;background:var(--surface);z-index:2;}
.panel-title .add{color:var(--purple);font-size:15px;font-weight:400;cursor:pointer;line-height:1;}
.panel-title .add:hover{color:#fff;}
.panel-title .icon-actions{display:flex;align-items:center;gap:2px;}
.panel-title .picon{width:22px;height:22px;display:flex;align-items:center;justify-content:center;border-radius:5px;color:var(--text-dim);cursor:pointer;}
.panel-title .picon:hover,.panel-title .picon.on{background:var(--surface-hover);color:var(--text);}
.panel-title .picon svg{width:14px;height:14px;}
.spec-item{margin:3px 10px;padding:8px 10px;border-radius:6px;cursor:pointer;border:1px solid transparent;}
.spec-item:hover{background:var(--surface-hover);}
.spec-item.selected{background:var(--purple-dim);border-color:rgba(139,92,246,0.3);}
.spec-name{font-weight:500;font-size:12px;margin-bottom:6px;}
.phase-pills{display:flex;gap:4px;}
.pill{font-size:9px;padding:2px 6px;border-radius:9px;font-weight:500;}
.pill.done{background:var(--green-dim);color:var(--green);}
.pill.active{background:var(--purple-dim);color:var(--purple);}
.pill.locked{background:var(--surface-raised);color:var(--text-faint);}
.task-list{padding:2px 10px 6px 24px;display:flex;flex-direction:column;gap:1px;}
.task-row{display:flex;align-items:center;gap:7px;padding:4px 5px;font-size:11.5px;color:var(--text-dim);cursor:pointer;border-radius:4px;}
.task-row:hover{background:var(--surface-hover);}
.task-row.done{color:var(--text);}
.task-check{width:12px;height:12px;border:1.5px solid var(--border);border-radius:3px;flex-shrink:0;display:flex;align-items:center;justify-content:center;}
.task-check.done{background:var(--green);border-color:var(--green);color:#041;font-size:9px;}
.task-check.active-task{border-color:var(--purple);}
.sub-label{font-size:10px;color:var(--text-faint);padding:8px 4px 4px;letter-spacing:0.04em;text-transform:uppercase;}
.file-row{padding:5px 14px 5px 24px;font-size:11.5px;color:var(--text-dim);display:flex;align-items:center;gap:7px;cursor:pointer;}
.file-row:hover{background:var(--surface-hover);color:var(--text);}
.file-row .icon{width:13px;opacity:0.65;}
.file-row .meta{margin-left:auto;font-size:9.5px;color:var(--text-faint);}
.file-row.tree{padding-left:34px;}
.hook-row{margin:3px 10px;padding:7px 10px;border-radius:6px;background:var(--surface-raised);font-size:11px;}
.hook-row .hname{color:var(--text);font-weight:500;margin-bottom:2px;}
.hook-row .hdesc{color:var(--text-faint);font-size:10.5px;}
.mcp-row{padding:6px 14px 6px 22px;display:flex;align-items:center;gap:8px;}
.mcp-dot{width:7px;height:7px;border-radius:50%;background:var(--green);flex-shrink:0;}
.mcp-dot.off{background:var(--text-faint);}
.mcp-name{font-size:11.5px;color:var(--text);}
.mcp-tools{font-size:9.5px;color:var(--text-faint);margin-left:auto;}
.divider{border-top:1px solid var(--border);margin:4px 0;}
.search-box{margin:8px 12px;}
.search-box input{width:100%;background:var(--surface-raised);border:1px solid var(--border);border-radius:5px;padding:6px 9px;color:var(--text);font-size:11.5px;}
.search-box input:focus{outline:1px solid var(--purple);}
.search-toggles{display:flex;gap:5px;margin:0 12px 8px;}
.search-toggle{font-size:9.5px;padding:2px 7px;border-radius:4px;background:var(--surface-raised);color:var(--text-dim);cursor:pointer;border:1px solid var(--border);}
.search-toggle.on{color:var(--purple);border-color:var(--purple);background:var(--purple-dim);}
.search-result-file{padding:5px 12px;font-size:11px;color:var(--text-dim);display:flex;justify-content:space-between;}
.search-result-file .count{background:var(--surface-raised);border-radius:8px;padding:0 6px;font-size:9.5px;}
.search-result-line{padding:3px 12px 3px 22px;font-size:11px;font-family:'JetBrains Mono',monospace;color:var(--text-faint);cursor:pointer;}
.search-result-line:hover{background:var(--surface-hover);}
.search-result-line mark{background:var(--amber-dim);color:var(--amber);border-radius:2px;}
.commit-box{margin:8px 12px;}
.commit-box textarea{width:100%;resize:none;height:46px;background:var(--surface-raised);border:1px solid var(--border);border-radius:5px;padding:7px 9px;color:var(--text);font-size:11.5px;}
.commit-btn{width:100%;margin-top:6px;padding:7px;background:var(--purple);color:#fff;border:none;border-radius:5px;font-weight:600;font-size:11.5px;cursor:pointer;}
.commit-btn:hover{background:#6c5ce8;}
.scm-row{padding:4px 12px 4px 22px;font-size:11.5px;display:flex;align-items:center;gap:7px;color:var(--text-dim);cursor:pointer;}
.scm-row:hover{background:var(--surface-hover);}
.scm-row .stat{margin-left:auto;font-size:10px;font-weight:700;width:12px;text-align:center;}
.stat.M{color:var(--amber);}.stat.A{color:var(--green);}.stat.D{color:var(--red);}
.debug-toolbar{display:flex;gap:6px;padding:8px 12px;}
.var-row{padding:4px 20px;font-size:11px;font-family:'JetBrains Mono',monospace;color:var(--text-dim);display:flex;justify-content:space-between;}
.var-row b{color:var(--text);font-weight:500;}.var-row .val{color:var(--blue);}
.stack-row{padding:5px 20px;font-size:11px;color:var(--text-dim);}
.stack-row.top{color:var(--text);background:var(--purple-dim);}
.bp-row{padding:4px 20px;font-size:11px;color:var(--text-dim);display:flex;align-items:center;gap:7px;}
.bp-dot{width:9px;height:9px;border-radius:50%;background:var(--red);flex-shrink:0;}
.test-row{padding:4px 14px 4px 22px;font-size:11.5px;display:flex;align-items:center;gap:7px;color:var(--text-dim);cursor:pointer;}
.test-row:hover{background:var(--surface-hover);}
.test-row.suite{color:var(--text);font-weight:500;padding-left:12px;}
.test-icon{width:13px;height:13px;flex-shrink:0;display:flex;align-items:center;justify-content:center;border-radius:50%;font-size:9px;}
.test-icon.pass{background:var(--green-dim);color:var(--green);}
.test-icon.fail{background:var(--red-dim);color:var(--red);}
.test-icon.pending{background:var(--surface-raised);color:var(--text-faint);}
.ext-row{margin:4px 10px;padding:8px 10px;border-radius:6px;display:flex;gap:9px;cursor:pointer;}
.ext-row:hover{background:var(--surface-hover);}
.ext-icon{width:30px;height:30px;border-radius:6px;background:var(--surface-raised);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:13px;}
.ext-name{font-weight:500;font-size:12px;}.ext-desc{font-size:10.5px;color:var(--text-faint);margin-top:2px;}
.ext-btn{font-size:9.5px;padding:2px 8px;border-radius:4px;margin-top:5px;display:inline-block;}
.ext-btn.installed{color:var(--text-faint);}.ext-btn.install{background:var(--purple-dim);color:var(--purple);}

/* ── Editor column ── */
.editor-col{display:flex;flex-direction:column;background:var(--bg);overflow:hidden;}
.tabs{display:flex;border-bottom:1px solid var(--border);background:var(--bg);overflow-x:auto;}
.tab{padding:8px 14px;font-size:12px;color:var(--text-dim);border-right:1px solid var(--border);display:flex;align-items:center;gap:7px;cursor:pointer;white-space:nowrap;}
.tab:hover{color:var(--text);}
.tab.active{color:var(--text);background:var(--bg);border-top:2px solid var(--purple);padding-top:6px;}
.tab .dirty{width:6px;height:6px;border-radius:50%;background:var(--amber);}
.breadcrumb{padding:5px 16px;font-size:11px;color:var(--text-faint);border-bottom:1px solid var(--border);background:#08080a;display:flex;align-items:center;gap:5px;}
.breadcrumb span.seg{color:var(--text-dim);}.breadcrumb span.seg:last-child{color:var(--text);}
.view-body{flex:1;overflow:hidden;display:flex;flex-direction:column;}
.view-panel{display:none;flex:1;overflow-y:auto;flex-direction:column;}
.view-panel.active{display:flex;}
.editor-split{flex:1;display:flex;overflow:hidden;}
.editor-body{flex:1;padding:16px 20px;font-family:'JetBrains Mono',monospace;font-size:12.5px;line-height:1.75;color:var(--text-dim);overflow-y:auto;}
.code-line{display:flex;gap:18px;}
.line-num{color:var(--text-faint);width:22px;text-align:right;user-select:none;flex-shrink:0;}
.kw{color:#c792ea;}.str{color:var(--green);}.fn{color:#82aaff;}.cm{color:var(--text-faint);font-style:italic;}.num{color:var(--amber);}
.minimap{width:60px;background:#08080a;border-left:1px solid var(--border);opacity:0.5;position:relative;flex-shrink:0;}
.minimap::after{content:"";position:absolute;top:0;left:4px;right:4px;height:60px;background:var(--purple-dim);border-radius:2px;}
.gate-banner{margin:12px 20px 0;padding:9px 12px;background:var(--purple-dim);border:1px solid rgba(139,92,246,0.4);border-radius:6px;font-size:11.5px;color:var(--purple);display:flex;align-items:center;gap:10px;}
.gate-banner button{margin-left:auto;background:var(--purple);color:#fff;border:none;padding:5px 11px;border-radius:5px;font-size:11px;font-weight:600;cursor:pointer;}
.gate-banner button:hover{background:#6c5ce8;}
.gate-banner.ok{background:var(--green-dim);border-color:rgba(74,222,128,0.4);color:var(--green);}

/* ── Spec detail ── */
.spec-detail{flex:1;overflow-y:auto;}
.spec-detail-header{padding:16px 24px 0;}
.spec-detail-header h1{font-size:17px;font-weight:600;}
.spec-detail-header .sub{font-size:11.5px;color:var(--text-faint);margin-top:3px;}
.phase-tabs{display:flex;gap:4px;margin:14px 24px 0;border-bottom:1px solid var(--border);}
.phase-tab{padding:8px 14px;font-size:12px;color:var(--text-dim);cursor:pointer;border-bottom:2px solid transparent;display:flex;align-items:center;gap:6px;}
.phase-tab.active{color:var(--text);border-color:var(--purple);}
.phase-tab .dot{width:6px;height:6px;border-radius:50%;}
.phase-tab .dot.done{background:var(--green);}.phase-tab .dot.active{background:var(--purple);}.phase-tab .dot.locked{background:var(--text-faint);}
.phase-content{display:none;padding:18px 24px 30px;max-width:720px;font-size:12.5px;line-height:1.75;color:var(--text-dim);}
.phase-content.active{display:block;}
.phase-content p{margin-bottom:8px;}
.approve-row{display:flex;gap:8px;margin-top:18px;}
.approve-row button{padding:7px 14px;border-radius:6px;font-size:11.5px;font-weight:600;cursor:pointer;border:none;}
.approve-row .approve{background:var(--purple);color:#fff;}
.approve-row .approve:hover:not(:disabled){background:#6c5ce8;}
.approve-row .approve:disabled{opacity:0.5;cursor:default;}
.approve-row .revise{background:var(--surface-raised);color:var(--text-dim);border:1px solid var(--border);}
.approve-row .revise:disabled{opacity:0.4;cursor:default;}
.impl-btn{background:var(--purple-dim);color:var(--purple);border:1px solid rgba(139,92,246,0.3);padding:3px 9px;border-radius:4px;font-size:10.5px;cursor:pointer;vertical-align:middle;}
.impl-btn:hover{background:var(--purple);color:#fff;}

/* ── Agent panel ── */
.agent-panel{background:var(--surface);border-left:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden;}
.agent-header{padding:10px 12px;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:8px;}
.agent-modes{display:flex;gap:4px;}
.mode-btn{flex:1;text-align:center;padding:5px;border-radius:5px;font-size:10.5px;font-weight:500;color:var(--text-dim);background:var(--surface-raised);cursor:pointer;border:none;}
.mode-btn:hover{color:var(--text);}
.mode-btn.active{background:var(--purple-dim);color:var(--purple);}
.agent-toolrow{display:flex;gap:6px;align-items:center;}
.model-picker{flex:1;background:var(--surface-raised);border:1px solid var(--border);border-radius:5px;padding:5px 8px;font-size:11px;color:var(--text-dim);}
.icon-btn{width:26px;height:26px;border-radius:5px;background:var(--surface-raised);display:flex;align-items:center;justify-content:center;color:var(--text-dim);cursor:pointer;border:none;flex-shrink:0;}
.icon-btn:hover{color:var(--text);background:var(--surface-hover);}
.icon-btn svg{width:13px;height:13px;}
.icon-btn.on{color:var(--purple);background:var(--purple-dim);}
.agent-body{flex:1;overflow-y:auto;display:flex;flex-direction:column;}
.agent-view{display:none;flex-direction:column;flex:1;}
.agent-view.active{display:flex;}
.agent-msg{margin:10px 12px;font-size:12px;line-height:1.55;}
.agent-msg .role{font-size:10px;font-weight:600;color:var(--text-dim);margin-bottom:3px;text-transform:uppercase;letter-spacing:0.03em;}
.agent-msg.from-agent .role{color:var(--purple);}
.agent-msg .body{color:var(--text);}
.agent-msg .tool-call{margin-top:6px;background:var(--surface-raised);border:1px solid var(--border);border-radius:6px;padding:6px 9px;font-family:'JetBrains Mono',monospace;font-size:10.5px;color:var(--text-dim);}
.agent-msg .tool-call .tname{color:var(--blue);}
.agent-tags{display:flex;gap:5px;padding:0 10px 8px;flex-wrap:wrap;}
.tag{font-size:10px;padding:2px 7px;border-radius:9px;background:var(--surface-raised);color:var(--text-dim);}
.agent-input{margin-top:auto;padding:10px;border-top:1px solid var(--border);}
.agent-input input{width:100%;background:var(--surface-raised);border:1px solid var(--border);border-radius:6px;padding:8px 10px;color:var(--text);font-size:11.5px;}
.agent-input input:focus{outline:1px solid var(--purple);}
.composer-file{margin:8px 10px;border:1px solid var(--border);border-radius:6px;overflow:hidden;}
.composer-file .cf-head{padding:6px 9px;font-size:11px;background:var(--surface-raised);display:flex;justify-content:space-between;color:var(--text-dim);}
.composer-file .cf-diff{font-family:'JetBrains Mono',monospace;font-size:10.5px;padding:6px 0;}
.diff-line{padding:1px 10px;white-space:pre;}
.diff-line.add{background:rgba(74,222,128,0.08);color:var(--green);}
.diff-line.rm{background:rgba(248,113,113,0.08);color:var(--red);}
.composer-actions{display:flex;gap:6px;padding:8px 10px;}
.composer-actions button{flex:1;padding:6px;border-radius:5px;font-size:11px;font-weight:600;border:none;cursor:pointer;}
.composer-actions .accept{background:var(--green);color:#04150a;}
.composer-actions .reject{background:var(--surface-raised);color:var(--text-dim);}
.queue-item{margin:6px 10px;padding:8px 10px;border-radius:6px;background:var(--surface-raised);display:flex;align-items:center;gap:8px;font-size:11.5px;}
.queue-item .qstatus{width:8px;height:8px;border-radius:50%;flex-shrink:0;}
.queue-item .qstatus.done{background:var(--green);}
.queue-item .qstatus.running{background:var(--purple);animation:pulse 1.4s infinite;}
.queue-item .qstatus.queued{background:var(--text-faint);}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.35}}
.autopilot-banner{margin:10px;padding:9px 11px;border-radius:6px;background:var(--amber-dim);color:var(--amber);font-size:11px;display:flex;gap:8px;align-items:center;}

/* ── Bottom panel ── */
.bottom-panel{background:var(--surface);border-top:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden;}
.bottom-tabs{display:flex;border-bottom:1px solid var(--border);padding:0 8px;align-items:center;}
.bottom-tab{padding:6px 12px;font-size:11px;color:var(--text-dim);cursor:pointer;border-bottom:2px solid transparent;}
.bottom-tab:hover{color:var(--text);}
.bottom-tab.active{color:var(--text);border-color:var(--purple);}
.bottom-tabs .spacer{flex:1;}
.bottom-tabs .bt-icon{width:22px;height:22px;display:flex;align-items:center;justify-content:center;color:var(--text-faint);cursor:pointer;}
.bottom-tabs .bt-icon svg{width:12px;height:12px;}
.bottom-body{flex:1;overflow-y:auto;}
.bottom-view{display:none;height:100%;}
.bottom-view.active{display:block;}
.terminal-body{padding:8px 14px;font-family:'JetBrains Mono',monospace;font-size:11.5px;color:var(--text-dim);}
.terminal-body .prompt{color:var(--green);}.terminal-body .hookline{color:var(--purple);}
.problem-row{padding:5px 14px;font-size:11.5px;display:flex;gap:8px;align-items:flex-start;color:var(--text-dim);}
.problem-row .sev{flex-shrink:0;margin-top:1px;}
.problem-row .sev.warn{color:var(--amber);}.problem-row .sev.err{color:var(--red);}
.problem-row .loc{color:var(--text-faint);margin-left:auto;flex-shrink:0;}
.output-body{padding:8px 14px;font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text-faint);}

/* ── Status bar ── */
.statusbar{background:var(--bg);color:var(--text-dim);border-top:1px solid var(--border);display:flex;align-items:center;padding:0 12px;font-size:10.5px;font-weight:500;gap:12px;}
.statusbar .item{display:flex;align-items:center;gap:4px;}
.statusbar .sep{opacity:0.35;}
.statusbar .right{margin-left:auto;display:flex;gap:12px;}
.statusbar .item svg{width:12px;height:12px;}
`;

// =============================================================================
// PART 6 — SVG icon constants + helper functions
// =============================================================================

// All icons are referenced via the I namespace object throughout the file.
const I = {
  LOGO:       `<svg viewBox="0 0 24 24" fill="none" style="width:14px;height:14px"><path d="M12 2L21 7V17L12 22L3 17V7Z" stroke="#8b5cf6" stroke-width="1.8" stroke-linejoin="round"/><path d="M8 12.5L11 15.5L16 9" stroke="#8b5cf6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  EXPLORER:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7l3-3h6l2 2h7v11a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/></svg>`,
  SEARCH:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>`,
  GIT:        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="12" r="2.5"/><path d="M6 8.5v7M8 12h7.5a2.5 2.5 0 002.5-2.5"/></svg>`,
  SPECS:      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 3v18M4 8h5M4 16h5"/><path d="M15 3v18M20 8h-5M20 16h-5"/></svg>`,
  SPECS_SM:   `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 3v18M4 8h5M4 16h5"/><path d="M15 3v18M20 8h-5M20 16h-5"/></svg>`,
  DEBUG:      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/></svg>`,
  TEST:       `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 3v4l-5 9a2 2 0 002 3h12a2 2 0 002-3l-5-9V3M9 3h6"/></svg>`,
  EXT:        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3v3.5a1.5 1.5 0 003 0V3h3v14h-3.5a1.5 1.5 0 000 3H20v-3M4 17h3.5a1.5 1.5 0 000-3H4v-3h3.5a1.5 1.5 0 000-3H4V4h14"/></svg>`,
  AGENTS:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>`,
  REMOTE:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 8h.01M6 12h.01"/></svg>`,
  ACCOUNT:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-6 8-6s8 2 8 6"/></svg>`,
  SETTINGS:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>`,
  CHECK_TINY: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 13l4 4L19 7"/></svg>`,
  LOCK:       `<svg style="width:13px;height:13px;flex-shrink:0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="11" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/></svg>`,
  CHECK:      `<svg style="width:13px;height:13px;flex-shrink:0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12l5 5L20 7"/></svg>`,
  FOCUS:      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="6" width="12" height="10" rx="1.5"/><rect x="9" y="3" width="12" height="10" rx="1.5" fill="var(--bg)"/></svg>`,
  LAY_SIDEBAR:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="5" width="7" height="14" rx="1.5"/><rect x="13" y="5" width="8" height="6" rx="1.5"/><rect x="13" y="13" width="8" height="6" rx="1.5"/></svg>`,
  LAY_SPLIT:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 5v14"/></svg>`,
  LAY_BOTTOM: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 14.5h18"/></svg>`,
  LAY_CHAT:   `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3C6.9 3 3 6.4 3 10.6c0 2.4 1.3 4.6 3.4 6L5 21l4.4-1.8c.8.2 1.7.3 2.6.3 5.1 0 9-3.4 9-7.6S17.1 3 12 3z"/></svg>`,
  RULES:      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 2H7a2 2 0 00-2 2v16a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M9 2v6h6"/></svg>`,
  CANVAS:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>`,
  PLAY:       `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`,
  STEPOVER:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12h11M11 7l5 5-5 5"/><path d="M19 6v12"/></svg>`,
  STEPINTO:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 4v11M7 11l5 5 5-5"/></svg>`,
  RESTART:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 105-8.1"/><path d="M3 4v5h5"/></svg>`,
  STOP:       `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12"/></svg>`,
  NEW_FILE:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 2.5h8l4 4V19a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 014 19V4a1.5 1.5 0 011.5-1.5z"/><path d="M14 2.5V7h4"/><path d="M12.5 12.5v6M9.5 15.5h6"/></svg>`,
  NEW_FOLDER: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 6.5a1.5 1.5 0 011.5-1.5h4l2 2h9A1.5 1.5 0 0121 8.5v9A1.5 1.5 0 0119.5 19h-15A1.5 1.5 0 013 17.5z"/><path d="M12 12v6M9 15h6"/></svg>`,
  REFRESH:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 11A8 8 0 105.5 16.5"/><path d="M20 5v6h-6"/></svg>`,
  COLLAPSE:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="8" y="4" width="11" height="11" rx="1.5"/><rect x="5" y="8" width="11" height="11" rx="1.5" fill="var(--surface)"/><path d="M8 13.5h5"/></svg>`,
  MORE:       `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>`,
  SPLIT_TERM: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18"/></svg>`,
  MAXIMIZE:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 00-2 2v3M16 3h3a2 2 0 012 2v3M8 21H5a2 2 0 01-2-2v-3M16 21h3a2 2 0 002-2v-3"/></svg>`,
  WIFI:       `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px"><path d="M4 9a13 13 0 0116 0M7 13a8 8 0 0110 0"/><circle cx="12" cy="18" r="1.4" fill="currentColor" stroke="none"/></svg>`,
  ERR:        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="width:12px;height:12px"><circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/></svg>`,
  WARN:       `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="width:12px;height:12px"><path d="M12 3.5l9.5 16.5H2.5z"/><path d="M12 10v4.5M12 17.2h.01"/></svg>`,
};

// ── Sidebar spec item ─────────────────────────────────────────────────────────
function sidebarSpecItem(spec: Spec, selected: boolean): string {
    const taskRows = (spec.tasks ?? []).slice(0, 5).map(t => `
    <div class="task-row ${t.status === 'done' ? 'done' : ''}">
      <div class="task-check ${t.status === 'done' ? 'done' : t.status === 'in_progress' ? 'active-task' : ''}">${t.status === 'done' ? '✓' : ''}</div>
      ${esc(t.title)}
    </div>`).join('');

    const reqA = spec.requirementsApproved, desA = spec.designApproved, tskA = spec.tasksApproved;
    return `
  <div class="spec-item${selected ? ' selected' : ''}" data-id="${esc(spec.id)}">
    <div class="spec-name">${esc(spec.title)}</div>
    <div class="phase-pills">
      <span class="pill ${reqA ? 'done' : !reqA ? 'active' : 'locked'}">Req</span>
      <span class="pill ${desA ? 'done' : reqA && !desA ? 'active' : 'locked'}">Design</span>
      <span class="pill ${tskA ? 'done' : desA && !tskA ? 'active' : 'locked'}">Tasks</span>
    </div>
  </div>
  ${selected && spec.tasks?.length ? `<div class="task-list">${taskRows}</div>` : ''}`;
}

// ── HTML escape helper ────────────────────────────────────────────────────────
function esc(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
