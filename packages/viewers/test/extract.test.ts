import { describe, expect, it } from "vitest";
import {
  ExtractError,
  type ExtractInput,
  type ExtractResult,
  extractText,
} from "../src/core/extract.ts";
import { budgetMs } from "./fixtures/budget.ts";
import { MALICIOUS_EML } from "./fixtures/email.ts";
import { sampleDocx, samplePptx } from "./fixtures/office.ts";
import { manyPagePdf, rawPdf, xfaPdf } from "./fixtures/pdf.ts";
import { bigCsv } from "./fixtures/sheets.ts";

const enc = (s: string) => new TextEncoder().encode(s);

async function all(input: ExtractInput, maxChars: number): Promise<ExtractResult[]> {
  const out: ExtractResult[] = [];
  let cursor: string | undefined;
  do {
    const r = await extractText(input, { maxChars, ...(cursor === undefined ? {} : { cursor }) });
    out.push(r);
    cursor = r.nextCursor;
  } while (cursor !== undefined && out.length < 500);
  return out;
}

describe("extractText", () => {
  it("returns bounded text with page refs from a 20 MB PDF", async () => {
    const bytes = manyPagePdf(300, 20 * 1024 * 1024);
    expect(bytes.byteLength).toBeGreaterThan(20 * 1024 * 1024);
    const t0 = performance.now();
    const r = await extractText({ bytes, name: "big.pdf" }, { maxChars: 2000 });
    expect(performance.now() - t0).toBeLessThan(budgetMs(5000));
    expect(r.kind).toBe("pdf");
    expect(r.text.length).toBeLessThanOrEqual(2000);
    expect(r.total).toEqual({ unit: "page", count: 300 });
    expect(r.refs[0]).toMatchObject({ ref: "p.1", start: 0 });
    expect(r.text.slice(r.refs[1]?.start, r.refs[1]?.end)).toContain("Page 2 of 300");
    expect(r.nextCursor).toBeDefined();
    expect(r.provenance).toBe("untrusted");
  });

  it("pages through a whole PDF exactly once", async () => {
    const chunks = await all({ bytes: manyPagePdf(30), name: "a.pdf" }, 600);
    const pages = chunks.flatMap((c) => c.refs.map((r) => r.ref));
    expect(new Set(pages).size).toBe(30);
    expect(chunks.at(-1)?.nextCursor).toBeUndefined();
    expect(chunks.every((c) => c.text.length <= 600)).toBe(true);
    const joined = chunks.map((c) => c.text).join("\n");
    for (let p = 1; p <= 30; p++) expect(joined).toContain(`Page ${p} of 30`);
  });

  it("warns on pure XFA forms", async () => {
    const r = await extractText({ bytes: xfaPdf(), name: "xfa.pdf" });
    expect(r.warnings.join(" ")).toMatch(/XFA/);
  });

  it("uses OCR for pages without a text layer, and says so when OCR is missing", async () => {
    const scanned = rawPdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    ]);
    const calls: { mime: string; page?: number }[] = [];
    const r = await extractText(
      { bytes: scanned, name: "scan.pdf" },
      {
        ocr: {
          recognize: async (i) => {
            calls.push({ mime: i.mime, ...(i.page === undefined ? {} : { page: i.page }) });
            return { text: "OCR TEXT" };
          },
        },
      },
    );
    expect(calls).toEqual([{ mime: "application/pdf", page: 1 }]);
    expect(r.text).toContain("OCR TEXT");
    const none = await extractText({ bytes: scanned, name: "scan.pdf" });
    expect(none.warnings.join(" ")).toMatch(/no text layer/);
  });

  it("gives sheet rows cell references and pages by row", async () => {
    const input = { bytes: enc(bigCsv(2000)), name: "tx.csv" };
    const first = await extractText(input, { maxChars: 4000 });
    expect(first.kind).toBe("sheet");
    expect(first.total).toEqual({ unit: "row", count: 2000 });
    expect(first.text).toContain("columns: A=id, B=date, C=merchant");
    const row = first.refs.find((r) => r.ref === "tx!A2:F2");
    expect(row).toBeDefined();
    expect(first.text.slice(row?.start, row?.end)).toMatch(/^2: 1 \| 2026-02-15 \| Store 1, Inc\./);
    const chunks = await all(input, 20_000);
    const rows = chunks.flatMap((c) => c.refs.filter((r) => r.ref.includes("!A")));
    expect(rows).toHaveLength(2000);
  });

  it("extracts DOCX, PPTX (numeric slide order) and email text", async () => {
    const docx = await extractText({ bytes: await sampleDocx(), name: "r.docx" });
    expect(docx.kind).toBe("docx");
    expect(docx.text).toContain("Quarterly report");
    const pptx = await extractText({ bytes: await samplePptx(), name: "d.pptx" });
    expect(pptx.refs.map((r) => r.ref)).toEqual(["slide 1", "slide 2", "slide 10"]);
    expect(pptx.text).toContain("Revenue & growth");
    const mail = await extractText({ bytes: enc(MALICIOUS_EML), name: "m.eml" });
    expect(mail.kind).toBe("email");
    expect(mail.text).toContain("Subject: Your invoice");
    expect(mail.text).not.toMatch(/<script|onload=/i);
  });

  it("pages plain text by characters without splitting surrogate pairs", async () => {
    const text = `${"a".repeat(499)}😀${"b".repeat(600)}`;
    const r1 = await extractText({ bytes: enc(text), name: "n.txt" }, { maxChars: 500 });
    expect(r1.text).toBe("a".repeat(499));
    const r2 = await extractText(
      { bytes: enc(text), name: "n.txt" },
      { maxChars: 500, ...(r1.nextCursor ? { cursor: r1.nextCursor } : {}) },
    );
    expect(r2.text.startsWith("😀")).toBe(true);
  });

  it("handles images, unknown types and bad cursors", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0]);
    expect((await extractText({ bytes: png, name: "a.png" })).warnings[0]).toMatch(/OCR/);
    const ocr = await extractText(
      { bytes: png, name: "a.png" },
      { ocr: { recognize: async () => ({ text: "hello" }) } },
    );
    expect(ocr.text).toBe("hello");
    expect((await extractText({ bytes: new Uint8Array([0, 1, 2]), name: "a.bin" })).kind).toBe(
      "unsupported",
    );
    await expect(
      extractText({ bytes: enc("x"), name: "a.txt" }, { cursor: "pdf.1.0" }),
    ).rejects.toThrow(ExtractError);
    await expect(
      extractText({ bytes: enc("x"), name: "a.txt" }, { cursor: "../etc" }),
    ).rejects.toThrow(ExtractError);
  });
});

describe("extractText paging edge cases (review)", () => {
  it("makes progress when one CSV row exceeds the budget", async () => {
    const csv = `a,b\n${"x".repeat(3000)},1\nsmall,2\n`;
    const chunks = await all({ bytes: enc(csv), name: "wide.csv" }, 600);
    expect(chunks.length).toBeLessThan(10);
    expect(chunks.at(-1)?.nextCursor).toBeUndefined();
    expect(chunks.map((c) => c.text).join("\n")).toContain("small | 2");
    expect(chunks.some((c) => c.warnings.some((w) => /truncated/.test(w)))).toBe(true);
  });

  it("continues a long slide instead of dropping its tail", async () => {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(await samplePptx());
    const long = `${"word ".repeat(400)}TAIL-MARKER`;
    zip.file(
      "ppt/slides/slide2.xml",
      `<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>${long}</a:t></a:r></a:p></p:sld>`,
    );
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const chunks = await all({ bytes, name: "d.pptx" }, 600);
    const text = chunks.map((c) => c.text).join("");
    expect(text).toContain("TAIL-MARKER");
    expect(text).toContain("Appendix");
  });
});
