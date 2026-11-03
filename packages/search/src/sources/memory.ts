import { graphDocId } from "../graph.ts";
import type { SourceAdapter, SourceItem, SourcePull } from "./types.ts";

/**
 * Memory as a Search source: what Psyche remembers about the owner's people, projects, work and
 * events, indexed locally so Search finds it with everything else. Switched on in Settings →
 * Search sources like the others, with the same status, size and Rebuild.
 *
 * The Gateway hands in only what may be indexed (`MemorySourceDeps.read`): entities that are
 * active, not hidden and not kept private, and, of their facts, only the current ones the owner
 * has reviewed (accepted, auto-accepted or edited), that are not sensitive and not what a third
 * party wrote. Nothing waiting for review and no sensitive fact is ever passed to this adapter,
 * so it cannot index one. A read is a whole snapshot: an item that turns sensitive, private or
 * hidden, or whose fact is retracted, leaves the index on the next pass.
 *
 * Memory does not learn from this source: it is not one of the sources the nightly pass reads
 * (`EVERYTHING_READABLE_SOURCES`), so its own index never feeds back into it.
 */

export type MemoryKind = "person" | "org" | "project" | "place" | "event" | "topic" | "assignment";

/** One thing Psyche remembers, already filtered for what may be indexed. */
export interface MemoryRecord {
  id: string;
  kind: MemoryKind;
  name: string;
  aliases: readonly string[];
  /** A person's or organization's emails and phone numbers, so the owner's "never index" list applies. */
  identifiers?: readonly string[];
  /** Project status or work status, when it has one. */
  status?: string | null;
  /** ISO: when a project, to-do or event is due or starts. */
  dueAt?: string | null;
  /** The project or event this is part of, by name. */
  partOf?: string | null;
  /** Current, reviewed, non-sensitive facts. */
  facts: readonly { attribute: string; value: string; provenance: "owner" | "agent" | "system" }[];
  /** ISO. */
  createdAt: string;
  updatedAt: string;
  lastInteractionAt?: string | null;
}

export interface MemorySourceDeps {
  /** Everything that may be indexed; undefined while memory is off or not ready. */
  read: () => readonly MemoryRecord[] | undefined;
  /** Why memory cannot be read now (off, still opening), or undefined. */
  unavailable: () => string | undefined;
}

const KIND_LABEL: Record<MemoryKind, string> = {
  person: "Person",
  org: "Organization",
  project: "Project",
  place: "Place",
  event: "Event",
  topic: "Topic",
  assignment: "To-do",
};

const time = (iso: string | null | undefined): number | undefined => {
  if (typeof iso !== "string") return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
};

/** The item for one record, or undefined when it adds nothing the name alone would (see below). */
export function memoryItem(r: MemoryRecord): SourceItem | undefined {
  const facts = r.facts.filter((f) => f.value.trim() !== "");
  const aliases = r.aliases.filter((a) => a.trim() !== "" && a !== r.name);
  const hasDetail =
    facts.length > 0 ||
    aliases.length > 0 ||
    r.dueAt != null ||
    r.partOf != null ||
    r.status != null;
  // People and projects already have a document of their own (name and aliases); a bare one adds
  // nothing, so only those with facts, a status or a date get a Memory item.
  if ((r.kind === "person" || r.kind === "project") && !hasDetail) return undefined;
  const lines = [
    `${KIND_LABEL[r.kind]}: ${r.name}`,
    aliases.length > 0 ? `Also called: ${aliases.join(", ")}` : "",
    r.status != null && r.status !== "" ? `Status: ${r.status.replace(/_/g, " ")}` : "",
    r.dueAt != null ? `${r.kind === "event" ? "When" : "Due"}: ${r.dueAt}` : "",
    r.partOf != null && r.partOf !== "" ? `Part of: ${r.partOf}` : "",
    ...facts.map((f) => `${f.attribute.replace(/_/g, " ")}: ${f.value}`),
  ].filter((l) => l !== "");
  // What the owner wrote or the system knows is the owner's; a fact a model proposed (and the
  // owner accepted) came from reading other content, so the item is not marked as the owner's.
  const owner = facts.every((f) => f.provenance !== "agent");
  const when =
    (r.kind === "assignment" || r.kind === "event" || r.kind === "project"
      ? time(r.dueAt)
      : undefined) ??
    time(r.lastInteractionAt) ??
    time(r.createdAt) ??
    0;
  return {
    nativeId: r.id,
    title: r.name,
    text: lines.join("\n"),
    createdAt: when,
    ...(time(r.updatedAt) === undefined ? {} : { updatedAt: time(r.updatedAt) as number }),
    provenance: owner ? "owner" : "untrusted",
    tags: ["memory", `memory:${r.kind}`],
    // Who it is about, for the owner's "never index" list (a name, an alias, an address or number).
    ...(r.kind === "person" || r.kind === "org"
      ? { parties: [r.name, ...aliases, ...(r.identifiers ?? [])] }
      : {}),
    // Collapses onto the person's or project's own document in grouped results.
    ...(r.kind === "person" || r.kind === "project" ? { parentId: graphDocId(r.id) } : {}),
  };
}

export function memoryAdapter(deps: MemorySourceDeps): SourceAdapter {
  return {
    id: "memory",
    unavailable: () => deps.unavailable(),
    async pull(): Promise<SourcePull> {
      const records = deps.read();
      if (records === undefined) throw new Error("memory is not ready");
      const items: SourceItem[] = [];
      for (const r of records) {
        const item = memoryItem(r);
        if (item !== undefined) items.push(item);
      }
      // A whole read each time (the Gateway's reads are local and cheap): the manager keeps what
      // is in it and forgets the rest.
      return { items, cursor: null, hasMore: false, snapshot: true };
    },
  };
}
