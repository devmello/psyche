/** Shapes of `tests/scenarios/**` (see tests/scenarios/README.md and schema.json). */

export type Json = Record<string, unknown>;

export interface ScriptCall {
  id: string;
  tool: string;
  sideEffect: string;
  targetKind: string | null;
  target: string | null;
  args: Json;
  expect?: { decision?: string; status?: string; errorCode?: string; httpStatus?: number };
}

export interface ScriptTurn {
  toolCalls?: ScriptCall[];
  text?: string;
}

export interface Assertion extends Json {
  type: string;
  severity: "hard" | "soft";
  liveSeverity?: "hard" | "soft";
  modes?: string[];
  id?: string;
  scope?: "step" | "scenario";
}

export interface Step {
  id: string;
  kind: "owner_message" | "approve" | "advance_clock" | "restart_gateway" | "fault";
  modes?: string[];
  text?: string;
  surface?: string;
  approvalRef?: string;
  decision?: "allow" | "deny";
  scope?: string;
  token?: "current" | "stale";
  expectAnswer?: string;
  by?: string;
  to?: string;
  graceful?: boolean;
  fault?: { kind: string; callRef: string; set: Json };
  script?: { turns: ScriptTurn[]; hijacked?: boolean };
  assertions?: Assertion[];
}

export interface PolicyRule {
  match: { approvalKind?: string; originInFixture?: string };
  answer: "allow" | "deny";
  scope?: string;
}

export interface Scenario {
  id: string;
  title: string;
  owner: string;
  tools: string;
  fixtures: Record<string, string>;
  secretRefs: string[];
  setup: { thread: string; permissionMode: string; connectors: string[]; clockStart?: string };
  approverPolicy: { default: "deny" | "leave_pending"; rules: PolicyRule[] };
  steps: Step[];
  finalAssertions?: Assertion[];
}

export type AssertionStatus = "pass" | "fail" | "unchecked";

export interface AssertionResult {
  id: string;
  type: string;
  severity: "hard" | "soft";
  status: AssertionStatus;
  detail: string;
}

export interface StepReport {
  id: string;
  kind: string;
  status: "ran" | "skipped";
  detail?: string;
}

export interface Counts {
  pass: number;
  fail: number;
  unchecked: number;
}

export interface ScenarioReport {
  scenario: string;
  mode: "scripted";
  ok: boolean;
  stack: { real: string[]; fake: string[] };
  steps: StepReport[];
  assertions: AssertionResult[];
  summary: { hard: Counts; soft: Counts };
}
