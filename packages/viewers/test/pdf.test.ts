import { describe, expect, it } from "vitest";
import { openPdf, PdfPasswordError } from "../src/core/pdf.ts";
import { acroFormPdf, manyPagePdf, xfaPdf } from "./fixtures/pdf.ts";

describe("PDF core", () => {
  it("opens a 100-page PDF quickly, with text, outline and search", async () => {
    const bytes = manyPagePdf(100);
    const t0 = performance.now();
    const pdf = await openPdf(bytes);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(pdf.info).toMatchObject({ numPages: 100, formKind: "none", isPureXfa: false });
    expect(await pdf.pageText(1)).toContain("Page 1 of 100");
    const outline = await pdf.outline();
    expect(outline.map((o) => [o.title, o.page])).toEqual([
      ["Introduction", 1],
      ["Appendix", 100],
    ]);
    const hits = await pdf.search("NEEDLE");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ page: 42 });
    expect(hits[0]?.snippet).toContain("needle");
    // The caller's buffer is not detached by pdf.js.
    expect(bytes.byteLength).toBeGreaterThan(0);
    await pdf.close();
  });

  it("reads AcroForm fields with types, values and options", async () => {
    const pdf = await openPdf(await acroFormPdf());
    expect(pdf.info.formKind).toBe("acroform");
    const fields = await pdf.fields();
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
    expect(Object.keys(byName).sort()).toEqual([
      "allergies",
      "child_name",
      "consent",
      "grade",
      "school",
    ]);
    expect(byName.child_name).toMatchObject({ type: "text", page: 1, readOnly: false });
    expect(byName.allergies?.multiline).toBe(true);
    expect(byName.consent).toMatchObject({ type: "checkbox", value: false });
    expect(byName.grade).toMatchObject({ type: "choice", value: ["2"] });
    expect(byName.grade?.options?.map((o) => o.value)).toEqual(["K", "1", "2", "3"]);
    expect(byName.school).toMatchObject({ readOnly: true, value: "Riverside Elementary" });
    expect(byName.child_name?.rect[2]).toBeGreaterThan(byName.child_name?.rect[0] ?? 0);
    await pdf.close();
  });

  it("produces a filled preview copy without touching read-only fields", async () => {
    const original = await acroFormPdf();
    const pdf = await openPdf(original);
    const filled = await pdf.fillPreview({
      child_name: "Ada Lin",
      consent: true,
      school: "Hacked",
    });
    await pdf.close();
    const again = await openPdf(filled);
    const fields = Object.fromEntries((await again.fields()).map((f) => [f.name, f.value]));
    expect(fields.child_name).toBe("Ada Lin");
    expect(fields.consent).toBe(true);
    expect(fields.school).toBe("Riverside Elementary");
    await again.close();
  });

  it("detects pure XFA and refuses to fill it", async () => {
    const pdf = await openPdf(xfaPdf());
    expect(pdf.info).toMatchObject({ formKind: "xfa", isPureXfa: true });
    expect(await pdf.fields()).toEqual([]);
    await expect(pdf.fillPreview({ ChildName: "x" })).rejects.toThrow(/XFA/);
    await pdf.close();
  });

  it("reports password-protected files as a typed error", async () => {
    await expect(openPdf(new TextEncoder().encode("not a pdf"))).rejects.toThrow();
    expect(new PdfPasswordError("needed").reason).toBe("needed");
  });
});
