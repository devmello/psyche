import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolRegistration, ToolRunContext } from "@psyche/agent-core";
import { openDb, type PsycheDb } from "@psyche/db";
import { fileTools } from "@psyche/files";
import { effectiveSideEffect, inferApprovalKind } from "@psyche/permissions";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DocumentsHandle, documentBridge } from "../src/artifacts/bridge.ts";
import {
  exportArtifact,
  htmlToMarkdown,
  importDocument,
  markdownToBlocks,
} from "../src/artifacts/documents.ts";
import { ArtifactStore } from "../src/artifacts/store.ts";
import { artifactTools } from "../src/compose/artifacts.ts";
import { fileChange } from "../src/compose/changes.ts";

let db: PsycheDb;
let home: string;
let store: ArtifactStore;
let tools: Map<string, AgentToolRegistration>;

const ctx = (over: Partial<ToolRunContext> = {}) =>
  ({
    signal: new AbortController().signal,
    taint: false,
    threadId: "thr_1",
    runId: "run_1",
    callId: "tc_1",
    ...over,
  }) as ToolRunContext;
// biome-ignore lint/suspicious/noExplicitAny: tool outputs are untyped JSON
type Out = any;
type Describe = (p: unknown, c: ToolRunContext) => { bindingFields: { contentSha256: string } };
const call = async (name: string, input: unknown) => {
  const t = tools.get(name) as AgentToolRegistration;
  return (await t.run?.(input as never, ctx())) as { output: Out; isError?: boolean };
};

beforeEach(() => {
  db = openDb(":memory:");
  home = mkdtempSync(join(tmpdir(), "psyche-docs-"));
  store = new ArtifactStore({ db, home });
  tools = new Map(artifactTools(store).map((t) => [t.spec.name, t]));
});
afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

const DECK = {
  theme: "light",
  slides: [
    { id: "t", layout: "title", title: "Q3 review", bullets: ["Team Atlas"] },
    {
      id: "r",
      layout: "bullets",
      title: "Results",
      bullets: ["Revenue up 12%", "Churn down"],
      notes: "Smile.",
    },
  ],
};
const BOOK = {
  sheets: [
    {
      name: "Sales",
      cells: {
        A1: "Region",
        B1: "Total",
        A2: "West",
        B2: 10,
        A3: "East",
        B3: 32,
        B4: { f: "SUM(B2:B3)" },
      },
    },
  ],
};
const MD =
  "# Report\n\nIntro with **bold**.\n\n## Findings\n\n- one\n- two\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n";

