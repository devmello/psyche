import { getSetting, type PsycheDb } from "@psyche/db";
import type { EverythingStore, GraphStore } from "@psyche/memory";
import { EVERYTHING_MEMORY_SETTING_KEY, type GraphEntityKind } from "@psyche/protocol";
import {
  type MemoryRecord,
  type MemorySourceDeps,
  type ProcessingModel,
  readSourcesConfig,
  type SourceConfig,
  type SourcesConfig,
} from "@psyche/search";
import { everythingSettings } from "./everything.ts";
import { MEMORY_ENCRYPT_SETTING } from "./memory-db.ts";

/**
 * What the Memory search source may index (Settings → Search sources → Memory), read from the
 * people and projects graph. This is the gate: `search`'s adapter only formats what it is handed,
 * so anything not returned here is never indexed.
 *
 * - Entities: active, not hidden ("don't track") and not kept private (those show on their Memory
 *   page only, never on a surface; Search is one).
 * - Facts: current, accepted (accepted, auto-accepted or edited; nothing waiting for review,
 *   discarded or quarantined), not sensitive in any class, and not what a third party wrote
 *   (`untrusted`), the same line the graph's own full-text index draws.
 * - A fact memory learned from another source (it cites Messages, Mail, ...) carries that
 *   source's rules with it: it is dropped when the source is one the agent may not search (and
 *   Memory is open to the agent), or one whose text may not go to a model class Memory allows. A
 *   learned fact whose citations cannot be checked is dropped (as `visibleToAgent` does).
 * - Not the model's one-line summary of a person (written from other people's mail) and not the
 *   open loops (extracted from mail and messages): neither is the owner's own memory to index.
 *
 * Nothing here reads Mail, Notes or any other app.
 */

const KINDS: GraphEntityKind[] = [
  "person",
  "org",
  "project",
  "place",
  "event",
  "topic",
  "assignment",
];

type Graph = Pick<
  GraphStore,
  "listEntities" | "getEntity" | "facts" | "edges" | "identifiers" | "interaction"
>;

/** How far a source's text may travel: none (nowhere), local (this Mac), cloud (any model). */
const REACH: Record<ProcessingModel, number> = { none: 0, local: 1, cloud: 2 };

/**
 * The rules a fact's source puts on where its text may go. `config` is Search's per-source
 * choices, read on every pass: `memory` is Memory's own row.
 */
export function sourceRules(config: SourcesConfig): (source: string) => boolean {
  const memory = config.sources.memory;
  return (source) => {
    // Chats with Psyche are not a Search source: the owner's own, no rule of theirs. Contacts is
    // one now, but a fact memory learned from the owner's address book keeps the rule it always
    // had (none): Contacts is structured data the owner keeps, and memory does not learn from the
    // Search source, only from the Contacts connector it already reads.
    if (source === "contacts") return true;
    const rule = (config.sources as Record<string, SourceConfig | undefined>)[source];
    if (rule === undefined) return true;
    // Open to the agent: only what the agent may search at the source.
    if (memory.agent && !rule.agent) return false;
    // Cards and summaries of Memory go to the model class Memory is set to: no further than the
    // source allows.
    return REACH[memory.processing] <= REACH[rule.processing];
  };
}

export function memoryRecords(
  graph: Graph,
  em: Pick<EverythingStore, "citations">,
  allowed: (source: string) => boolean = () => true,
): MemoryRecord[] {
  const visible = (e: { status: string; hidden: boolean; private?: boolean | undefined }) =>
    e.status === "active" && !e.hidden && e.private !== true;
  const out: MemoryRecord[] = [];
  const names = (id: string): string[] => {
    const e = graph.getEntity(id);
    if (e === undefined) return [];
    return [
      e.name,
      ...e.aliases,
      ...graph
        .identifiers(id)
        .filter((i) => i.kind === "email" || i.kind === "phone")
        .map((i) => i.value),
    ];
  };
  for (const e of graph.listEntities(KINDS)) {
    if (!visible(e)) continue;
    const edges = graph.edges(e.id);
    let partOf: string | null = null;
    if (e.kind === "assignment" || e.kind === "event") {
      const parents = edges
        .filter((x) => x.rel === "part_of" && x.src === e.id)
        .map((x) => graph.getEntity(x.dst))
        .filter((p): p is NonNullable<typeof p> => p !== undefined);
      // A parent the owner hid or kept private is not named here either; with several parents,
      // one private parent keeps every name out (the items of a private course are private).
      const parent = parents.find((p) => visible(p));
      if (parent !== undefined && !parents.some((p) => p.private === true)) partOf = parent.name;
    }
    // Who a project, to-do or event is about: everyone it is linked to, hidden or not, so a
    // contact the owner keeps out of the index also keeps out what is about them.
    const related =
      e.kind === "person" || e.kind === "org"
        ? []
        : [
            ...new Set(
              edges.flatMap((x) => {
                const other = graph.getEntity(x.src === e.id ? x.dst : x.src);
                return other !== undefined && (other.kind === "person" || other.kind === "org")
                  ? names(other.id)
                  : [];
              }),
            ),
          ];
    const facts = graph
      .facts(e.id)
      .filter((f) => (f.sensitivity ?? "none") === "none" && f.provenance !== "untrusted")
      .filter((f) => {
        // Written by the owner or a rule: no source rule. Learned by reading something: every
        // source it came from must allow it, and one whose sources cannot be found is not indexed.
        const cites = em.citations("fact", f.id);
        if (cites.length > 0) return cites.every((c) => allowed(c.source));
        if (f.extractor !== undefined) return false;
        // The people graph's own model pass writes `agent` facts with the interactions they were
        // drawn from (mail, messages, ...) and no citation: the channel of each is its source.
        if (f.provenance === "agent") {
          const channels = f.sources.map((id) => graph.interaction(id)?.source);
          return (
            channels.length > 0 && channels.every((c) => c !== undefined && allowed(c as string))
          );
        }
        return true;
      })
      .map((f) => ({
        attribute: f.attribute,
        value: f.value,
        provenance: f.provenance === "agent" ? ("agent" as const) : ("owner" as const),
      }));
    const identifiers =
      e.kind === "person" || e.kind === "org"
        ? graph
            .identifiers(e.id)
            .filter((i) => i.kind === "email" || i.kind === "phone")
            .map((i) => i.value)
        : [];
    out.push({
      id: e.id,
      kind: e.kind,
      name: e.name,
      aliases: e.aliases,
      ...(identifiers.length > 0 ? { identifiers } : {}),
      ...(related.length > 0 ? { related } : {}),
      status: e.workStatus ?? e.projectStatus ?? null,
      dueAt: e.kind === "person" || e.kind === "org" ? null : e.dueAt,
      partOf,
      facts,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      lastInteractionAt: e.lastInteractionAt,
    });
  }
  return out;
}

