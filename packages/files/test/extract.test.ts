import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolRegistration, ToolRunContext } from "@psyche/agent-core";
import type { ToolResult } from "@psyche/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXTRACT_LIMITS, extractDocument, UNIT_STRIDE } from "../src/extract/index.ts";
import { type DocumentSource, pageDocument } from "../src/extract/pager.ts";
import { inflateEntry, readZip } from "../src/extract/zip.ts";
import { fileTools } from "../src/index.ts";
import { makeDocx, makePdf, makeXlsx, makeZip, para, run } from "./fixtures.ts";

let root: string;
let dir: string;
let read: (params: unknown) => Promise<ToolResult & { output: Record<string, unknown> }>;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "psy-fx-")));
  dir = join(root, "granted");
  mkdirSync(dir);
  const tool = fileTools({ folders: () => [{ path: dir, mode: "ro" }] }).find(
    (t) => t.spec.name === "read_file",
  ) as AgentToolRegistration;
  const ctx = { signal: new AbortController().signal, taint: false } as ToolRunContext;
  read = (params) =>
    tool.run?.(params, ctx) as Promise<ToolResult & { output: Record<string, unknown> }>;
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const put = (name: string, data: Uint8Array | string) => {
  const path = join(dir, name);
  writeFileSync(path, data);
  return path;
};

describe("read_file: PDF", () => {
  it("returns each page's text under a page reference, untrusted", async () => {
    const path = put("three.pdf", makePdf([["Hello (world)"], ["Second page", "two lines"], []]));
    const r = await read({ path });
    expect(r.provenance).toBe("untrusted");
    expect(r.output).toMatchObject({
      format: "pdf",
      unit: "page",
      total: 3,
      from: 1,
      to: 3,
      truncated: false,
    });
    expect(r.output.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.output.nextOffset).toBeUndefined();
    const text = r.output.text as string;
    expect(text).toMatch(/^\[page 1\]\nHello \(world\)/);
    expect(text).toMatch(/\[page 2\]\nSecond page\s+two lines/);
    expect(text).toContain("[page 3]");
    expect(r.output.warnings).toEqual([expect.stringContaining("No text layer on page 3")]);
  });

  it("reads a 20 MB PDF as bounded text with page references, paged by nextOffset", async () => {
    const pages = Array.from({ length: 300 }, (_, i) =>
      Array.from(
        { length: 6 },
        (_, l) => `Page ${i + 1} line ${l + 1} ${"lorem ipsum ".repeat(4)}`,
      ),
    );
    const path = put("big.pdf", makePdf(pages, 20 * 1024 * 1024));
    const first = await read({ path });
    const text = first.output.text as string;
    expect(first.output.bytes as number).toBeGreaterThan(20 * 1024 * 1024);
    expect(text.length).toBeLessThanOrEqual(EXTRACT_LIMITS.chars);
    expect(text.startsWith("[page 1]\nPage 1 line 1")).toBe(true);
    expect(first.output).toMatchObject({ total: 300, from: 1, truncated: true });
    const to = first.output.to as number;
    // Pages stay whole: the next call starts at the next page.
    expect(first.output.nextOffset).toBe(to * UNIT_STRIDE);
    const second = await read({ path, offset: first.output.nextOffset });
    expect(second.output.from).toBe(to + 1);
    expect(
      (second.output.text as string).startsWith(`[page ${to + 1}]\nPage ${to + 1} line 1`),
    ).toBe(true);
    const jump = await read({ path, page: 300 });
    expect(jump.output).toMatchObject({ from: 300, to: 300, truncated: false });
    expect(jump.output.text).toMatch(/^\[page 300\]\nPage 300 line 1/);
  }, 60_000);

  it("refuses a file that claims to be a PDF but is not readable", async () => {
    const path = put("broken.pdf", "%PDF-1.7\nthis is not a PDF body");
    await expect(read({ path })).rejects.toMatchObject({ code: "invalid_params" });
  });
});

