import type { PsycheDb } from "@psyche/db";
import { PsycheError, SPACE_LIMITS, type SpaceProposal, type TaintSource } from "@psyche/protocol";
import { SpaceStore } from "./store.ts";

/**
 * Agent proposals (docs/design/spaces-2026.md §4.3, SP4, SR9). A proposal is a name, a reason, a
 * project and chats, and nothing else: no folders, instructions, scope or mode. It becomes a
 * Space only when the owner taps Create (`spaces.proposals.accept`). A proposal made in a turn
 * that read untrusted content keeps that turn's taint, so the card can show where it came from.
 */

/**
 * Open proposals at most: a flood of proposals is not a stack of cards on Home. Proposals from a
 * tainted turn have their own, smaller cap, so they can never fill the clean ones' room.
 */
export const MAX_OPEN_PROPOSALS = 5;
export const MAX_OPEN_TAINTED_PROPOSALS = 2;
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

/**
 * One line, cut to `max`: no control characters or line breaks (they become a space), and no
 * format characters (bidi overrides and isolates U+202A-202E and U+2066-2069, the marks U+200E/F,
 * U+200B, U+2060, U+FEFF), which are dropped so they cannot reorder what the owner reads. U+200C and
 * U+200D (ZWNJ, ZWJ) stay: emoji sequences and Persian or Indic words need them.
 */
export function oneLine(text: string, max: number): string {
  const clean = text
    .replace(/(?:(?![\u200c\u200d])[\p{Cf}\u200e\u200f\u202a-\u202e\u2066-\u2069])+/gu, "")
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ");
  return clean.replace(/\s+/g, " ").trim().slice(0, max).trim();
}

/**
 * How two Space names compare: Unicode case-insensitively (NFKC, then a case fold through upper
 * and lower case), the same in every check. SQLite's `lower()` folds ASCII only.
 */
export const nameKey = (name: string): string =>
  name.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC").trim();

/**
 * Chats a proposal may bring in, now: they exist, have no Space yet (a chat in another Space,
 * private or not, is never named or moved), and are not main, incognito or a channel chat.
 */
export function proposalChats(
  db: PsycheDb,
  ids: readonly string[],
): { id: string; title: string }[] {
  const out: { id: string; title: string }[] = [];
  for (const id of ids) {
    const row = db.sqlite
      .prepare("SELECT kind, title, space_id, imported FROM threads WHERE id = ?")
      .get(id) as
      | { kind: string; title: string | null; space_id: string | null; imported: string | null }
      | undefined;
    // An imported conversation is somebody's export file: read-only, never put in a Space.
    if (row === undefined || row.space_id !== null || row.imported !== null) continue;
    if (UNMOVABLE_KINDS.has(row.kind)) continue;
    out.push({ id, title: (row.title ?? "").slice(0, 120) });
  }
  return out;
}

/** Thread kinds a proposal never moves. A channel chat waits for SR11 (owner decision, S7 r1). */
const UNMOVABLE_KINDS = new Set(["main", "incognito", "channel"]);

/**
 * Records a proposal. Returns the existing open one when the same name or project is already
 * proposed, and refuses what the owner already decided: a Space that exists, a clean proposal they
 * dismissed or accepted. A clean proposal replaces an open tainted one with the same name or
 * project. Throws `invalid_params`, `forbidden` or `conflict` with a message the model can act on.
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
  for (const id of wanted) {
    const row = db.sqlite.prepare("SELECT kind FROM threads WHERE id = ?").get(id) as
      | { kind: string }
      | undefined;
    if (row === undefined && input.threadIds?.includes(id) === true) {
      throw new PsycheError("not_found", `Chat ${id} does not exist.`);
    }
    // Owner decision (S7 r1): a channel chat is not pulled into a Space by a proposal until
    // Space context is kept from channel peers at run time (SR11).
    if (row?.kind === "channel") {
      throw new PsycheError(
        "forbidden",
        "Chats from messaging channels can't be put in a Space yet. Do not propose it.",
      );
    }
  }
  // A chat already in a Space (private or not) is left out, and so is the main chat.
  const threadIds = proposalChats(db, wanted).map((c) => c.id);

  const all = store.proposals(false);
  const isTainted = (p: SpaceProposal): boolean => p.taint.length > 0;
  const same = (p: SpaceProposal): boolean =>
    nameKey(p.name) === nameKey(name) ||
    (input.entityId !== undefined && p.entityId === input.entityId);
  // A clean proposal is never answered with a tainted one: it replaces it on Home.
  const open = all.find((p) => p.status === "open" && same(p) && (tainted || !isTainted(p)));
  if (open !== undefined) return { proposal: open, created: false };
  // The owner's answer to a tainted proposal stops later tainted ones with the same name or
  // project (so mail cannot put the card back), but never a clean one.
  if (all.some((p) => p.status !== "open" && same(p) && (tainted || !isTainted(p)))) {
    throw new PsycheError(
      "conflict",
      "The owner already decided on a Space like this. Do not propose it again.",
    );
  }
  const names = db.sqlite.prepare("SELECT name FROM spaces WHERE archived_at IS NULL").all() as {
    name: string;
  }[];
  if (names.some((r) => nameKey(r.name) === nameKey(name))) {
    throw new PsycheError("conflict", "A Space with that name already exists.");
  }
  const superseded = tainted ? [] : all.filter((p) => p.status === "open" && same(p));
  const stillOpen = all.filter((p) => p.status === "open" && !superseded.includes(p));
  const cap = tainted ? MAX_OPEN_TAINTED_PROPOSALS : MAX_OPEN_PROPOSALS;
  if (stillOpen.filter((p) => isTainted(p) === tainted).length >= cap) {
    throw new PsycheError(
      "conflict",
      "There are already proposals waiting on the owner. Wait for them to decide.",
    );
  }
  const drop = db.sqlite.prepare("DELETE FROM space_proposals WHERE id = ? AND status = 'open'");
  for (const p of superseded) drop.run(p.id);

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
