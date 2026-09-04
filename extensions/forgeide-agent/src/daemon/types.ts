/**
 * Shared types across the whole daemon. Kept in one file deliberately —
 * these are the contracts every module (spec engine, task runner, agent
 * loop, sandbox, checkpoint manager) agrees on, so they should be easy
 * to scan in one place rather than hunting per-module.
 */

export type RiskClass = "safe" | "elevated";

export type ToolType =
  | "read_file"
  | "edit_file"
  | "run_shell"
  | "git_op"
  | "mcp_call";

export interface ToolCall {
  type: ToolType;
  target: string; // path, command, or mcp tool name
  content?: string; // new file content / diff, for edit_file
  args?: Record<string, unknown>; // for mcp_call
  // riskClass is deliberately NOT settable by callers/model output.
  // It is computed by RiskPolicy.classify() and attached server-side.
}

export interface ClassifiedToolCall extends ToolCall {
  riskClass: RiskClass;
  reason: string; // why it got this classification, for audit logs
}

export interface ToolResult {
  ok: boolean;
  output?: string;
  error?: string;
  filesChanged?: string[];
}

export type TaskStatus =
  | "pending"
  | "in_progress"
  | "pending_approval"
  | "verifying"
  | "done"
  | "failed"
  | "aborted_budget";

export interface TaskStep {
  step: number;
  tool: ToolType;
  target: string;
  status: "pending" | "done" | "pending_approval" | "denied";
}

export interface TaskBudget {
  maxSteps: number;
  usedSteps: number;
  maxWallClockSec: number;
  startedAt?: number;
}

export interface TaskRecord {
  taskId: string;
  specSlug: string;
  description: string;
  status: TaskStatus;
  steps: TaskStep[];
  checkpointBefore?: string;
  budget: TaskBudget;
  mode: "supervised" | "autopilot";
}

export type SpecPhase = "requirements" | "design" | "tasks";

export interface SpecState {
  slug: string;
  phase: SpecPhase;
  approved: Record<SpecPhase, boolean>;
  content: Record<SpecPhase, string>;
}

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
}

export interface ModelRequest {
  messages: ModelMessage[];
  toolsAvailable: ToolType[];
  taskType?: "implementation" | "verification" | "spec" | "review";
  fileHint?: string; // e.g. a touched filename, used for glob-based routing
}

export interface ModelToolCallOutput {
  type: ToolType;
  target: string;
  content?: string;
  args?: Record<string, unknown>;
}

export interface ModelResponse {
  text?: string;
  toolCall?: ModelToolCallOutput;
  done: boolean; // model signals the task/turn is complete
}

export interface RoutingOverride {
  taskType?: ModelRequest["taskType"];
  fileGlobs?: string[];
  model: string; // "provider/model"
}

export interface RoutingPolicy {
  default: string;
  overrides: RoutingOverride[];
  fallback: {
    onRateLimit: string;
    onOutage: string;
  };
}

export interface VerificationFinding {
  property: string;
  evidence: string;
}

export interface VerificationResult {
  status: "passed" | "failed";
  propertiesTested: string[];
  failures: VerificationFinding[];
}

export interface HookAction {
  type: "agent.run";
  prompt: string;
  riskClass: RiskClass; // declared intent; still re-verified by RiskPolicy at execution time
}

export interface HookDefinition {
  id: string;
  trigger: "file.save" | "git.commit" | "pr.opened" | "branch.create" | "schedule" | "manual";
  match?: string[]; // glob patterns, for file.save
  actions: HookAction[];
}

export interface Connector {
  id: string;
  detects: string[]; // glob patterns this connector claims
  planPreview(diff: string): Promise<string>;
  applyGate: "elevated"; // hardcoded — connector deploys are always elevated risk
}