describe("agent tools: create, patch, read", () => {
  it("doc: patches a section, not the whole document", async () => {
    const made = await call("artifact.create", { type: "doc", title: "Report", content: MD });
    const id = made.output.artifactId;
    const res = await call("artifact.update", {
      artifactId: id,
      base: 1,
      ops: [{ op: "replaceSection", heading: "Findings", body: "Nothing found." }],
    });
    expect(res.output).toMatchObject({
      version: 2,
      summary: expect.stringContaining("replaceSection"),
    });
    const read = await call("artifact.read", { artifactId: id });
    expect(read.output.content).toContain("## Findings\n\nNothing found.");
    expect(read.output.content).toContain("Intro with **bold**");
  });

  it("slides: adds, updates and moves slides by id", async () => {
    const made = await call("artifact.create", {
      type: "slides",
      title: "Deck",
      content: JSON.stringify(DECK),
    });
    expect(made.output.summary).toBe("2 slides");
    const id = made.output.artifactId;
    await call("artifact.update", {
      artifactId: id,
      base: 1,
      ops: [
        { op: "updateSlide", id: "r", changes: { bullets: ["Revenue up 15%"] } },
        { op: "addSlide", slide: { id: "n", layout: "bullets", title: "Next", bullets: ["Ship"] } },
        { op: "moveSlide", id: "n", to: 1 },
      ],
    });
    const deck = JSON.parse((await call("artifact.read", { artifactId: id })).output.content);
    expect(deck.slides.map((s: { id: string }) => s.id)).toEqual(["t", "n", "r"]);
    expect(deck.slides[2].bullets).toEqual(["Revenue up 15%"]);
  });

  it("workbook: sets cells and formulas, reads computed values", async () => {
    const made = await call("artifact.create", {
      type: "workbook",
      title: "Sales",
      content: JSON.stringify(BOOK),
    });
    const id = made.output.artifactId;
    await call("artifact.update", {
      artifactId: id,
      base: 1,
      ops: [{ op: "setCells", sheet: "Sales", cells: { B3: 40, C4: { f: "B4 / 2" } } }],
    });
    const out = (await call("sheet.read", { artifactId: id, range: "A1:C4" })).output;
    expect(out.cells.B4).toEqual({ value: 50, formula: "=SUM(B2:B3)" });
    expect(out.cells.C4.value).toBe(25);
    expect((await call("sheet.read", { artifactId: id, sheet: "Nope" })).isError).toBe(true);
  });

  it("mirrors decks and workbooks to the Library under kind-specific names", async () => {
    const deck = await store.create(
      { type: "slides", title: "Q3 Deck", content: JSON.stringify(DECK) },
      { author: "agent" },
    );
    const book = await store.create(
      { type: "workbook", title: "Q3 Book", content: JSON.stringify(BOOK) },
      { author: "agent" },
    );
    const names = [deck, book].map(
      (w) =>
        (
          db.sqlite
            .prepare("SELECT name FROM library_items WHERE id = ?")
            .get(w.artifact.libraryItemId) as { name: string }
        ).name,
    );
    expect(names).toEqual(["q3-deck.deck.json", "q3-book.book.json"]);
  });

  it("an owner edit is a version the agent sees; a stale base conflicts instead of overwriting", async () => {
    const id = (await call("artifact.create", { type: "doc", title: "R", content: MD })).output
      .artifactId;
    await store.update(
      id,
      1,
      [{ op: "replaceSection", heading: "Findings", body: "Owner text." }],
      {
        author: "user",
      },
    );
    const stale = await call("artifact.update", {
      artifactId: id,
      base: 1,
      ops: [{ op: "removeSection", heading: "Findings" }],
    });
    expect(stale.output).toMatchObject({ conflict: true, latest: 2 });
    expect((await call("artifact.read", { artifactId: id })).output.content).toContain(
      "Owner text.",
    );
    const ok = await call("artifact.update", {
      artifactId: id,
      base: 2,
      ops: [{ op: "removeSection", heading: "Findings" }],
    });
    expect(ok.output.version).toBe(3);
    // history is kept and restorable
    const restored = await store.restore(id, 1, { author: "user" });
    expect(restored.artifact.version).toBe(4);
    expect(store.contentAt(id).content).toBe(MD);
  });
});

