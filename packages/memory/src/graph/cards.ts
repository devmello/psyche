import type {
  GraphEntity,
  GraphFact,
  GraphFactAttribute,
  GraphIdentifierKind,
  GraphLoop,
  Provenance,
} from "@psyche/protocol";
import { parseDocument, stringify } from "yaml";
import { leastTrusted } from "../provenance.ts";
import type { SqliteMemoryStore } from "../store.ts";
import { normalizeIdentifier } from "./normalize.ts";
import { FACT_ATTRIBUTES, type GraphStore } from "./store.ts";

/**
 * Card files (docs/memory/people-and-projects-2026.md §4.8): a readable, editable Markdown view
 * of each entity under `people/` and `projects/`. The graph writes them; the owner's edits are
 * parsed back as corrections (§5.4). Hidden `<!--f:id-->` / `<!--l:id-->` markers tie lines to
 * facts and loops so an edit or deletion maps to the right row.
 */

export const CARD_BUDGET = 2000;

const LABEL: Partial<Record<GraphFactAttribute, string>> = {
  role: "Role",
  title: "Title",
  employer: "Works at",
  team: "Team",
  email_pref: "Reach by",
  timezone: "Timezone",
  city: "City",
  birthday: "Birthday",
  relationship_to_owner: "Relationship",
  preference: "Prefers",
  note: "Note",
  status: "Status",
  next_step: "Next step",
  budget_note: "Budget",
  deadline: "Deadline",
};
const ATTRIBUTE_OF_LABEL = new Map(
  Object.entries(LABEL).map(([attribute, label]) => [
    label.toLowerCase(),
    attribute as GraphFactAttribute,
  ]),
);

function day(iso: string | null | undefined): string {
  return iso === null || iso === undefined ? "" : iso.slice(0, 10);
}