/** What Memory's agent access is: `none` stops the agent reading anything memory learned. */
export type AgentMode = "none" | "accepted" | "all";

/**
 * The source's seam. While the owner has the memory graph off it reads nothing (an empty read,
 * which removes what was indexed: off means off), while memory is still opening it says so, and
 * it stands down when memory is encrypted and the search index is not actually encrypted (the
 * index would hold a plain copy of what the owner chose to keep encrypted; "actually" because the
 * index stays plain when its key is unavailable, whatever `search.encrypt` says).
 */
export function memorySourceDeps(o: {
  /** The graph while the owner has memory on; undefined while it is off. */
  graph: () => Graph | undefined;
  /** For the sources a learned fact cites; absent, learned facts cannot be checked and are left out. */
  em?: Pick<EverythingStore, "citations">;
  /** Search's per-source choices, read on every pass. */
  config: () => SourcesConfig;
  /** What the agent may read of memory (`memory.everything` agent access, off = none). */
  agentMode: () => AgentMode;
  /** `memory.encrypt`: the owner keeps memory encrypted. */
  memoryEncrypted: () => boolean;
  /** False while the memory store is still opening (it may sit behind the Mac helper's key). */
  ready?: () => boolean;
}): MemorySourceDeps {
  const ready = () => o.ready?.() ?? true;
  // The index's real state, bound by Search when it builds the index (see `bindIndex`).
  let indexEncrypted = () => false;
  return {
    unavailable: () => (ready() ? undefined : "Memory is still opening"),
    bindIndex: (encrypted) => {
      indexEncrypted = encrypted;
    },
    blocked: () =>
      o.memoryEncrypted() && !indexEncrypted() ? MEMORY_NEEDS_ENCRYPTED_INDEX : undefined,
    agentBlocked: () => (o.agentMode() === "none" ? MEMORY_AGENT_NONE : undefined),
    read: () => {
      if (!ready()) return undefined;
      const graph = o.graph();
      if (graph === undefined) return [];
      const none = { citations: () => [] };
      return memoryRecords(graph, o.em ?? none, sourceRules(o.config()));
    },
  };
}

/**
 * The settings Memory's source follows, read on every call so a change applies to the next pass:
 * Search's per-source choices, memory's agent access (off means none, as `agentAccess()` in
 * `people.ts` has it) and whether memory is encrypted.
 */
export function memorySettings(
  db: PsycheDb,
): Pick<Parameters<typeof memorySourceDeps>[0], "config" | "agentMode" | "memoryEncrypted"> {
  return {
    config: () => readSourcesConfig(getSetting(db, "search.sources")?.value),
    agentMode: () => {
      const s = everythingSettings(getSetting(db, EVERYTHING_MEMORY_SETTING_KEY)?.value);
      return s.enabled ? s.agentAccess : "none";
    },
    memoryEncrypted: () => getSetting(db, MEMORY_ENCRYPT_SETTING)?.value === true,
  };
}

export const MEMORY_NEEDS_ENCRYPTED_INDEX =
  "Turn on search index encryption first: your memory is encrypted, and this would copy it into a search index that is not.";
export const MEMORY_AGENT_NONE =
  "Memory's agent access is set to none, so the agent can't search it. Change that on Memory first.";