describe("read_file: DOCX", () => {
  it("splits pages at Word's rendered page breaks and decodes entities", async () => {
    const path = put(
      "memo.docx",
      makeDocx(
        para(run("Dear Ana &amp; team,"), "<w:r><w:tab/></w:r>", run("hi")) +
          para(run("Body")) +
          para("<w:r><w:lastRenderedPageBreak/><w:t>Page two</w:t></w:r>") +
          para(run("&#169; 2026")),
      ),
    );
    const r = await read({ path });
    expect(r.provenance).toBe("untrusted");
    expect(r.output).toMatchObject({ format: "docx", unit: "page", total: 2, from: 1, to: 2 });
    expect(r.output.text).toBe(
      "[page 1]\nDear Ana & team,\thi\nBody\n\n[page 2]\nPage two\n© 2026",
    );
  });

  it("uses explicit page breaks when Word recorded no layout, and says when there are none", async () => {
    const broken = put(
      "breaks.docx",
      makeDocx(para(run("one")) + para('<w:r><w:br w:type="page"/></w:r>', run("two"))),
    );
    expect((await read({ path: broken })).output.text).toBe("[page 1]\none\n\n[page 2]\ntwo");
    const flat = put("flat.docx", makeDocx(para(run("only"))));
    const r = await read({ path: flat });
    expect(r.output).toMatchObject({ total: 1, text: "[page 1]\nonly" });
    expect(r.output.warnings).toEqual([expect.stringContaining("no page breaks")]);
  });
});

describe("read_file: XLSX", () => {
  it("returns each sheet's rows under a sheet reference", async () => {
    const path = put("budget.xlsx", makeXlsx());
    const r = await read({ path });
    expect(r.provenance).toBe("untrusted");
    expect(r.output).toMatchObject({ format: "xlsx", unit: "sheet", total: 2, from: 1, to: 2 });
    expect(r.output.text).toBe(
      [
        "[sheet Budget]",
        "1: Item | Cost |  | Due",
        "2: Rent | 1200 | TRUE | 2026-01-15",
        "5:  | a <b>",
        "",
        "[sheet Notes & ideas]",
        "1: line one line two",
      ].join("\n"),
    );
    const second = await read({ path, page: 2 });
    expect(second.output).toMatchObject({
      from: 2,
      to: 2,
      text: "[sheet Notes & ideas]\n1: line one line two",
    });
  });
});

describe("read_file: detection", () => {
  it("extracts only when the extension and the magic bytes agree", async () => {
    const fake = await read({ path: put("notes.pdf", "plain text, not a PDF") });
    expect(fake.output.format).toBeUndefined();
    expect(fake.output.text).toBe("plain text, not a PDF");
    const renamed = await read({ path: put("doc.bin", makeDocx(para(run("x")))) });
    expect(renamed.output.format).toBeUndefined();
  });

  it("rejects page on text files and page with offset", async () => {
    const txt = put("a.txt", "hi");
    await expect(read({ path: txt, page: 1 })).rejects.toMatchObject({ code: "invalid_params" });
    const pdf = put("one.pdf", makePdf([["x"]]));
    await expect(read({ path: pdf, page: 1, offset: 0 })).rejects.toMatchObject({
      code: "invalid_params",
    });
  });
});

describe("extraction bounds", () => {
  it("stops a ZIP part at the inflate cap whatever its header claims", () => {
    const zip = makeZip({ "word/document.xml": "a".repeat(100_000) }, { "word/document.xml": 10 });
    const entry = readZip(zip).get("word/document.xml");
    if (entry === undefined) throw new Error("entry missing");
    expect(() => inflateEntry(zip, entry, 1000)).toThrow(/expands beyond 1000 bytes/);
    expect(inflateEntry(zip, entry, 200_000).byteLength).toBe(100_000);
  });

  it("terminates the worker at the deadline", async () => {
    await expect(
      extractDocument("pdf", makePdf([["x"]]), { offset: 0, timeoutMs: 1 }),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("cuts a unit larger than the budget and continues it", async () => {
    const src: DocumentSource = {
      unit: "page",
      count: 2,
      label: (i) => `page ${i + 1}`,
      text: (i) => (i === 0 ? `${"a".repeat(600)}\n${"b".repeat(600)}` : "short"),
      warnings: () => [],
    };
    const first = await pageDocument("pdf", src, 0, 1000);
    expect(first.text).toBe(`[page 1]\n${"a".repeat(600)}\n`);
    expect(first.nextOffset).toBe(601);
    const second = await pageDocument("pdf", src, 601, 1000);
    expect(second.text).toBe(`[page 1 cont.]\n${"b".repeat(600)}\n\n[page 2]\nshort`);
    expect(second).toMatchObject({ from: 1, to: 2 });
    expect(second.nextOffset).toBeUndefined();
  });
});
