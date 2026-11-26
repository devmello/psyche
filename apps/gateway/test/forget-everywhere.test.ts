import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, ik, remoteClient, type TestClient } from "./helpers.ts";

/**
 * Forget everywhere (memory wave 3A): "Jordan" is seeded into every store memory has, `Jordana`
 * and unrelated facts are the controls, and forgetting "Jordan" must leave no row, line or chunk
 * that names him, anywhere, while the controls and the persona files stay. The preview, the dry
 * run and the forget report the same counts.
 */

let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

const JORDAN = /(?<![\p{L}\p{N}])jordan(?![\p{L}\p{N}])/iu;
const NOW = "2026-11-20T10:00:00.000Z";

async function compose(): Promise<ComposedGateway> {
  home = mkdtempSync(join(tmpdir(), "psyche-forget-all-"));
  const gw = await composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
  });
  await new Promise((r) => setTimeout(r, 10));
  return gw;
}

/** Every cell of every table in `sqlite` that names Jordan: `table: cell` (short). */
function leaks(
  sqlite: ComposedGateway["db"]["sqlite"],
  only?: (table: string) => boolean,
): string[] {
  // The run-trace pass queues the phrase until it has cut the traces, then deletes the row; this
  // test runs no background worker, so the row is still there.
  const queued = (t: string) => t !== "trace_scrub_queue";
  const out: string[] = [];
  const tables = (
    sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]
  )
    .map((t) => t.name)
    .filter((t) => queued(t) && (only === undefined || only(t)));
  for (const table of tables) {
    let rows: Record<string, unknown>[];
    try {
      rows = sqlite.prepare(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[];
    } catch {
      continue; // a virtual table whose module is not loaded here
    }
    for (const row of rows) {
      for (const [col, v] of Object.entries(row)) {
        const text = Buffer.isBuffer(v) ? v.toString("latin1") : typeof v === "string" ? v : "";
        if (JORDAN.test(text)) out.push(`${table}.${col}: ${text.slice(0, 60)}`);
      }
    }
  }
  return out;
}

interface Seed {
  jordanId: string;
  jordanaId: string;
  patId: string;
  controlFactId: string;
}