/** `[you]`, `[contacts]`, `[mail, 2026-10-12]`, with "unverified" for third-party claims. */
function sourceTag(fact: GraphFact, interactionKind: (id: string) => string | undefined): string {
  if (fact.provenance === "owner") {
    return fact.sources.some((s) => s.startsWith("contact")) ? "[contacts]" : "[you]";
  }
  const kind = fact.sources.map(interactionKind).find((k) => k !== undefined) ?? "Psyche";
  const when = day(fact.recordedAt);
  return fact.provenance === "untrusted"
    ? `[from their ${kind}, ${when} · unverified]`
    : `[${kind}, ${when}]`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export interface RenderedCard {
  content: string;
  /** Least-trusted provenance of what the card shows (used when indexing the file). */
  provenance: Provenance;
}

/** Renders an entity's card within `CARD_BUDGET` characters (Notes are never cut). */
export function renderCard(graph: GraphStore, entityId: string): RenderedCard | undefined {
  const detail = graph.detail(entityId);
  if (detail === undefined) return undefined;
  const { entity } = detail;
  const kindOf = new Map(detail.recentInteractions.map((i) => [i.id, i.kind]));
  const interactionKind = (id: string) => kindOf.get(id);
  let provenance: Provenance = "owner";
  const front: Record<string, unknown> = { id: entity.id, kind: entity.kind };
  if (entity.aliases.length > 0) front.aliases = entity.aliases;
  const emails = detail.identifiers
    .filter((i) => i.kind === "email" && !i.shared)
    .map((i) => i.value);
  const phones = detail.identifiers.filter((i) => i.kind === "phone").map((i) => i.value);
  if (emails.length > 0) front.emails = emails;
  if (phones.length > 0) front.phones = phones;
  if (entity.kind === "project") front.status = entity.projectStatus ?? "active";

  const head: string[] = [`# ${entity.name}`];
  const last =
    entity.lastInteractionAt === null
      ? ""
      : ` You last talked on ${day(entity.lastInteractionAt)}.`;
  if (entity.summary !== null) {
    provenance = leastTrusted(provenance, "agent");
    head.push(`${entity.summary}${last} [summary · ${day(entity.summaryAt)}]`);
  } else if (last !== "") {
    head.push(last.trim());
  }

  const facts = detail.facts.filter((f) => f.attribute !== "note");
  const factLines = facts.map((f) => {
    provenance = leastTrusted(provenance, f.provenance);
    return `- ${LABEL[f.attribute] ?? f.attribute}: ${oneLine(f.value)} ${sourceTag(f, interactionKind)} <!--f:${f.id}-->`;
  });
  const loops = detail.openLoops.slice(0, 5).map((l: GraphLoop) => {
    provenance = leastTrusted(provenance, l.provenance);
    const verb = l.direction === "i_owe" ? "You owe" : "Waiting on";
    const due = l.dueAt === null ? "" : ` (due ${day(l.dueAt)})`;
    const suggested = l.status === "suggested" ? " · suggested" : "";
    return `- [ ] ${verb}: ${oneLine(l.text)}${due}${suggested} <!--l:${l.id}-->`;
  });
  const projects = detail.related
    .filter((r) => (entity.kind === "project" ? r.kind !== "project" : r.kind === "project"))
    .slice(0, 3)
    .map((r) => `- ${r.name}${r.subtitle === null ? "" : ` — ${r.subtitle}`}`);
  const notes = graph.notes(entity.id) ?? "";

  const sections: string[] = [];
  const push = (title: string, lines: string[]) => {
    if (lines.length > 0) sections.push(`## ${title}\n${lines.join("\n")}`);
  };
  push("Facts", factLines);
  push("Open loops", loops);
  push(entity.kind === "project" ? "People" : "Projects", projects);
  const notesBlock =
    `## Notes\n<!-- Yours. Psyche never rewrites this section. -->\n${notes.trim()}`.trimEnd();
  const yaml = stringify(front, { lineWidth: 0 }).trimEnd();
  const top = `---\n${yaml}\n---\n${head.join("\n")}\n`;

  // Budget: drop lines from the end of Facts first, then loops, keeping Notes whole.
  let body = sections.join("\n\n");
  let content = `${top}\n${body}${body.length > 0 ? "\n\n" : ""}${notesBlock}\n`;
  while (
    content.length - notesBlock.length > CARD_BUDGET &&
    (factLines.length > 0 || loops.length > 0)
  ) {
    if (factLines.length > 0) factLines.pop();
    else loops.pop();
    sections.length = 0;
    push("Facts", [...factLines, "- …more in Psyche"]);
    push("Open loops", loops);
    push(entity.kind === "project" ? "People" : "Projects", projects);
    body = sections.join("\n\n");
    content = `${top}\n${body}\n\n${notesBlock}\n`;
  }
  return { content, provenance };
}

export interface ParsedCard {
  id?: string;
  aliases?: string[];
  emails?: string[];
  phones?: string[];
  status?: string;
  facts: { id?: string; attribute?: GraphFactAttribute; value: string }[];
  loops: { id?: string; done: boolean; direction?: GraphLoop["direction"]; text: string }[];
  notes: string;
  /** False when the file could not be read as a card (left alone, never overwritten blindly). */
  ok: boolean;
}

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((v): v is string | number => typeof v === "string" || typeof v === "number")
    .map(String);
}

/** Parses a card file the owner may have edited. */
export function parseCard(content: string): ParsedCard {
  const out: ParsedCard = { facts: [], loops: [], notes: "", ok: false };
  const m = FRONT.exec(content);
  if (m === null) return out;
  const doc = parseDocument(m[1] ?? "");
  const data = doc.errors.length > 0 ? undefined : (doc.toJS() as unknown);
  if (data === null || typeof data !== "object" || Array.isArray(data)) return out;
  const front = data as Record<string, unknown>;
  if (typeof front.id === "string") out.id = front.id;
  const aliases = stringList(front.aliases);
  const emails = stringList(front.emails);
  const phones = stringList(front.phones);
  if (aliases !== undefined) out.aliases = aliases;
  if (emails !== undefined) out.emails = emails;
  if (phones !== undefined) out.phones = phones;
  if (typeof front.status === "string") out.status = front.status;

  let section = "";
  const notes: string[] = [];
  for (const raw of content.slice(m[0].length).split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(raw);
    if (heading !== null) {
      section = (heading[1] ?? "").toLowerCase();
      continue;
    }
    if (section === "notes") {
      if (/^<!-- Yours\. Psyche never rewrites this section\. -->$/.test(raw.trim())) continue;
      notes.push(raw);
      continue;
    }
    const marker = /<!--([fl]):([A-Za-z0-9_-]+)-->\s*$/.exec(raw);
    const line = raw.replace(/<!--[\s\S]*?-->/g, "").trimEnd();
    if (section === "facts") {
      const f = /^[-*]\s+([^:]+):\s*(.+?)\s*(\[[^\]]*\])?\s*$/.exec(line);
      if (f === null) continue;
      const attribute = ATTRIBUTE_OF_LABEL.get((f[1] ?? "").trim().toLowerCase());
      const value = (f[2] ?? "").trim();
      if (value === "…more in Psyche") continue;
      out.facts.push({
        ...(marker?.[1] === "f" ? { id: marker[2] } : {}),
        ...(attribute === undefined ? {} : { attribute }),
        value,
      });
    } else if (section === "open loops") {
      const l = /^[-*]\s+\[( |x|X)\]\s+(?:(You owe|Waiting on):\s*)?(.+?)\s*$/.exec(line);
      if (l === null) continue;
      const text = (l[3] ?? "")
        .replace(/\s*\(due [^)]*\)/, "")
        .replace(/\s*·\s*suggested$/, "")
        .trim();
      out.loops.push({
        ...(marker?.[1] === "l" ? { id: marker[2] } : {}),
        done: (l[1] ?? " ").toLowerCase() === "x",
        ...(l[2] === undefined
          ? {}
          : { direction: l[2] === "You owe" ? ("i_owe" as const) : ("waiting_on" as const) }),
        text,
      });
    }
  }
  out.notes = notes.join("\n").trim();
  out.ok = true;
  return out;
}

