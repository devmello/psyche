import { describe, expect, it } from "vitest";
import {
  detectFormFields,
  FormFillError,
  fillPdfForm,
  fillReceipt,
  finalizeFilledCopy,
  humanizeFieldName,
  prepareFilledCopy,
} from "../src/core/forms.ts";
import { openPdf } from "../src/core/pdf.ts";
import { fakeOcr, permissionSlipPdf, scannedFormPdf } from "./fixtures/forms.ts";
import { acroFormPdf, xfaPdf } from "./fixtures/pdf.ts";

async function valuesOf(bytes: Uint8Array): Promise<Record<string, unknown>> {
  const pdf = await openPdf(bytes);
  const out: Record<string, unknown> = {};
  for (const f of await pdf.fields()) if (f.value !== null) out[f.name] ??= f.value;
  await pdf.close();
  return out;
}

describe("form detection", () => {
  it("lists fillable fields with labels, options and radio groups merged", async () => {
    const d = await detectFormFields(await permissionSlipPdf());
    expect(d.kind).toBe("acroform");
    expect(d.fillable).toBe(true);
    expect(d.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    const byName = Object.fromEntries(d.fields.map((f) => [f.name, f]));
    expect(Object.keys(byName).sort()).toEqual(["consent", "days", "lunch", "parent_name", "zip"]);
    expect(byName.parent_name).toMatchObject({ label: "Parent or guardian name", required: true });
    expect(byName.zip).toMatchObject({ label: "Zip", maxLen: 5, type: "text" });
    expect(byName.lunch).toMatchObject({ type: "radio", options: ["Packed", "School"] });
    expect(byName.days).toMatchObject({ type: "list", options: ["Mon", "Tue", "Wed"] });
    expect(d.unsupported.map((u) => [u.name, u.reason]).sort()).toEqual([
      ["school", "read_only"],
      ["sign_here", "button"],
    ]);
  });

  it("flags pure XFA and hybrid forms", async () => {
    const xfa = await detectFormFields(xfaPdf());
    expect(xfa).toMatchObject({ kind: "xfa", fillable: false });
    expect(xfa.warnings.join()).toMatch(/XFA/);
    const hybrid = await detectFormFields(await permissionSlipPdf({ xfa: true }));
    expect(hybrid.kind).toBe("hybrid");
    expect(hybrid.fillable).toBe(true);
  });

  it("falls back to OCR overlay fields for scanned forms", async () => {
    const bytes = await scannedFormPdf();
    const none = await detectFormFields(bytes);
    expect(none).toMatchObject({ kind: "scanned", fillable: false, fields: [] });
    const ocr = fakeOcr();
    const d = await detectFormFields(bytes, { ocr });
    expect(ocr.calls).toBe(1);
    expect(d.fields.map((f) => [f.name, f.label, f.source])).toEqual([
      ["ocr:p1:student_name", "Student name", "ocr"],
      ["ocr:p1:date", "Date", "ocr"],
    ]);
    const [x1, y1, x2, y2] = d.fields[0]?.rect ?? [0, 0, 0, 0];
    expect(x2).toBeGreaterThan(x1);
    expect(y2).toBeGreaterThan(y1);
    expect(y2).toBeCloseTo(792 - 0.1 * 792, 0);
  });

  it("humanises field names", () => {
    expect(humanizeFieldName("form1[0].ChildName[0]")).toBe("Child name");
    expect(humanizeFieldName("parent_phone-number")).toBe("Parent phone number");
  });
});

describe("fill, review, flatten, receipt", () => {
  it("fills every field kind and reports what it could not fill", async () => {
    const res = await fillPdfForm(await permissionSlipPdf(), {
      parent_name: "Grace Hopper",
      zip: "940431",
      lunch: "school",
      days: ["Mon", "Wed"],
      consent: "yes",
      school: "Other",
      sign_here: "x",
      nope: "x",
      parent_name_2: true,
    });
    expect(res.applied).toEqual(["parent_name", "lunch", "days", "consent"]);
    expect(res.skipped).toEqual([
      { name: "zip", reason: "too_long" },
      { name: "school", reason: "read_only" },
      { name: "sign_here", reason: "not_fillable" },
      { name: "nope", reason: "unknown_field" },
      { name: "parent_name_2", reason: "unknown_field" },
    ]);
    const v = await valuesOf(res.bytes);
    expect(v).toMatchObject({
      parent_name: "Grace Hopper",
      lunch: "School",
      days: ["Mon", "Wed"],
      consent: true,
      school: "Riverside Elementary",
    });
  });

  it("rejects values outside options, wrong types and non-encodable text", async () => {
    const res = await fillPdfForm(await acroFormPdf(), {
      grade: "7",
      consent: "maybe",
      child_name: ["a"],
      allergies: "Peanuts 🥜",
    });
    expect(res.applied).toEqual([]);
    expect(res.skipped.map((s) => s.reason)).toEqual([
      "not_an_option",
      "wrong_type",
      "wrong_type",
      "unsupported_characters",
    ]);
  });

  it("refuses pure XFA and drops XFA from hybrids", async () => {
    await expect(fillPdfForm(xfaPdf(), {})).rejects.toMatchObject({ code: "xfa" });
    const res = await fillPdfForm(await permissionSlipPdf({ xfa: true }), { zip: "94043" });
    const pdf = await openPdf(res.bytes);
    expect(pdf.info.formKind).toBe("acroform");
    await pdf.close();
  });

  it("runs the permission-slip pipeline end to end", async () => {
    const source = { name: "Permission slip.pdf", bytes: await permissionSlipPdf() };
    const detection = await detectFormFields(source.bytes);
    const copy = await prepareFilledCopy(source, detection, {
      zip: "94043",
      consent: true,
      lunch: "Packed",
    });
    expect(copy.name).toBe("Permission slip (filled).pdf");
    expect(copy.missingRequired).toEqual(["parent_name"]);
    expect(copy.review).toEqual([
      { name: "zip", label: "Zip", page: 1, display: "94043" },
      { name: "consent", label: "Consent", page: 1, display: "☑" },
      { name: "lunch", label: "Lunch", page: 1, display: "Packed" },
    ]);
    // The reviewed copy is still a form (editable) until send.
    expect((await detectFormFields(copy.bytes)).fields.length).toBeGreaterThan(0);

    // A copy that changed after review is refused.
    const tampered = copy.bytes.slice();
    const at = tampered.length - 2;
    tampered[at] = (tampered[at] ?? 0) ^ 1;
    await expect(
      finalizeFilledCopy({ name: copy.name, bytes: tampered }, copy.sha256),
    ).rejects.toBeInstanceOf(FormFillError);

    const final = await finalizeFilledCopy(copy, copy.sha256);
    expect(final.reviewedSha256).toBe(copy.sha256);
    expect(final.sha256).not.toBe(copy.sha256);
    const flat = await openPdf(final.bytes);
    expect(flat.info.formKind).toBe("none");
    expect(await flat.fields()).toEqual([]);
    expect(await flat.pageText(1)).toContain("94043");
    await flat.close();

    const receipt = fillReceipt({
      sourceName: source.name,
      copy,
      final,
      approvalId: "appr_1",
    });
    expect(receipt).toMatchObject({
      kind: "file_write",
      outcome: "ok",
      approvalId: "appr_1",
      externalRefs: {
        sourceSha256: detection.sha256,
        reviewedSha256: copy.sha256,
        sentSha256: final.sha256,
      },
      payload: { action: "document.fill", fields: ["zip", "consent", "lunch"], flattened: true },
    });
    // Field values never land in the receipt.
    expect(JSON.stringify(receipt)).not.toContain("94043");
  });

  it("draws OCR overlay values onto scanned forms", async () => {
    const bytes = await scannedFormPdf();
    const detection = await detectFormFields(bytes, { ocr: fakeOcr() });
    const copy = await prepareFilledCopy({ name: "scan.pdf", bytes }, detection, {
      "ocr:p1:student_name": "Ada Lovelace",
      "ocr:p1:date": "2026-10-19",
    });
    expect(copy.applied).toEqual(["ocr:p1:student_name", "ocr:p1:date"]);
    const pdf = await openPdf(copy.bytes);
    const text = await pdf.pageText(1);
    expect(text).toContain("Ada Lovelace");
    expect(text).toContain("2026-10-19");
    await pdf.close();
  });
});
