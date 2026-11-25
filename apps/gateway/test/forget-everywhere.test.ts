import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  });
});