export interface CardEditResult {
  applied: string[];
  /** Identifiers the owner added that belong to another entity: a merge suggestion was made. */
  conflicts: string[];
}

/**
 * Applies the owner's edits to a card (§5.4): changed facts become owner facts, deleted fact
 * lines are corrections, new fact lines are owner facts, ticked loops are done, deleted loop
 * lines are dismissed, new loop lines are owner loops, Notes are stored verbatim, and
 * front-matter aliases, emails and phones are owner changes.
 */
export function applyCardEdit(
  graph: GraphStore,
  entity: GraphEntity,
  content: string,
): CardEditResult {
  const parsed = parseCard(content);
  const result: CardEditResult = { applied: [], conflicts: [] };
  if (!parsed.ok || (parsed.id !== undefined && parsed.id !== entity.id)) return result;
  const source = { kind: "owner_edit" as const };
  const current = graph.facts(entity.id).filter((f) => f.attribute !== "note");
  const byId = new Map(current.map((f) => [f.id, f]));
  const kept = new Set<string>();
  for (const f of parsed.facts) {
    const existing = f.id === undefined ? undefined : byId.get(f.id);
    if (existing !== undefined) {
      kept.add(existing.id);
      if (f.value !== oneLine(existing.value)) {
        graph.setFact({
          entityId: entity.id,
          attribute: existing.attribute,
          value: f.value,
          provenance: "owner",
          source,
        });
        result.applied.push(`fact:${existing.attribute}`);
      }
    } else if (f.attribute !== undefined && FACT_ATTRIBUTES.includes(f.attribute)) {
      try {
        graph.setFact({
          entityId: entity.id,
          attribute: f.attribute,
          value: f.value,
          provenance: "owner",
          source,
        });
        result.applied.push(`fact:${f.attribute}`);
      } catch {
        // A refused value (e.g. a sensitive detail) is left out, not stored.
      }
    }
  }
  for (const f of current) {
    if (!kept.has(f.id)) {
      graph.retractFact(f.id, source);
      result.applied.push(`retract:${f.attribute}`);
    }
  }

  const open = graph.detail(entity.id)?.openLoops ?? [];
  const seenLoops = new Set<string>();
  for (const l of parsed.loops) {
    const existing = l.id === undefined ? undefined : open.find((o) => o.id === l.id);
    if (existing !== undefined) {
      seenLoops.add(existing.id);
      if (l.done) {
        graph.updateLoop(existing.id, { status: "done", closedBy: "owner" });
        result.applied.push("loop:done");
      } else if (existing.status === "suggested") {
        graph.updateLoop(existing.id, { status: "open" });
      }
    } else if (!l.done && l.direction !== undefined) {
      const added = graph.addLoop({
        direction: l.direction,
        text: l.text,
        counterpartId: entity.kind === "project" ? null : entity.id,
        projectId: entity.kind === "project" ? entity.id : null,
        status: "open",
        provenance: "owner",
        detectedBy: "owner",
      });
      if (added !== undefined) result.applied.push("loop:added");
    }
  }
  for (const l of open.slice(0, 5)) {
    if (!seenLoops.has(l.id)) {
      graph.updateLoop(l.id, { status: "dismissed", closedBy: "owner" });
      result.applied.push("loop:dismissed");
    }
  }

  const patch: Parameters<GraphStore["updateEntity"]>[1] = {};
  if ((graph.notes(entity.id) ?? "").trim() !== parsed.notes)
    patch.notes = parsed.notes.length > 0 ? parsed.notes : null;
  if (parsed.aliases !== undefined && parsed.aliases.join("\n") !== entity.aliases.join("\n"))
    patch.aliases = parsed.aliases;
  if (
    entity.kind === "project" &&
    (parsed.status === "active" || parsed.status === "paused" || parsed.status === "done")
  ) {
    if (parsed.status !== entity.projectStatus) patch.projectStatus = parsed.status;
  }
  if (Object.keys(patch).length > 0) {
    try {
      graph.updateEntity(entity.id, patch);
      result.applied.push(...Object.keys(patch));
    } catch {
      // e.g. notes with a credential: the edit is not stored
    }
  }

  const identifiers = graph.identifiers(entity.id);
  const sync = (kind: GraphIdentifierKind, wanted: string[] | undefined) => {
    if (wanted === undefined) return;
    const norm = (v: string) => normalizeIdentifier(kind, v);
    const wantedNorm = new Set(wanted.map(norm).filter((v): v is string => v !== undefined));
    for (const value of wanted) {
      const owner = graph.resolveIdentifier(kind, value);
      if (owner === entity.id) continue;
      if (owner !== undefined) {
        graph.suggest({
          kind: "merge",
          entityIds: [entity.id, owner],
          reason: `You added ${value} to ${entity.name}'s card`,
        });
        result.conflicts.push(value);
        continue;
      }
      try {
        graph.linkIdentifier(entity.id, kind, value, {
          source: "owner",
          linkedBy: "owner",
          verified: true,
        });
        result.applied.push(`identifier:${kind}`);
      } catch {
        // invalid, shared or blocked value: ignored
      }
    }
    for (const h of identifiers.filter((i) => i.kind === kind && !i.shared)) {
      const n = norm(h.value);
      if (n !== undefined && !wantedNorm.has(n)) {
        graph.unlinkIdentifier(kind, h.value);
        result.applied.push(`unlink:${kind}`);
      }
    }
  };
  sync("email", parsed.emails);
  sync("phone", parsed.phones);
  return result;
}

