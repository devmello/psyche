import type { AuditEntry } from "@psyche/protocol";

/**
 * Approval-friction metrics (S05 M2; roadmap input): how often the broker interrupts the owner,
 * how fast they answer, what gets declined or left to expire, and how much standing grants save.
 * Computed from the audit log only (the `tool_call.decided`, `approval.*`, `grant.*` and
 * `classifier.labeled` entries the broker writes), so it never touches arguments or bodies.
 */

export interface KindFriction {
  kind: string;
  decisions: number;
  asks: number;
  allows: number;
  denies: number;
  approved: number;
  declined: number;
  expired: number;
  invalidated: number;
  /** Owner answer latency (card shown → answer), milliseconds. */
  p50AnswerMs: number | null;
  p90AnswerMs: number | null;
}

export interface FrictionReport {
  from: string | null;
  to: string | null;
  decisions: number;
  asks: number;
  /** `asks / decisions`. */
  askRate: number;
  /** Asks per run that asked at least once. */
  asksPerAskingRun: number;
  /** Approvals answered before they expired, of those that ended. */
  answerRate: number;
  approveRate: number;
  p50AnswerMs: number | null;
  p90AnswerMs: number | null;
  /** Calls a standing grant allowed without a card (`grant:*` allow decisions). */
  allowedByGrant: number;
  grantsCreated: Record<string, number>;
  /** Deciding rules of `ask` results, most frequent first: where the friction comes from. */
  topAskRules: { rule: string; count: number }[];
  answerRejections: Record<string, number>;
  classifier: Record<string, number>;
  byKind: KindFriction[];
  byMode: Record<string, { decisions: number; asks: number }>;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? null;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** Group asks under their rule family (`mode:balanced/write`, `taint:new_target`, `policy:ask`…). */
export function ruleFamily(rule: string): string {
  if (rule.startsWith("grant:")) return "grant";
  const parts = rule.split(":");
  if (parts[0] === "policy" || parts[0] === "designated" || parts[0] === "site") {
    return parts.slice(0, 2).join(":");
  }
  if (parts[0] === "mode")
    return parts
      .slice(0, 2)
      .join(":")
      .replace(/:(new_source|sensitive|touched)$/, "");
  return parts.slice(0, 2).join(":");
}

export function frictionMetrics(entries: readonly AuditEntry[]): FrictionReport {
  const kinds = new Map<string, KindFriction & { latencies: number[] }>();
  const kindOf = new Map<string, string>();
  const byMode: FrictionReport["byMode"] = {};
  const askRules = new Map<string, number>();
  const runsAsking = new Map<string, number>();
  const grantsCreated: Record<string, number> = {};
  const answerRejections: Record<string, number> = {};
  const classifier: Record<string, number> = {};
  const latencies: number[] = [];
  let decisions = 0;
  let asks = 0;
  let allowedByGrant = 0;
  let approved = 0;
  let declined = 0;
  let expired = 0;

  const k = (kind: string) => {
    let v = kinds.get(kind);
    if (v === undefined) {
      v = {
        kind,
        decisions: 0,
        asks: 0,
        allows: 0,
        denies: 0,
        approved: 0,
        declined: 0,
        expired: 0,
        invalidated: 0,
        p50AnswerMs: null,
        p90AnswerMs: null,
        latencies: [],
      };
      kinds.set(kind, v);
    }
    return v;
  };

  for (const e of entries) {
    const d = e.data as Record<string, unknown>;
    const approvalId = str(e.subject?.approvalId);
    switch (e.kind) {
      case "tool_call.decided": {
        const kind = str(d.kind) ?? "unknown";
        const decision = str(d.decision);
        const rule = str(d.rule) ?? "";
        const mode = str(d.mode) ?? "unknown";
        decisions += 1;
        const kf = k(kind);
        kf.decisions += 1;
        byMode[mode] ??= { decisions: 0, asks: 0 };
        const m = byMode[mode];
        m.decisions += 1;
        if (decision === "ask") {
          asks += 1;
          kf.asks += 1;
          m.asks += 1;
          const family = ruleFamily(rule);
          askRules.set(family, (askRules.get(family) ?? 0) + 1);
          const run = str(e.subject?.runId) ?? str(e.actor.runId);
          if (run !== undefined) runsAsking.set(run, (runsAsking.get(run) ?? 0) + 1);
        } else if (decision === "allow") {
          kf.allows += 1;
          if (rule.startsWith("grant:")) allowedByGrant += 1;
        } else if (decision === "deny") kf.denies += 1;
        break;
      }
      case "approval.created":
        if (approvalId !== undefined) kindOf.set(approvalId, str(d.kind) ?? "unknown");
        break;
      case "approval.decided": {
        const kf = k(approvalId === undefined ? "unknown" : (kindOf.get(approvalId) ?? "unknown"));
        const latency = num(d.latencyMs);
        if (latency !== undefined) {
          latencies.push(latency);
          kf.latencies.push(latency);
        }
        if (d.decision === "allow") {
          approved += 1;
          kf.approved += 1;
        } else {
          declined += 1;
          kf.declined += 1;
        }
        break;
      }
      case "approval.expired":
        expired += 1;
        k(approvalId === undefined ? "unknown" : (kindOf.get(approvalId) ?? "unknown")).expired +=
          1;
        break;
      case "approval.invalidated":
        k(
          approvalId === undefined ? "unknown" : (kindOf.get(approvalId) ?? "unknown"),
        ).invalidated += 1;
        break;
      case "approval.answer_rejected": {
        const reason = str(d.reason) ?? "unknown";
        answerRejections[reason] = (answerRejections[reason] ?? 0) + 1;
        break;
      }
      case "grant.created": {
        const scope = str(d.scope) ?? "unknown";
        grantsCreated[scope] = (grantsCreated[scope] ?? 0) + 1;
        break;
      }
      case "classifier.labeled": {
        const label = str(d.label) ?? "unknown";
        classifier[label] = (classifier[label] ?? 0) + 1;
        break;
      }
    }
  }

  const ended = approved + declined + expired;
  const byKind = [...kinds.values()]
    .map(({ latencies: l, ...rest }) => ({
      ...rest,
      p50AnswerMs: percentile(l, 50),
      p90AnswerMs: percentile(l, 90),
    }))
    .sort((a, b) => b.asks - a.asks || a.kind.localeCompare(b.kind));
  return {
    from: entries[0]?.ts ?? null,
    to: entries.at(-1)?.ts ?? null,
    decisions,
    asks,
    askRate: decisions === 0 ? 0 : asks / decisions,
    asksPerAskingRun: runsAsking.size === 0 ? 0 : asks / runsAsking.size,
    answerRate: ended === 0 ? 0 : (approved + declined) / ended,
    approveRate: approved + declined === 0 ? 0 : approved / (approved + declined),
    p50AnswerMs: percentile(latencies, 50),
    p90AnswerMs: percentile(latencies, 90),
    allowedByGrant,
    grantsCreated,
    topAskRules: [...askRules.entries()]
      .map(([rule, count]) => ({ rule, count }))
      .sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule))
      .slice(0, 10),
    answerRejections,
    classifier,
    byKind,
    byMode,
  };
}
