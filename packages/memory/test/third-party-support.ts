import { EVERYTHING_MEMORY_DEFAULTS, type EverythingMemorySettings } from "@psyche/protocol";
import { FakeClock, FakeModelProvider } from "@psyche/testing";
import Database from "better-sqlite3";
import { type PassDeps, SearchDocReader, type SystemState } from "../src/extraction/index.ts";
import { EverythingStore } from "../src/graph/everything.ts";
import { GraphStore } from "../src/graph/store.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

export const NOW = Date.parse("2026-10-29T03:00:00Z");
export const DAY = 86_400_000;
export const NIGHT: SystemState = {
  onAc: true,
  lowPowerMode: false,
  thermal: "nominal",
  idleMinutes: 60,
};

const DDL = `CREATE TABLE search_docs (rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, grp TEXT NOT NULL,
  title TEXT NOT NULL, body TEXT NOT NULL, extra TEXT NOT NULL, provenance TEXT NOT NULL, thread_id TEXT, parent_id TEXT,
  collapse_key TEXT NOT NULL, scope_key TEXT NOT NULL, sender TEXT, sender_key TEXT, mime TEXT, tags TEXT NOT NULL,
  source TEXT, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL)`;

export function settingsWith(over: {
  sources?: Partial<EverythingMemorySettings["sources"]>;
  people?: Partial<EverythingMemorySettings["people"]>;
  sensitive?: Partial<EverythingMemorySettings["sensitive"]>;
}): EverythingMemorySettings {
  const base = structuredClone(EVERYTHING_MEMORY_DEFAULTS) as EverythingMemorySettings;
  return {
    ...base,
    enabled: true,
    sources: { ...base.sources, mail: true, ...over.sources },
    people: { ...base.people, ...over.people },
    sensitive: { ...base.sensitive, ...over.sensitive },
    model: { default: { kind: "cloud", ref: "fake/haiku" } },
  };
}

export interface World {
  env: TestEnv;
  search: Database.Database;
  graph: GraphStore;
  em: EverythingStore;
  clock: FakeClock;
  provider: FakeModelProvider;
  ownerId: string;
  samId: string;
  priyaId: string;
  doc(o: DocInput): string;
  deps(over?: Partial<PassDeps>): PassDeps;
  sent(): string;
  close(): Promise<void>;
}

export interface DocInput {
  id?: string;
  title?: string;
  body: string;
  provenance?: "owner" | "untrusted";
  sender?: string | null;
  thread?: string;
  source?: string;
  ms?: number;
  scope?: string;
}

/** The owner, Sam (a two-way contact with sam@acme.com) and Priya (a known person, never written to). */
export async function makeWorld(): Promise<World> {
  const clock = new FakeClock(NOW);
  const env = await makeEnv({ clock });
  const graph = new GraphStore({ sqlite: env.db.sqlite, clock });
  const em = new EverythingStore({ sqlite: env.db.sqlite, graph, clock });
  const ownerId = graph.createEntity({ kind: "person", name: "The Owner", isOwner: true }).id;
  const samId = graph.createEntity({
    kind: "person",
    name: "Sam Lee",
    identifiers: [{ kind: "email", value: "sam@acme.com" }],
    // Learned from mail headers, not from Contacts: not a "contact" until the owner says so.
    source: "mail",
    linkedBy: "rule",
  }).id;
  const priyaId = graph.createEntity({
    kind: "person",
    name: "Priya Rao",
    identifiers: [{ kind: "email", value: "priya@x.io" }],
    source: "mail",
    linkedBy: "rule",
  }).id;
  const when = new Date(NOW - 5 * DAY).toISOString();
  for (const [dir, ref] of [
    ["out", "sent-1"],
    ["in", "got-1"],
  ] as const) {
    graph.upsertInteraction({
      kind: "mail",
      source: "mail",
      externalRef: ref,
      occurredAt: when,
      direction: dir,
      participants: [{ entityId: samId, role: dir === "out" ? "to" : "from" }],
    });
  }
  const search = new Database(":memory:");
  search.exec(DDL);
  const provider = new FakeModelProvider({ id: "fake" });
  let seq = 0;
  return {
    env,
    search,
    graph,
    em,
    clock,
    provider,
    ownerId,
    samId,
    priyaId,
    doc(o) {
      const id = o.id ?? `mail:${++seq}`;
      const ms = o.ms ?? NOW - DAY / 2;
      search
        .prepare(
          `INSERT INTO search_docs (id, kind, grp, title, body, extra, provenance, thread_id, collapse_key, scope_key, sender, tags, source, created_ms, updated_ms)
           VALUES (?, 'connector', 'connectors', ?, ?, '', ?, ?, ?, ?, ?, '[]', ?, ?, ?)`,
        )
        .run(
          id,
          o.title ?? "",
          o.body,
          o.provenance ?? "untrusted",
          o.thread ?? null,
          id,
          o.scope ?? "owner",
          o.sender === undefined ? "Sam Lee <sam@acme.com>" : o.sender,
          o.source ?? "connector:mail",
          ms,
          ms,
        );
      return id;
    },
    deps(over = {}) {
      return {
        graph,
        em,
        sqlite: env.db.sqlite,
        reader: new SearchDocReader(search),
        settings: settingsWith({}),
        state: NIGHT,
        clock,
        timeZone: "UTC",
        localMinutes: 3 * 60,
        modelFor: () => ({ provider, model: "fake/haiku" }),
        ...over,
      };
    },
    sent() {
      return provider.requests
        .flatMap((r) =>
          r.messages.flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : []))),
        )
        .join("\n");
    },
    async close() {
      search.close();
      await env.cleanup();
    },
  };
}

export const say = (text: string) => [
  { type: "text_delta" as const, text },
  { type: "finish" as const, reason: "stop" as const },
];

export const factJson = (facts: object[], flags: object[] = []) =>
  JSON.stringify({ facts, edges: [], flags });

export function fact(over: object = {}) {
  const quote = "My birthday is May 3.";
  return {
    handle: "p1",
    attribute: "birthday",
    value: "May 3",
    item: "i1",
    quote,
    start: 0,
    end: quote.length,
    subject_kind: "self_disclosure",
    sensitivity: "none",
    confidence: 0.95,
    ...over,
  };
}