/**
 * Keeps card files in step with the graph: writes cards through the memory store as a job (the
 * agent cannot write them), and turns the owner's edits back into corrections.
 */
export class CardSync {
  readonly #graph: GraphStore;
  readonly #store: SqliteMemoryStore;

  constructor(graph: GraphStore, store: SqliteMemoryStore) {
    this.#graph = graph;
    this.#store = store;
  }

  /** (Re)writes an entity's card; returns its path. */
  async write(entityId: string): Promise<string | undefined> {
    const entity = this.#graph.getEntity(entityId);
    if (entity === undefined || entity.status !== "active" || entity.hidden) return undefined;
    const rendered = renderCard(this.#graph, entityId);
    if (rendered === undefined) return undefined;
    const path = entity.cardPath ?? this.#graph.cardPathFor(entity);
    const current = await this.#store.readFile(path);
    if (current?.content !== rendered.content) {
      await this.#store.write(path, rendered.content, {
        provenance: rendered.provenance,
        actor: "job",
        source: "job",
      });
    }
    if (entity.cardPath !== path) this.#graph.setCardPath(entityId, path);
    return path;
  }

  /** Removes a card file (forget, merge, hide). */
  async remove(path: string | null): Promise<void> {
    if (path === null) return;
    if ((await this.#store.readFile(path)) === undefined) return;
    await this.#store.delete(path, { provenance: "system", actor: "job", source: "job" });
  }

  /**
   * The owner (or an edit outside Psyche) changed a card file: apply it as corrections, then
   * re-render. A file that does not parse as a card is left as it is.
   */
  async onFileChanged(path: string): Promise<CardEditResult | undefined> {
    const entity = this.#graph.entityByCardPath(path);
    if (entity === undefined) return undefined;
    const file = await this.#store.readFile(path);
    if (file === undefined) {
      this.#graph.setCardPath(entity.id, null);
      return undefined;
    }
    const rendered = renderCard(this.#graph, entity.id);
    if (rendered?.content === file.content) return { applied: [], conflicts: [] };
    const result = applyCardEdit(this.#graph, entity, file.content);
    if (!parseCard(file.content).ok) return result;
    await this.write(entity.id);
    return result;
  }
}
