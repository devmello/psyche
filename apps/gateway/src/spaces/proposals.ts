import type { PsycheDb } from "@psyche/db";
import { PsycheError, SPACE_LIMITS, type SpaceProposal, type TaintSource } from "@psyche/protocol";
import { SpaceStore } from "./store.ts";

/**
 * Agent proposals (docs/design/spaces-2026.md §4.3, SP4, SR9). A proposal is a name, a reason, a
 * project and chats, and nothing else: no folders, instructions, scope or mode. It becomes a
 * Space only when the owner taps Create (`spaces.proposals.accept`). A proposal made in a turn
 * that read untrusted content keeps that turn's taint, so the card can show where it came from.
 */

/** Open proposals at most: a flood of proposals is not a stack of cards on Home. */
export const MAX_OPEN_PROPOSALS = 5;
export const MAX_PROPOSAL_THREADS = 10;
export const MAX_REASON_CHARS = 300;

export interface ProposeInput {
  readonly name: string;
  readonly reason: string;
  readonly entityId?: string | undefined;
  readonly threadIds?: readonly string[] | undefined;
  /** The thread the tool ran in. A tainted turn can only name this one. */
  readonly currentThreadId: string;
  /** The turn's taint sources (empty when the turn is clean). */
  readonly taint: readonly TaintSource[];
}

export interface ProposeDeps {
  readonly db: PsycheDb;
  /** Whether a memory project (not private) with this id exists. */
  readonly projectExists?: ((entityId: string) => boolean) | undefined;
}

/** One line, no control characters, cut to `max`. */
function oneLine(text: string, max: number): string {
  const clean = text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ");
  return clean.replace(/\s+/g, " ").trim().slice(0, max).trim();
}

const key = (name: string): string => name.toLowerCase();

/**
 * Records a proposal. Returns the existing open one when the same name or project is already
 * proposed, and refuses what the owner already decided: a Space that exists, a proposal they
 * dismissed or accepted. Throws `invalid_params` or `conflict` with a message the model can act on.
 */
export function createProposal(
  deps: ProposeDeps,
  input: ProposeInput,
): { proposal: SpaceProposal; created: boolean } {
  const { db } = deps;
  const name = oneLine(input.name, SPACE_LIMITS.name);
  if (name === "") throw new PsycheError("invalid_params", "A Space needs a name.");
  const reason = oneLine(input.reason, MAX_REASON_CHARS);
  if (reason === "") throw new PsycheError("invalid_params", "Say why the Space would help.");

  const store = new SpaceStore(db);
  const tainted = input.taint.length > 0;

  if (input.entityId !== undefined) {
    if (deps.projectExists !== undefined && !deps.projectExists(input.entityId)) {
      throw new PsycheError("not_found", "That project is not in Memory.");
    }
    const linked = db.sqlite
      .prepare("SELECT id FROM spaces WHERE entity_id = ?")
      .get(input.entityId) as { id: string } | undefined;
    if (linked !== undefined) {
      throw new PsycheError("conflict", "That project already has a Space.");
    }
  }

  // Chats: ones that exist and can be in a Space. A tainted turn names only its own chat.
  const wanted = tainted
    ? [input.currentThreadId]
    : [...new Set(input.threadIds ?? [input.currentThreadId])];
  if (wanted.length > MAX_PROPOSAL_THREADS) {
    throw new PsycheError("invalid_params", `Name at most ${MAX_PROPOSAL_THREADS} chats.`);
  }
  const threadIds: string[] = [];
  for (const id of wanted) {
    const row = db.sqlite.prepare("SELECT kind FROM threads WHERE id = ?").get(id) as
      | { kind: string }
      | undefined;
    if (row === undefined) {
      if (input.threadIds?.includes(id) === true) {
        throw new PsycheError("not_found", `Chat ${id} does not exist.`);
      }
      continue;
    }
    if (row.kind === "main" || row.kind === "incognito") continue;
    threadIds.push(id);
  }

  const all = store.proposals(false);
  const same = (p: SpaceProposal): boolean =>
    key(p.name) === key(name) || (input.entityId !== undefined && p.entityId === input.entityId);
  const open = all.find((p) => p.status === "open" && same(p));
  if (open !== undefined) return { proposal: open, created: false };
  if (all.some((p) => p.status !== "open" && same(p))) {
    throw new PsycheError(
      "conflict",
      "The owner already decided on a Space like this. Do not propose it again.",
    );
  }
  const existing = db.sqlite
    .prepare("SELECT id FROM spaces WHERE lower(name) = ? AND archived_at IS NULL")
    .get(key(name)) as { id: string } | undefined;
  if (existing !== undefined) {
    throw new PsycheError("conflict", "A Space with that name already exists.");
  }
  if (all.filter((p) => p.status === "open").length >= MAX_OPEN_PROPOSALS) {
    throw new PsycheError(
      "conflict",
      "There are already proposals waiting on the owner. Wait for them to decide.",
    );
  }

  const id = db.newId();
  db.sqlite
    .prepare(
      `INSERT INTO space_proposals (id, name, reason, entity_id, thread_ids, taint, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
    )
    .run(
      id,
      name,
      reason,
      input.entityId ?? null,
      JSON.stringify(threadIds),
      JSON.stringify(input.taint),
      db.now(),
    );
  return { proposal: store.proposal(id), created: true };
}