async function seed(c: ComposedGateway): Promise<Seed> {
  const g = c.people.graph;
  const sql = c.db.sqlite;
  const mem = c.memory;

  // Markdown: a daily note, MEMORY.md and USER.md lines; the persona file SOUL.md keeps its text.
  await mem.appendDailyNote({
    text: "Met Jordan for coffee near the harbour",
    provenance: "owner",
  });
  await mem.appendDailyNote({ text: "Jordana sent the photos", provenance: "owner" });
  await mem.appendDailyNote({ text: "Bought oat milk", provenance: "owner" });
  await mem.writeFileAsOwner(
    "MEMORY.md",
    "# Memory\n\n## People\n\n- Jordan is a close friend from school\n- Jordana is Pat's cousin\n- Pat likes tea\n",
  );
  await mem.writeFileAsOwner(
    "SOUL.md",
    "# Soul\n\nI keep things short.\nA teacher called Jordan taught me kindness.\n",
  );

  // A claim and its control.
  await mem.addClaim({
    text: "Jordan lives in Oslo",
    kind: "fact",
    provenance: "owner",
    confidence: 0.9,
    sources: [],
  });
  await mem.addClaim({
    text: "Pat likes tea",
    kind: "fact",
    provenance: "owner",
    confidence: 0.9,
    sources: [],
  });

  // People: Jordan, the lookalike Jordana, and Pat who knows both.
  const jordan = g.createEntity({
    kind: "person",
    name: "Jordan",
    aliases: ["JJ"],
    source: "owner",
  });
  const jordana = g.createEntity({ kind: "person", name: "Jordana", source: "owner" });
  const pat = g.createEntity({ kind: "person", name: "Pat", source: "owner" });
  const alex = g.createEntity({ kind: "person", name: "Alex", source: "owner" });
  g.setFact({ entityId: jordan.id, attribute: "city", value: "Oslo", provenance: "owner" });
  g.setFact({ entityId: jordana.id, attribute: "city", value: "Lima", provenance: "owner" });
  const control = g.setFact({
    entityId: pat.id,
    attribute: "preference",
    value: "likes strong tea",
    provenance: "owner",
  });
  g.setFact({
    entityId: pat.id,
    attribute: "note",
    value: "Used to date Jordan in college",
    provenance: "owner",
  });
  g.setFact({
    entityId: pat.id,
    attribute: "note",
    value: "Wants to visit Jordana in Lima",
    provenance: "owner",
  });
  sql
    .prepare("UPDATE graph_entities SET summary = ?, notes = ? WHERE id = ?")
    .run("Pat talks about Jordan a lot.", "likes hiking\nsee Jordan for the details", pat.id);
  sql
    .prepare("UPDATE graph_entities SET summary = ? WHERE id = ?")
    .run("Jordana runs the climbing club.", jordana.id);

  // A relation backed by a citation that quotes him, and one that does not.
  const edge = g.setEdge({
    src: pat.id,
    rel: "related_to",
    label: "friend",
    dst: alex.id,
    provenance: "owner",
  });
  const controlEdge = g.setEdge({
    src: pat.id,
    rel: "related_to",
    label: "colleague",
    dst: jordana.id,
    provenance: "owner",
  });
  const cite = sql.prepare(
    `INSERT INTO graph_citations (id, target_kind, target_id, source, source_ref, quote, start, "end",
       source_hash, provenance, observed_at, created_at)
     VALUES (?, ?, ?, 'mail', ?, ?, 0, 10, 'h', 'untrusted', ?, ?)`,
  );
  cite.run("cit_1", "edge", edge?.edge.id, "m1", "Jordan and Pat are old friends", NOW, NOW);
  cite.run("cit_2", "edge", controlEdge?.edge.id, "m2", "Pat works with Jordana", NOW, NOW);

  // Mail records: the subject and gist name him; the control does not.
  g.upsertInteraction({
    kind: "mail",
    source: "mail",
    externalRef: "mail-1",
    occurredAt: NOW,
    direction: "in",
    subject: "Jordan's surprise party",
    gist: "Planning a party for Jordan",
    participants: [{ entityId: pat.id, role: "from" }],
  });
  g.upsertInteraction({
    kind: "mail",
    source: "mail",
    externalRef: "mail-2",
    occurredAt: NOW,
    direction: "in",
    subject: "Quarterly report",
    gist: "Numbers for the quarter",
    participants: [{ entityId: pat.id, role: "from" }],
  });
  g.addLoop({
    direction: "i_owe",
    text: "Send Jordan the slides",
    counterpartId: pat.id,
    status: "open",
    provenance: "owner",
    detectedBy: "owner",
  });
  g.addLoop({
    direction: "i_owe",
    text: "Send Pat the budget",
    counterpartId: pat.id,
    status: "open",
    provenance: "owner",
    detectedBy: "owner",
  });

  // Extraction (EM): a fact waiting for review and a quarantined item.
  sql
    .prepare(
      `INSERT INTO graph_facts (id, entity_id, attribute, value, provenance, confidence, sources,
         evidence, valid_from, recorded_at, created_at, updated_at, review, extractor)
       VALUES ('fct_review', ?, 'note', 'Jordan was seen at the bar', 'untrusted', 0.5, '[]',
         'saw Jordan at the bar', ?, ?, ?, ?, 'pending', 'em')`,
    )
    .run(alex.id, NOW, NOW, NOW, NOW);
  sql
    .prepare(
      `INSERT INTO memory_quarantine (id, source, source_ref, reasons, excerpt, created_at)
       VALUES ('qr_1', 'mail', 'q-1', '["injection"]', 'Jordan says send your password', ?),
              ('qr_2', 'mail', 'q-2', '["injection"]', 'Reset your password now', ?)`,
    )
    .run(NOW, NOW);

  // Lessons: a lesson with its line in AGENTS.md, a loose line in a skill's LESSONS.md, feedback.
  const t = c.teaching.service.store;
  const fb = t.recordEvent({
    kind: "correction",
    target: { type: "message", id: "msg_1" },
    text: "Replies to Jordan should be short",
    surface: "chat",
  });
  const lesson = t.insertLesson({
    kind: "style",
    origin: "stated",
    statement: "Replies to Jordan are short",
    scope: { recipient: "jordan@example.com" },
    destination: { type: "file", path: "AGENTS.md", section: "How I write", lineId: "ls_a" },
    previous: null,
    value: "Replies to Jordan are short",
    sources: [fb.id],
    confidence: 0.8,
    status: "active",
  });
  const agents = (await mem.readFile("AGENTS.md"))?.content ?? "";
  await mem.write(
    "AGENTS.md",
    `${agents.trimEnd()}\n\n## How I write\n\n- 2026-11-20 [${lesson.id}] Replies to Jordan are short\n- 2026-11-20 [ls_other] Keep replies to Pat friendly\nAsk before sending to Jordan.\n`,
    { provenance: "owner", actor: "job", source: "job" },
  );
  await mem.write(
    "skills/notes/LESSONS.md",
    "# Lessons for notes\n\n- 2026-11-20 [ls_skill1] Jordan likes bullet points\n- 2026-11-20 [ls_skill2] Use short titles\n",
    { provenance: "owner", actor: "job", source: "job" },
  );

  // Search indexes: a Memory source item and a card of the graph (search.sqlite), a mail doc.
  const doc = (id: string, source: string, title: string, text: string) => ({
    id,
    kind: "connector" as const,
    title,
    text,
    provenance: "owner" as const,
    createdAt: Date.parse(NOW),
    source,
  });
  await c.search.index.index(
    doc("connector:memory:j", "connector:memory", "Jordan", "Person: Jordan\ncity: Oslo"),
  );
  await c.search.index.index(
    doc("connector:memory:p", "connector:memory", "Pat", "Person: Pat\nlikes: tea"),
  );
  await c.search.index.index(
    doc("connector:mail:1", "connector:mail", "Re: lunch", "Jordan wrote about lunch on Friday"),
  );

  // Connector state the poll and the ingesters keep in `graph_cursors`.
  g.setCursor("candidates:mail", {
    "jordan@example.com": { names: ["Jordan Lee"], threads: ["t1"], ownerSent: false },
    "jordana@example.com": { names: ["Jordana"], threads: ["t2"], ownerSent: false },
    "pat@example.com": { names: ["Pat"], threads: [], ownerSent: false },
  });
  g.setCursor("threads:asks", {
    t1: {
      counterpart: "jordan@example.com",
      askedAt: NOW,
      text: "Could you send me the slides?",
      interactionId: "i1",
    },
    t3: {
      counterpart: "pat@example.com",
      askedAt: NOW,
      text: "Can you ask Jordan about lunch?",
      interactionId: "i3",
    },
    t2: {
      counterpart: "pat@example.com",
      askedAt: NOW,
      text: "Can you send the report?",
      interactionId: "i2",
    },
  });
  g.setCursor("work:signals", {
    v: 1,
    reminders: {},
    events: {},
    files: {},
    folderSuggested: [],
    asks: [
      {
        entityId: pat.id,
        claims: "done",
        at: NOW,
        sources: [],
        evidence: "Jordan says it is done",
        origin: "untrusted_text",
      },
      {
        entityId: pat.id,
        claims: "done",
        at: NOW,
        sources: [],
        evidence: "Pat says it is done",
        origin: "untrusted_text",
      },
    ],
  });
  g.setCursor("poll:mail", { since: "2026-11-01T00:00:00.000Z" });

  return {
    jordanId: jordan.id,
    jordanaId: jordana.id,
    patId: pat.id,
    controlFactId: control?.fact.id ?? "",
  };
}

