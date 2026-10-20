import { hashCanonical } from "@psyche/audit";
import { appendMessage, getSetting, getThread, type PsycheDb } from "@psyche/db";
import type { SqliteMemoryStore } from "@psyche/memory";
import type {
  AuditLog,
  Block,
  LearnedFact,
  Message,
  ModelProvider,
  ModelRef,
  PermissionBroker,
  Surface,
} from "@psyche/protocol";
import type { SecretRedactor } from "@psyche/vault";

/**
 * Learning about the owner (#509). After each owner-authored turn (agent-core `onOwnerTurn`:
 * attended, the owner's own words, never tool output or a non-owner's text), the utility model
 * reads the owner's message (vault values masked first) and proposes durable facts: name,
 * preferences, routines, people, projects. `packages/memory` (the one writer of USER.md) filters
 * them (secrets, cards, government ids, financial accounts, health, instruction-like text),
 * dedupes them against USER.md and live claims, and writes them to USER.md's dated Learned
 * section with the thread they came from. The chat gets a "Learned: …" note with Undo
 * (`memory.forgetLearned`); every write and undo is audited (ids and counts, never the text).
 *
 * Setting `memory.userProfile` `{enabled (default true), review: "auto" (default) | "ask"}`:
 * `ask` turns each turn's facts into a `memory_protected_write` card first. Incognito threads
 * never contribute.
 */

export const USER_PROFILE_SETTING = "memory.userProfile";
/** Facts one turn may propose. */
const MAX_FACTS = 5;
const KINDS = new Set<LearnedFact["kind"]>([
  "name",
  "preference",
  "routine",
  "person",
  "project",
  "other",
]);

export const LEARN_SYSTEM = `You read one message the owner wrote to their personal assistant and list durable facts about the owner it states: their name, preferences, routines, the people in their life, their projects.
Reply with one JSON object and nothing else: {"facts": [{"text": "...", "kind": "name|preference|routine|person|project|other"}]}
- Only what the owner says about themselves, in the third person ("Prefers tea over coffee", "Has a sister named Maya"). Short, one fact per item.
- Nothing temporary (today's plans, a one-off request), nothing you infer, nothing about anyone's health, money, accounts, passwords, identity numbers or addresses.
- Most messages state nothing durable: then reply {"facts": []}.`;

export interface UserProfileConfig {
  enabled: boolean;
  review: "auto" | "ask";
}

export function userProfileConfig(db: PsycheDb): UserProfileConfig {
  const v = getSetting(db, USER_PROFILE_SETTING)?.value as Partial<UserProfileConfig> | undefined;
  return {
    enabled: v?.enabled !== false,
    review: v?.review === "ask" ? "ask" : "auto",
  };
}

/** The model's JSON as proposals; anything else is no proposal. */
export function parseProposals(text: string): { text: string; kind: LearnedFact["kind"] }[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  const facts = (raw as { facts?: unknown })?.facts;
  if (!Array.isArray(facts)) return [];
  return facts
    .filter((f): f is { text: string; kind?: string } => typeof f?.text === "string")
    .slice(0, MAX_FACTS)
    .map((f) => ({
      text: f.text.trim(),
      kind: KINDS.has(f.kind as LearnedFact["kind"]) ? (f.kind as LearnedFact["kind"]) : "other",
    }));
}

export interface UserProfileDeps {
  db: PsycheDb;
  memory: SqliteMemoryStore;
  provider: ModelProvider;
  model: ModelRef;
  /** False when no utility model is configured: the evaluator never runs. */
  active: boolean;
  redactor: SecretRedactor;
  audit: AuditLog;
  broker: PermissionBroker;
  surfaces: Surface[];
  publish(event: "chat.message", payload: { message: Message }, threadId: string): void;
}

export function createUserProfile(deps: UserProfileDeps) {
  const { db } = deps;

  const extract = async (text: string) => {
    let out = "";
    for await (const e of deps.provider.stream(
      {
        model: deps.model,
        system: LEARN_SYSTEM,
        messages: [{ role: "user", parts: [{ type: "text", text }] }],
      },
      {},
    )) {
      if (e.type === "text_delta") out += e.text;
    }
    return parseProposals(out);
  };

  const note = (threadId: string, runId: string, facts: LearnedFact[]) => {
    const block: Block = { type: "learned", items: facts };
    for (const writer of [null, runId]) {
      try {
        const message = appendMessage(
          db,
          { threadId, role: "system", blocks: [block], provenance: "agent", runId: null },
          { expectedWriterRunId: writer },
        );
        deps.publish("chat.message", { message }, threadId);
        return;
      } catch {
        // The turn's writer may still hold the transcript for a moment: try as that run.
      }
    }
  };

  const write = async (
    threadId: string,
    runId: string,
    proposals: { text: string; kind: LearnedFact["kind"] }[],
  ) => {
    const { written, refused } = await deps.memory.learnUserFacts(proposals, { threadId });
    await deps.audit
      .append({
        kind: "memory.user_profile.learned",
        actor: { type: "agent", runId },
        subject: { threadId, path: "USER.md" },
        data: {
          factIds: written.map((f) => f.factId),
          refused: refused.map((r) => r.reason),
        },
      })
      .catch(() => undefined);
    if (written.length > 0) note(threadId, runId, written);
    return written;
  };

  const onOwnerTurn = async (turn: {
    threadId: string;
    runId: string;
    taskId?: string;
    ownerText: string;
  }) => {
    if (!deps.active) return;
    const config = userProfileConfig(db);
    if (!config.enabled) return;
    const thread = getThread(db, turn.threadId);
    if (thread === undefined || thread.kind === "incognito") return;
    // Vault values never reach the utility model (the existing redactor).
    const text = deps.redactor.redact(turn.ownerText).trim();
    if (text.length < 8) return;
    const proposals = await extract(text);
    if (proposals.length === 0) return;
    if (config.review === "auto") {
      await write(turn.threadId, turn.runId, proposals);
      return;
    }
    const binding = hashCanonical({ path: "USER.md", threadId: turn.threadId, proposals });
    const issued = await deps.broker.requestApproval({
      kind: "memory_protected_write",
      summary: `Remember about you: ${proposals.map((p) => p.text).join("; ")}`.slice(0, 300),
      details: { path: "USER.md", operation: "learn", facts: proposals.map((p) => p.text) },
      bindingHash: binding,
      grantKey: binding,
      requestedBy: { runId: turn.runId, taskId: turn.taskId ?? null, threadId: turn.threadId },
      sideEffect: "write",
      surfaces: deps.surfaces,
      scopesOffered: ["once"],
      taint: false,
    });
    const done = await deps.broker.awaitDecision(issued.approval.id);
    if (done.status === "approved") await write(turn.threadId, turn.runId, proposals);
  };

  const handlers = {
    "memory.forgetLearned": async (p: { factId: string }) => {
      const removed = await deps.memory.forgetLearned(p.factId);
      await deps.audit
        .append({
          kind: "memory.user_profile.forgotten",
          actor: { type: "user" },
          subject: { path: "USER.md" },
          data: { factId: p.factId, removed },
        })
        .catch(() => undefined);
      return { removed };
    },
  };

  return { onOwnerTurn, handlers };
}
