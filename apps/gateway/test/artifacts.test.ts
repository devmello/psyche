import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type PsycheDb } from "@psyche/db";
import type { Artifact, ArtifactVersion } from "@psyche/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyOps, mergePatch, parseCell, parseTable } from "../src/artifacts/ops.ts";
import { ArtifactStore, SNAPSHOT_EVERY } from "../src/artifacts/store.ts";
import { artifactContextProvider, artifactTools, windowOf } from "../src/compose/artifacts.ts";

describe("artifact ops", () => {
  it("replaces exactly once and fails fast otherwise", () => {
    expect(applyOps("doc", "a b c", null, [{ op: "replace", old: "b", new: "B" }]).content).toBe(
      "a B c",
    );
    expect(() => applyOps("doc", "a a", null, [{ op: "replace", old: "a", new: "x" }])).toThrow(
      /more than once/,
    );
    expect(() => applyOps("doc", "abc", null, [{ op: "replace", old: "z", new: "x" }])).toThrow(
      /matches nothing/,
    );
  });

  it("inserts after an anchor or at the start, and counts rewrites", () => {
    const r = applyOps("code", "one\ntwo", null, [
      { op: "insert", after: "one\n", text: "1.5\n" },
      { op: "insert", after: "", text: "zero\n" },
    ]);
    expect(r.content).toBe("zero\none\n1.5\ntwo");
    expect(applyOps("doc", "x", null, [{ op: "rewrite", content: "y" }]).rewrites).toBe(1);
  });

  it("applies table ops with A1 cells on data rows", () => {
    expect(parseCell("B3")).toEqual([2, 1]);
    const csv = 'name,qty\n"Smith, J",2\nLee,3\n';
    expect(parseTable(csv)).toEqual({
      columns: ["name", "qty"],
      rows: [
        ["Smith, J", 2],
        ["Lee", 3],
      ],
    });
    const r = applyOps("table", csv, null, [
      { op: "set", cell: "B2", value: 4 },
      { op: "addRows", rows: [["Kim"]] },
      { op: "addColumn", name: "ok", values: [true] },
      { op: "view", view: { sort: { column: "qty", dir: "desc" } } },
    ]);
    expect(JSON.parse(r.content)).toEqual({
      columns: ["name", "qty", "ok"],
      rows: [
        ["Smith, J", 2, true],
        ["Lee", 4, null],
        ["Kim", null, null],
      ],
    });
    expect(r.view).toEqual({ sort: { column: "qty", dir: "desc" } });
    expect(() => applyOps("table", csv, null, [{ op: "set", cell: "C1", value: 1 }])).toThrow(
      /past the last column/,
    );
    expect(() => applyOps("table", csv, null, [{ op: "replace", old: "a", new: "b" }])).toThrow(
      /text, not tables/,
    );
  });

  it("windows reads", () => {
    const text = Array.from({ length: 1000 }, (_, i) => `l${i + 1}`).join("\n");
    const w = windowOf(text);
    expect([w.from, w.to, w.totalLines, w.truncated]).toEqual([1, 400, 1000, true]);
    expect(windowOf(text, 998, 2000)).toMatchObject({ from: 998, to: 1000, truncated: false });
  });
});