describe("export produces valid files", () => {
  it("doc → .docx, .pdf, .md parse back", async () => {
    const docx = await exportArtifact("doc", "Report", MD, "docx");
    const JSZip = await (await import("@psyche/viewers/core/libs")).loadJszip();
    const zip = await JSZip.loadAsync(docx.bytes);
    expect(await zip.file("word/document.xml")?.async("string")).toContain("Findings");
    const back = await importDocument("Report.docx", docx.bytes);
    expect(back.type).toBe("doc");
    expect(back.content).toMatch(/^# Report/m);
    expect(back.content).toContain("- one");
    const pdf = await exportArtifact("doc", "Report", MD, "pdf");
    expect(new TextDecoder().decode(pdf.bytes.slice(0, 5))).toBe("%PDF-");
    expect(new TextDecoder().decode((await exportArtifact("doc", "Report", MD, "md")).bytes)).toBe(
      MD,
    );
    await expect(exportArtifact("doc", "Report", MD, "xlsx")).rejects.toThrow(/exports as/);
  });

  it("workbook → .xlsx keeps formulas; .csv has computed values and neutralises formulas in text", async () => {
    const x = await exportArtifact("workbook", "Sales", JSON.stringify(BOOK), "xlsx");
    const back = await importDocument("Sales.xlsx", x.bytes);
    const wb = JSON.parse(back.content);
    expect(wb.sheets[0].cells).toMatchObject({
      A1: "Region",
      B2: 10,
      B3: 32,
      B4: { f: "SUM(B2:B3)" },
    });
    const evil = {
      sheets: [{ name: "S", cells: { A1: "h", A2: "=HYPERLINK(1)", B2: { f: "1+1" } } }],
    };
    const csv = new TextDecoder().decode(
      (await exportArtifact("workbook", "S", JSON.stringify(evil), "csv")).bytes,
    );
    expect(csv).toBe("h,\n'=HYPERLINK(1),2\n");
  });

  it("slides → .pptx and back; .pdf is a PDF", async () => {
    const p = await exportArtifact("slides", "Q3 review", JSON.stringify(DECK), "pptx");
    const back = JSON.parse((await importDocument("Q3.pptx", p.bytes)).content);
    const text = JSON.stringify(back);
    expect(text).toContain("Revenue up 12%");
    expect(text).toContain("Smile.");
    expect(back.slides.length).toBeGreaterThanOrEqual(2);
    const pdf = await exportArtifact("slides", "Q3", JSON.stringify(DECK), "pdf");
    expect(new TextDecoder().decode(pdf.bytes.slice(0, 5))).toBe("%PDF-");
  });
});

describe("markdown and html helpers", () => {
  it("maps Markdown to generator blocks", () => {
    expect(markdownToBlocks(MD).map((b) => b.type)).toEqual([
      "heading",
      "paragraph",
      "heading",
      "list",
      "table",
    ]);
  });
  it("turns mammoth HTML into Markdown", () => {
    expect(
      htmlToMarkdown("<h2>T</h2><p>a <strong>b</strong> &amp; c</p><ol><li>x</li><li>y</li></ol>"),
    ).toBe("## T\n\na **b** & c\n\n1. x\n2. y\n");
  });
});

describe("open_document and write_document", () => {
  let dir: string;
  let handle: DocumentsHandle;
  let changes: ReturnType<typeof fileChange>[];
  let ft: Map<string, AgentToolRegistration>;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "psyche-granted-")));
    handle = { store };
    changes = [];
    ft = new Map(
      fileTools({
        folders: () => [{ path: dir, mode: "rw" }],
        documents: documentBridge(handle),
        onChange: (c) => changes.push(fileChange(c)),
      }).map((t) => [t.spec.name, t]),
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("imports a granted .xlsx, edits it, and writes back behind an approval card with an audit record", async () => {
    const path = join(dir, "sales.xlsx");
    writeFileSync(
      path,
      (await exportArtifact("workbook", "Sales", JSON.stringify(BOOK), "xlsx")).bytes,
    );

    const opened = (await (ft.get("open_document") as AgentToolRegistration).run?.(
      { path } as never,
      ctx(),
    )) as { output: Out };
    expect(opened.output).toMatchObject({ type: "workbook", source: path });
    expect(store.get(opened.output.artifactId).artifact.untrusted).toBe(true);

    await store.update(
      opened.output.artifactId,
      1,
      [{ op: "setCells", sheet: "Sales", cells: { B2: 99 } }],
      {
        author: "agent",
      },
    );

    const write = ft.get("write_document") as AgentToolRegistration;
    const params = { path, artifactId: opened.output.artifactId };
    // The approval card: a file_write for this exact path, bound to this artifact version.
    const desc = (write.describeCall as Describe)(params, ctx());
    expect(desc).toMatchObject({
      kind: "file_write",
      target: { kind: "path", value: expect.stringContaining("sales.xlsx") },
    });
    expect(effectiveSideEffect("write_document", "none")).toBe("write");
    expect(inferApprovalKind("write_document")).toBe("file_write");
    const before = (write.describeCall as Describe)(params, ctx()).bindingFields.contentSha256;
    await store.update(
      opened.output.artifactId,
      2,
      [{ op: "setCells", sheet: "Sales", cells: { B2: 1 } }],
      {
        author: "user",
      },
    );
    expect((write.describeCall as Describe)(params, ctx()).bindingFields.contentSha256).not.toBe(
      before,
    );

    await write.run?.(params as never, ctx({ approvalId: "apr_1" } as never));
    const back = JSON.parse((await importDocument("sales.xlsx", readFileSync(path))).content);
    expect(back.sheets[0].cells.B2).toBe(1);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      category: "file",
      tool: "write_document",
      action: "overwrite",
      approvalId: "apr_1",
      target: { path },
    });
    expect(changes[0]?.before).toBeInstanceOf(Buffer);
  });

  it("refuses paths outside the granted folders and read-only grants", async () => {
    const outside = join(tmpdir(), "psyche-outside.docx");
    const id = (await store.create({ type: "doc", title: "D", content: MD }, { author: "agent" }))
      .artifact.id;
    await expect(
      (ft.get("write_document") as AgentToolRegistration).run?.(
        { path: outside, artifactId: id } as never,
        ctx(),
      ),
    ).rejects.toThrow();
    const ro = new Map(
      fileTools({
        folders: () => [{ path: dir, mode: "ro" }],
        documents: documentBridge(handle),
      }).map((t) => [t.spec.name, t]),
    );
    mkdirSync(dir, { recursive: true });
    await expect(
      (ro.get("write_document") as AgentToolRegistration).run?.(
        { path: join(dir, "x.docx"), artifactId: id } as never,
        ctx(),
      ),
    ).rejects.toThrow();
  });
});