const PERSONA_SOUL =
  "# Soul\n\nI keep things short.\nA teacher called Jordan taught me kindness.\n";

describe("forget everywhere", () => {
  it("removes Jordan from every store, keeps Jordana and the controls, and previews the same counts", async () => {
    composed = await compose();
    const c = composed;
    const desk = await adminClient(c.gateway);
    clients.push(desk);
    const s = await seed(c);
    await c.memory.idle();

    // The seed really put him in the stores (a positive control for the scan below).
    const before = leaks(c.db.sqlite);
    for (const store of [
      "memory_chunks",
      "memory_claims",
      "graph_entities",
      "graph_facts",
      "graph_citations",
      "graph_interactions",
      "graph_loops",
      "memory_quarantine",
      "lessons",
      "feedback_events",
      "graph_cursors",
      "search_docs",
    ]) {
      expect(
        before.some((l) => l.startsWith(`${store}.`)),
        `seeded ${store}`,
      ).toBe(true);
    }
    expect(leaks(c.search.index.db, (t) => t === "search_docs").length).toBeGreaterThan(0);

    // Preview, dry run and forget agree.
    const preview = await desk.call<{
      counts: Record<string, number>;
      total: number;
      uncounted: string[];
    }>("memory.forget.preview", { subject: "Jordan" });
    expect(preview.total).toBeGreaterThan(0);
    expect(preview.counts).toMatchObject({
      graphEntities: 1,
      claims: 1,
      quarantine: 1,
      lessons: 1,
      // Jordan's own document, Pat's (its summary named him; it is rebuilt without) and the
      // Memory source item.
      searchDocs: 3,
    });
    expect(preview.counts.graphFacts).toBe(2); // his city, and the note on Pat
    expect(preview.counts.reviewItems).toBe(1);
    expect(preview.counts.graphLoops).toBe(1);
    expect(preview.counts.graphInteractions).toBe(1);
    expect(preview.counts.lessonLines).toBe(2); // the lesson's line, and the loose skill line
    expect(preview.uncounted).toEqual(["runTraces", "savedChats"]);
    const dry = await desk.call<{ counts: Record<string, number> }>(
      "memory.forget",
      { subject: "Jordan", dryRun: true },
      ik(),
    );
    expect(dry.counts).toEqual(preview.counts);
    // A preview deletes nothing.
    expect(leaks(c.db.sqlite)).toEqual(before);

    const done = await desk.call<{ counts: Record<string, number> }>(
      "memory.forget",
      { subject: "Jordan" },
      ik(),
    );
    expect(done.counts).toEqual(preview.counts);
    await c.memory.idle();

    // Zero rows name him in the database, the search index memory docs, or the workspace.
    expect(leaks(c.db.sqlite)).toEqual([]);
    // Connector state: nothing in `graph_cursors` names him; Jordana's candidate, Pat's own asks
    // and the poll cursor stay.
    const cursorRows = c.db.sqlite.prepare("SELECT source, cursor FROM graph_cursors").all() as {
      source: string;
      cursor: string;
    }[];
    for (const r of cursorRows) expect(r.cursor, r.source).not.toMatch(JORDAN);
    expect(Object.keys(c.people.graph.cursor("candidates:mail") as object).sort()).toEqual([
      "jordana@example.com",
      "pat@example.com",
    ]);
    expect(Object.keys(c.people.graph.cursor("threads:asks") as object)).toEqual(["t2"]);
    expect(
      (c.people.graph.cursor("work:signals") as { asks: { evidence: string }[] }).asks.map(
        (a) => a.evidence,
      ),
    ).toEqual(["Pat says it is done"]);
    expect(c.people.graph.cursor("poll:mail")).toEqual({ since: "2026-11-01T00:00:00.000Z" });
    expect(leaks(c.search.index.db, (t) => t === "search_docs" || t === "search_cards")).toEqual(
      // Only the mail document is left: it is Search's copy of a mail, not Memory's, and no
      // Memory source item, card or People document names him.
      ["search_docs.body: Jordan wrote about lunch on Friday"],
    );
    const mail = c.search.index.db
      .prepare("SELECT id FROM search_docs WHERE id = 'connector:mail:1'")
      .all();
    expect(mail).toHaveLength(1);
    for (const path of await c.memory.listFiles()) {
      // Persona and instruction files keep the owner's own words (their chunks leave the index).
      if (path === "SOUL.md" || path === "AGENTS.md") continue;
      expect(JORDAN.test((await c.memory.readFile(path))?.content ?? ""), path).toBe(false);
    }
    // Persona files are untouched; their chunks are out of the index and stay out on reindex.
    expect(readFileSync(join(home, "workspace", "SOUL.md"), "utf8")).toBe(PERSONA_SOUL);
    const soulChunks = () =>
      (
        c.db.sqlite.prepare("SELECT text FROM memory_chunks WHERE source = 'SOUL.md'").all() as {
          text: string;
        }[]
      ).map((r) => r.text);
    expect(soulChunks().some((t) => JORDAN.test(t))).toBe(false);
    writeFileSync(join(home, "workspace", "SOUL.md"), `${PERSONA_SOUL}Another line.\n`);
    const synced = await c.memory.sync();
    // The file was indexed again (its chunk with his name is dropped whole, with its neighbours).
    expect(synced.changed).toContain("SOUL.md");
    expect(soulChunks().some((t) => JORDAN.test(t))).toBe(false);
    expect(leaks(c.db.sqlite)).toEqual([]);

    // Controls survive: Jordana, Pat's unrelated facts, the other mail, quarantine, lessons, docs.
    const g = c.people.graph;
    expect(g.getEntity(s.jordanaId)?.name).toBe("Jordana");
    expect(g.facts(s.jordanaId).map((f) => f.value)).toEqual(["Lima"]);
    expect(
      g
        .facts(s.patId)
        .map((f) => f.value)
        .sort(),
    ).toEqual(["Wants to visit Jordana in Lima", "likes strong tea"]);
    expect(g.getEntity(s.jordanId)).toBeUndefined();
    expect(g.edges(s.patId).map((e) => e.label)).toEqual(["colleague"]);
    const loops = c.db.sqlite.prepare("SELECT text FROM graph_loops").all() as { text: string }[];
    expect(loops.map((l) => l.text)).toEqual(["Send Pat the budget"]);
    const subjects = c.db.sqlite.prepare("SELECT subject FROM graph_interactions").all() as {
      subject: string | null;
    }[];
    expect(subjects.map((r) => r.subject)).toHaveLength(2);
    expect(subjects.map((r) => r.subject)).toContain("Quarterly report");
    expect(subjects.map((r) => r.subject)).toContain(null); // blanked, not deleted
    expect(
      (
        c.db.sqlite.prepare("SELECT excerpt FROM memory_quarantine WHERE id = 'qr_2'").get() as {
          excerpt: string;
        }
      ).excerpt,
    ).toBe("Reset your password now");
    expect(g.getEntity(s.patId)?.name).toBe("Pat");
    const claims = (await c.memory.listClaims()).filter((x) => x.retractedAt == null);
    expect(claims.map((x) => x.text)).toEqual(["Pat likes tea"]);
    expect(await c.memory.readFile("MEMORY.md").then((f) => f?.content)).toContain(
      "Jordana is Pat's cousin",
    );
    const agentsAfter = (await c.memory.readFile("AGENTS.md"))?.content ?? "";
    expect(agentsAfter).toContain("[ls_other] Keep replies to Pat friendly");
    expect(agentsAfter).not.toContain("Replies to Jordan are short");
    expect(agentsAfter).toContain("Ask before sending to Jordan."); // the owner's own line
    expect((await c.memory.readFile("skills/notes/LESSONS.md"))?.content).toContain(
      "Use short titles",
    );
    expect(
      c.search.index.db.prepare("SELECT 1 FROM search_docs WHERE id = 'connector:memory:p'").get(),
    ).toBeDefined();

    // Forgetting the same word again finds nothing.
    const again = await desk.call<{ total: number }>("memory.forget.preview", {
      subject: "Jordan",
    });
    expect(again.total).toBe(0);
    // His identifiers cannot bring the person back: the blocklist holds hashes only.
    expect(leaks(c.db.sqlite)).toEqual([]);
  });

  it("refuses a non-desktop connection both methods; the desktop passes", async () => {
    composed = await compose();
    const desk = await adminClient(composed.gateway);
    const phone = await remoteClient(composed.gateway);
    clients.push(desk, phone);
    await desk.call("memory.remember", { text: "Met Jordan today" }, ik());
    // Control: the desktop previews and forgets.
    const ok = await desk.call<{ counts: { markdownLines: number } }>("memory.forget.preview", {
      subject: "Jordan",
    });
    expect(ok.counts.markdownLines).toBe(1);
    for (const [method, params] of [
      ["memory.forget.preview", { subject: "Jordan" }],
      ["memory.forget", { subject: "Jordan", dryRun: true }],
      ["memory.forget", { subject: "Jordan" }],
    ] as const) {
      const res = await phone.request(method, params, ik());
      expect(res.ok, method).toBe(false);
      expect((res.error as { code: string }).code).toBe("forbidden");
      expect(JSON.stringify(res)).not.toContain("markdownLines");
    }
    // Nothing was deleted by the refused calls.
    const after = await desk.call<{ counts: { markdownLines: number } }>("memory.forget.preview", {
      subject: "Jordan",
    });
    expect(after.counts.markdownLines).toBe(1);
  });

  it("matches whole words: a name that contains the word, or shares one, stays", async () => {
    composed = await compose();
    const c = composed;
    const desk = await adminClient(c.gateway);
    clients.push(desk);
    const g = c.people.graph;
    const jordana = g.createEntity({ kind: "person", name: "Jordana", source: "owner" });
    const lee = g.createEntity({ kind: "person", name: "Jordan Lee", source: "owner" });
    const smith = g.createEntity({ kind: "person", name: "Sam Smith", source: "owner" });
    g.setFact({
      entityId: smith.id,
      attribute: "note",
      value: "Jordanian food fan",
      provenance: "owner",
    });
    g.setFact({
      entityId: smith.id,
      attribute: "note",
      value: "Lives on Jordan Street",
      provenance: "owner",
    });
    const p = await desk.call<{ counts: Record<string, number> }>("memory.forget.preview", {
      subject: "Jordan",
    });
    // "Jordan Lee" and the street fact match the whole word; "Jordana" and "Jordanian" do not.
    expect(p.counts.graphEntities).toBe(1);
    expect(p.counts.graphFacts).toBe(1);
    await desk.call("memory.forget", { subject: "Jordan" }, ik());
    expect(g.getEntity(lee.id)).toBeUndefined();
    expect(g.getEntity(jordana.id)?.name).toBe("Jordana");
    expect(g.facts(smith.id).map((f) => f.value)).toEqual(["Jordanian food fan"]);
    // The agent's own name and persona files are not a target: the owner entity is never deleted.
    const owner = g.ensureOwnerEntity({ name: "Owner Jordan" });
    await desk.call("memory.forget", { subject: "Owner Jordan" }, ik());
    expect(g.getEntity(owner.id)).toBeDefined();
  });

  it("memory.reset also erases the graph, review and quarantine rows and their search docs", async () => {
    composed = await compose();
    const c = composed;
    const desk = await adminClient(c.gateway);
    clients.push(desk);
    await seed(c);
    const count = (t: string) =>
      (c.db.sqlite.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
    expect(count("graph_entities")).toBeGreaterThan(0);
    expect(count("graph_citations")).toBeGreaterThan(0);
    expect(count("memory_quarantine")).toBeGreaterThan(0);
    const dry = await desk.call<{ graph?: Record<string, number> }>(
      "memory.reset",
      { dryRun: true },
      ik(),
    );
    expect(dry.graph?.entities).toBeGreaterThan(0);
    expect(count("graph_entities")).toBeGreaterThan(0);
    const done = await desk.call<{ graph?: Record<string, number> }>("memory.reset", {}, ik());
    expect(done.graph).toEqual(dry.graph);
    for (const t of [
      "graph_entities",
      "graph_facts",
      "graph_edges",
      "graph_interactions",
      "graph_loops",
      "graph_citations",
      "memory_quarantine",
      "lessons",
      "feedback_events",
    ]) {
      expect(count(t), t).toBe(0);
    }
    const docs = c.search.index.db
      .prepare("SELECT id FROM search_docs WHERE source IN ('memory-graph', 'connector:memory')")
      .all();
    expect(docs).toEqual([]);
    expect(leaks(c.db.sqlite)).toEqual([]);
    // Connector state with addresses, ask texts and evidence goes; where each poll stopped stays.
    for (const key of ["candidates:mail", "threads:asks", "work:signals"]) {
      expect(c.people.graph.cursor(key), key).toBeUndefined();
    }
    expect(c.people.graph.cursor("poll:mail")).toEqual({ since: "2026-11-01T00:00:00.000Z" });
  });
});

describe("forget everywhere: what each entry point reaches", () => {
  const sqlOf = (c: ComposedGateway) => c.db.sqlite;
  const count = (c: ComposedGateway, t: string) =>
    (sqlOf(c).prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;

  async function samWorld(c: ComposedGateway) {
    const g = c.people.graph;
    const sam = g.createEntity({
      kind: "person",
      name: "Sam",
      identifiers: [{ kind: "email", value: "sam@example.com" }],
      source: "owner",
      linkedBy: "owner",
    });
    const samLee = g.createEntity({ kind: "person", name: "Sam Lee", source: "owner" });
    const pat = g.createEntity({ kind: "person", name: "Pat", source: "owner" });
    g.setFact({ entityId: sam.id, attribute: "city", value: "Oslo", provenance: "owner" });
    g.setFact({ entityId: samLee.id, attribute: "city", value: "Rome", provenance: "owner" });
    g.setFact({
      entityId: pat.id,
      attribute: "note",
      value: "Sam's birthday is in May",
      provenance: "owner",
    });
    c.teaching.service.store.insertLesson({
      kind: "style",
      origin: "stated",
      statement: "Replies to Sam are short",
      scope: {},
      destination: { type: "file", path: "AGENTS.md", section: "How I write", lineId: "ls_s" },
      previous: null,
      value: "Replies to Sam are short",
      sources: [],
      confidence: 0.8,
      status: "active",
    });
    await c.memory.appendDailyNote({ text: "Lunch with Sam", provenance: "owner" });
    return { g, sam, samLee, pat };
  }

  it("Forget person (memory.entities.forget) forgets that person only; /forget cascades (control)", async () => {
    composed = await compose();
    const c = composed;
    const desk = await adminClient(c.gateway);
    clients.push(desk);
    const { g, sam, samLee, pat } = await samWorld(c);
    expect(count(c, "lessons")).toBe(1);

    await desk.call("memory.entities.forget", { id: sam.id }, ik());
    // Sam's own entity, facts and identifiers go (and the Markdown lines, as before).
    expect(g.getEntity(sam.id)).toBeUndefined();
    expect(g.isBlocked("email", "sam@example.com")).toBe(true);
    for (const path of await c.memory.listFiles("memory/")) {
      expect((await c.memory.readFile(path))?.content ?? "").not.toMatch(/Lunch with Sam/);
    }
    // Must refuse: nothing beyond that person is touched.
    expect(g.getEntity(samLee.id)?.name).toBe("Sam Lee");
    expect(g.facts(samLee.id).map((f) => f.value)).toEqual(["Rome"]);
    expect(g.facts(pat.id).map((f) => f.value)).toEqual(["Sam's birthday is in May"]);
    expect(count(c, "lessons")).toBe(1);
    expect(
      sqlOf(c).prepare("SELECT 1 FROM memory_state WHERE key = 'forget.suppress'").get(),
    ).toBeUndefined();

    // Control: the desktop's /forget Sam is the everywhere forget.
    await desk.call("memory.forget", { subject: "Sam" }, ik());
    expect(g.getEntity(samLee.id)).toBeUndefined();
    expect(g.facts(pat.id)).toEqual([]);
    expect(
      (sqlOf(c).prepare("SELECT status FROM lessons").get() as { status: string }).status,
    ).toBe("forgotten");
  });

  it("an entity named like a common word cannot be used to forget anything else", async () => {
    composed = await compose();
    const c = composed;
    const desk = await adminClient(c.gateway);
    clients.push(desk);
    const { g, pat } = await samWorld(c);
    await c.memory.writeFileAsOwner("SOUL.md", "# Soul\n\nI keep the things I like.\n");
    await c.memory.idle();
    const the = g.createEntity({ kind: "person", name: "the", source: "owner" });
    const snapshot = () => ({
      facts: count(c, "graph_facts"),
      lessons: count(c, "lessons"),
      chunks: count(c, "memory_chunks"),
      entities: count(c, "graph_entities"),
    });
    const before = snapshot();
    await desk.call("memory.entities.forget", { id: the.id }, ik());
    expect(g.getEntity(the.id)).toBeUndefined(); // that entity itself goes
    expect(snapshot()).toEqual({ ...before, entities: before.entities - 1 });
    expect(g.facts(pat.id)).toHaveLength(1);
    // And the direct forget of a stopword is refused, preview and forget alike.
    for (const w of ["the", "The", "my", "is"]) {
      for (const method of ["memory.forget.preview", "memory.forget"] as const) {
        const res = await desk.request(method, { subject: w }, ik());
        expect(res.ok, `${method} ${w}`).toBe(false);
        expect((res.error as { code: string }).code).toBe("invalid_params");
      }
    }
  });

  it("forgets a two-character CJK name; refuses one character and two Latin letters", async () => {
    composed = await compose();
    const c = composed;
    const desk = await adminClient(c.gateway);
    clients.push(desk);
    await c.memory.appendDailyNote({ text: "和李明一起吃饭", provenance: "owner" });
    await c.memory.appendDailyNote({ text: "Bought tea", provenance: "owner" });
    const ok = await desk.call<{ counts: { markdownLines: number } }>(
      "memory.forget",
      { subject: "李明" },
      ik(),
    );
    expect(ok.counts.markdownLines).toBe(1);
    for (const subject of ["李", "ab"]) {
      const res = await desk.request("memory.forget", { subject }, ik());
      expect(res.ok, subject).toBe(false);
      expect((res.error as { code: string }).code).toBe("invalid_params");
    }
    const paths = await c.memory.listFiles("memory/");
    const text = (await Promise.all(paths.map((p) => c.memory.readFile(p))))
      .map((f) => f?.content)
      .join("\n");
    expect(text).toContain("Bought tea");
    expect(text).not.toContain("李明");
  });

  it("writes a keyed hash only when a persona or skill chunk matched, and never a bare SHA-256", async () => {
    composed = await compose();
    const c = composed;
    const desk = await adminClient(c.gateway);
    clients.push(desk);
    await c.memory.appendDailyNote({ text: "Met Jordan", provenance: "owner" });
    await c.memory.writeFileAsOwner("SOUL.md", "# Soul\n\nA teacher called Casey taught me.\n");
    await c.memory.idle();
    const suppress = () =>
      sqlOf(c).prepare("SELECT value FROM memory_state WHERE key = 'forget.suppress'").get() as
        | { value: string }
        | undefined;
    // No persona chunk names Jordan: nothing is written (a name list cannot reverse it).
    await desk.call("memory.forget", { subject: "Jordan" }, ik());
    expect(suppress()).toBeUndefined();
    // One does: a keyed entry is written, not the SHA-256 of the words.
    await desk.call("memory.forget", { subject: "Casey" }, ik());
    const entry = JSON.parse(suppress()?.value ?? "[]") as { k: number; h: string }[];
    expect(entry).toHaveLength(1);
    expect(entry[0]?.h).not.toBe(createHash("sha256").update("casey").digest("hex"));
    expect(entry[0]?.h).toMatch(/^[0-9a-f]{64}$/);
    const key = readFileSync(join(home, "workspace", ".psyche", "forget.key"), "utf8").trim();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(entry)).not.toMatch(/casey/i);
  });

  it("memory.reset is refused, with nothing erased, when the graph tables are not ready", async () => {
    composed = await compose();
    const c = composed;
    const desk = await adminClient(c.gateway);
    clients.push(desk);
    await c.memory.appendDailyNote({ text: "Keep this note", provenance: "owner" });
    // Control: a ready store resets (see the reset test above). Now break the backup table.
    sqlOf(c).exec("DROP TABLE memory_migration_backup_2026_11");
    const res = await desk.request("memory.reset", {}, ik());
    expect(res.ok).toBe(false);
    expect((res.error as { code: string }).code).toBe("unavailable");
    expect(JSON.stringify(res)).toMatch(/Nothing was erased/);
    expect((await c.memory.listFiles("memory/")).length).toBeGreaterThan(0);
    expect(count(c, "memory_chunks")).toBeGreaterThan(0);
  });

  it("the agent forgets a small plain thing alone; anything wide needs approval", async () => {
    composed = await compose();
    const c = composed;
    await samWorld(c);
    // Control: a small, plain, unrelated phrase goes through with no approval.
    await c.memory.appendDailyNote({ text: "Bought oolong tea", provenance: "owner" });
    const small = await c.memory.forget("oolong", { actor: "agent", dryRun: true });
    expect(small.counts?.markdownLines).toBe(1);
    await c.memory.forget("oolong", { actor: "agent" });
    // Must refuse: a person (graph entity) or a lesson is in the way.
    for (const phrase of ["Sam", "Replies to Sam"]) {
      await expect(c.memory.forget(phrase, { actor: "agent" })).rejects.toMatchObject({
        code: "approval_required",
      });
    }
    expect(c.people.graph.listEntities(["person"]).map((e) => e.name)).toContain("Sam");
    // Must refuse: a short phrase, even with nothing behind it.
    await c.memory.appendDailyNote({ text: "Ate pie", provenance: "owner" });
    await expect(c.memory.forget("pie", { actor: "agent" })).rejects.toMatchObject({
      code: "approval_required",
    });
    // Must refuse: more than 20 rows.
    for (let i = 0; i < 25; i++) {
      await c.memory.appendDailyNote({ text: `Visited Lisbon stop ${i}`, provenance: "owner" });
    }
    await expect(c.memory.forget("Lisbon", { actor: "agent" })).rejects.toMatchObject({
      code: "approval_required",
    });
    // The owner (no actor) is not held to these.
    await c.memory.forget("Lisbon");
  });

  it("fails closed when the key is gone: persona chunks of a forgotten phrase do not come back", async () => {
    composed = await compose();
    const c = composed;
    const desk = await adminClient(c.gateway);
    clients.push(desk);
    const soul = join(home, "workspace", "SOUL.md");
    const keyFile = join(home, "workspace", ".psyche", "forget.key");
    // Fresh install: no list, no key, and a forget with nothing to hide mints none.
    expect(existsSync(keyFile)).toBe(false);
    await c.memory.writeFileAsOwner("SOUL.md", "# Soul\n\nA teacher called Casey taught me.\n");
    await c.memory.idle();
    // Control: the first forget with a persona chunk mints the key (no prompt) and the list.
    await desk.call("memory.forget", { subject: "Casey" }, ik());
    expect(existsSync(keyFile)).toBe(true);
    const soulChunks = () =>
      (
        sqlOf(c).prepare("SELECT text FROM memory_chunks WHERE source = 'SOUL.md'").all() as {
          text: string;
        }[]
      ).map((r) => r.text);
    expect(soulChunks().some((t) => /Casey/.test(t))).toBe(false);
    // The key is lost (a pull that dropped it, a restore from backup); the file is reindexed.
    rmSync(keyFile);
    writeFileSync(soul, "# Soul\n\nA teacher called Casey taught me.\nI keep things short.\n");
    const synced = await c.memory.sync();
    expect(synced.changed).toContain("SOUL.md");
    // Must refuse: nothing of SOUL.md is indexed, and in particular not the forgotten phrase.
    expect(soulChunks()).toEqual([]);
    expect(existsSync(keyFile)).toBe(false); // and no new key was minted over the old list
    // A new forget cannot rebuild the list without its key either; the files stay unindexed.
    await desk.call("memory.forget", { subject: "Taylor" }, ik());
    expect(soulChunks()).toEqual([]);
    // Reset removes the key and the list together, and the files index again.
    await desk.call("memory.reset", {}, ik());
    expect(existsSync(keyFile)).toBe(false);
    expect(
      sqlOf(c).prepare("SELECT 1 FROM memory_state WHERE key = 'forget.suppress'").get(),
    ).toBeUndefined();
    expect(soulChunks().length).toBeGreaterThan(0);
  });
});