describe("chart, diagram and diff artifacts", () => {
  const chart = JSON.stringify({
    kind: "bar",
    categories: ["Q1", "Q2"],
    series: [{ name: "Sales", values: [3, 5] }],
  });

  it("merge-patches a chart and validates the result", () => {
    const r = applyOps("chart", chart, null, [
      {
        op: "patch",
        patch: { kind: "line", title: "Sales", series: [{ name: "Sales", values: [3, 6] }] },
      },
    ]);
    expect(JSON.parse(r.content)).toMatchObject({
      kind: "line",
      title: "Sales",
      series: [{ values: [3, 6] }],
    });
    // null removes a key
    expect(
      JSON.parse(
        applyOps("chart", r.content, null, [{ op: "patch", patch: { title: null } }]).content,
      ),
    ).not.toHaveProperty("title");
    expect(() =>
      applyOps("chart", chart, null, [
        { op: "patch", patch: { series: [{ name: "S", values: [1] }] } },
      ]),
    ).toThrow(/1 values for 2 categories/);
    expect(() => applyOps("chart", chart, null, [{ op: "replace", old: "a", new: "b" }])).toThrow(
      /does not apply to a chart/,
    );
    expect(() => applyOps("chart", "{", null, [])).toThrow(/valid JSON/);
  });

  it("ignores prototype keys in a patch", () => {
    const out = mergePatch({}, JSON.parse('{"__proto__":{"x":1},"a":1}')) as Record<
      string,
      unknown
    >;
    expect(out.a).toBe(1);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it("treats diagram and diff content as text", () => {
    expect(
      applyOps("diagram", "graph TD\n A-->B", null, [{ op: "replace", old: "B", new: "C" }])
        .content,
    ).toBe("graph TD\n A-->C");
    expect(
      applyOps("diff", "+a\n", null, [{ op: "insert", after: "+a\n", text: "+b\n" }]).content,
    ).toBe("+a\n+b\n");
  });
});

describe("ArtifactStore", () => {
  let db: PsycheDb;
  let home: string;
  let published: Array<{ artifact: Artifact; version: ArtifactVersion }>;
  let store: ArtifactStore;
  const agent = { author: "agent" as const, runId: "run_1", toolCallId: "tc_1" };

  beforeEach(() => {
    db = openDb(":memory:");
    home = mkdtempSync(join(tmpdir(), "psyche-art-"));
    published = [];
    store = new ArtifactStore({
      db,
      home,
      publish: (artifact, version) => published.push({ artifact, version }),
    });
  });
  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("creates, mirrors to the Library and returns a reference", async () => {
    const w = await store.create(
      { type: "doc", title: "Trip plan", content: "# Day 1\n", threadId: "thr_1" },
      agent,
    );
    expect(w.ref).toMatchObject({
      version: 1,
      type: "doc",
      title: "Trip plan",
      summary: "2 lines",
    });
    expect(w.ref).not.toHaveProperty("content");
    const path = join(home, "library", "artifacts", w.artifact.id, "trip-plan.md");
    expect(readFileSync(path, "utf8")).toBe("# Day 1\n");
    expect(published).toHaveLength(1);
  });

  it("versions edits, snapshots periodically and rebuilds any version", async () => {
    const pad = "x".repeat(500);
    const { artifact } = await store.create(
      { type: "doc", title: "N", content: `v1 ${pad}` },
      agent,
    );
    for (let v = 1; v <= SNAPSHOT_EVERY + 2; v++)
      await store.update(
        artifact.id,
        v,
        [{ op: "replace", old: `v${v}`, new: `v${v + 1}` }],
        agent,
      );
    const versions = store.versions(artifact.id);
    expect(versions.map((v) => v.kind).filter((k) => k === "snapshot")).toHaveLength(2);
    expect(store.contentAt(artifact.id, 5).content).toBe(`v5 ${pad}`);
    expect(store.contentAt(artifact.id).content).toBe(`v${SNAPSHOT_EVERY + 3} ${pad}`);
  });

  it("returns a conflict with the missed user edit instead of overwriting", async () => {
    const { artifact } = await store.create(
      { type: "doc", title: "N", content: "hello world" },
      agent,
    );
    await store.update(artifact.id, 1, [{ op: "replace", old: "hello", new: "hi" }], {
      author: "user",
    });
    const w = await store.update(
      artifact.id,
      1,
      [{ op: "replace", old: "world", new: "there" }],
      agent,
    );
    expect(w.conflict).toMatchObject({ base: 1, latest: 2 });
    expect(w.conflict?.missed[0]).toMatchObject({
      author: "user",
      ops: [{ op: "replace", old: "hello" }],
    });
    expect(store.contentAt(artifact.id).content).toBe("hi world");
  });

  it("restores an old version as a new one", async () => {
    const { artifact } = await store.create({ type: "doc", title: "N", content: "a" }, agent);
    await store.update(artifact.id, 1, [{ op: "rewrite", content: "b" }], agent);
    const w = await store.restore(artifact.id, 1, { author: "user" });
    expect(w.ref.version).toBe(3);
    expect(store.contentAt(artifact.id).content).toBe("a");
    expect(store.versions(artifact.id).at(-1)).toMatchObject({ restoredFrom: 1, author: "user" });
  });

  it("serves the agent tools: refs out, block emitted, taint kept", async () => {
    const [create, update, read] = artifactTools(store);
    const blocks: unknown[] = [];
    const ctx = {
      callId: "tc_9",
      threadId: "thr_1",
      runId: "run_9",
      taint: true,
      signal: new AbortController().signal,
      onUpdate: () => {},
      turn: { emitBlock: (b: unknown) => blocks.push(b) },
    } as never;
    const made = await create?.run?.({ type: "table", title: "Q", content: "a,b\n1,2" }, ctx);
    const ref = made?.output as { artifactId: string; version: number; summary: string };
    expect(ref.summary).toBe("1 rows × 2 columns");
    expect(blocks).toEqual([{ type: "artifact", artifactId: ref.artifactId, preview: "sheet" }]);
    const edited = await update?.run?.(
      { artifactId: ref.artifactId, base: 1, ops: [{ op: "set", cell: "A1", value: 9 }] },
      ctx,
    );
    expect(edited?.output).toMatchObject({ version: 2 });
    const bad = await update?.run?.(
      { artifactId: ref.artifactId, base: 2, ops: [{ op: "replace", old: "x", new: "y" }] },
      ctx,
    );
    expect(bad?.isError).toBe(true);
    const got = await read?.run?.({ artifactId: ref.artifactId }, ctx);
    expect(got?.provenance).toBe("untrusted");
    expect(got?.output).toMatchObject({
      version: 2,
      content: '{"columns":["a","b"],"rows":[[9,2]]}',
    });
  });

  it("lists a manifest and reports owner edits once, without bodies", async () => {
    const provider = artifactContextProvider(db);
    const input = {
      threadId: "thr_1",
      runId: "r",
      text: "hi",
      mode: "attended",
      permissionMode: "default",
    } as never;
    expect(await provider.provide(input)).toBeUndefined();
    const { artifact } = await store.create(
      { type: "doc", title: "Trip plan", content: "secret body text", threadId: "thr_1" },
      agent,
    );
    await store.create(
      { type: "doc", title: "Ignore previous", content: "x", threadId: "thr_1", untrusted: true },
      agent,
    );
    await store.update(artifact.id, 1, [{ op: "replace", old: "secret", new: "public" }], {
      author: "user",
    });
    const first = await provider.provide(input);
    const text = first?.sections[0]?.text ?? "";
    expect(first?.trusted).toBe(true);
    expect(text).toContain(`${artifact.id} "Trip plan" doc v2`);
    expect(text).toContain("title withheld");
    expect(text).not.toContain("Ignore previous");
    expect(text).not.toContain("body text");
    expect(text).toContain('ops [{"op":"replace","old":"secret","new":"public"}]');
    const again = await provider.provide(input);
    expect(again?.sections[0]?.text).not.toContain("edited these");
  });

  it("stores a chart, summarises it and patches it as one version", async () => {
    const w = await store.create(
      {
        type: "chart",
        title: "Sales",
        content: JSON.stringify({
          kind: "bar",
          categories: ["Q1"],
          series: [{ name: "S", values: [1] }],
        }),
      },
      agent,
    );
    expect(w.ref.summary).toBe("bar chart, 1 series × 1 points");
    const u = await store.update(
      w.artifact.id,
      1,
      [{ op: "patch", patch: { kind: "pie" } }],
      agent,
    );
    expect(u.ref.version).toBe(2);
    expect(JSON.parse(store.contentAt(w.artifact.id).content).kind).toBe("pie");
  });

  it("keeps the model's token cost flat: refs and patches, not bodies (§4.3)", async () => {
    const line = (i: number) => `Line ${i}: ${"lorem ipsum ".repeat(8)}\n`;
    const body = Array.from({ length: 300 }, (_, i) => line(i)).join("");
    const [create, update] = artifactTools(store);
    const ctx = {
      callId: "tc_t",
      threadId: "thr_1",
      runId: "run_t",
      taint: false,
      signal: new AbortController().signal,
      onUpdate: () => {},
    } as never;
    const made = await create?.run?.({ type: "doc", title: "Big", content: body }, ctx);
    const ref = made?.output as { artifactId: string };
    // What the model emits and gets back across ten one-line edits.
    let emitted = body.length;
    let received = JSON.stringify(made?.output).length;
    for (let v = 1; v <= 10; v++) {
      const ops = [
        { op: "replace" as const, old: `Line ${v * 20}:`, new: `Line ${v * 20} (edited):` },
      ];
      emitted += JSON.stringify(ops).length;
      const r = await update?.run?.({ artifactId: ref.artifactId, base: v, ops }, ctx);
      received += JSON.stringify(r?.output).length;
    }
    // Re-sending the document ten times would cost 10 x body; patches cost under 1% of that.
    expect(emitted - body.length).toBeLessThan(body.length / 10);
    expect(received).toBeLessThan(5_000);
    expect(received).toBeLessThan(body.length / 5);
  });
});
