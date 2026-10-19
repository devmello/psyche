import {
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  type PDFField,
  type PDFFont,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
  rgb,
  StandardFonts,
} from "@cantoo/pdf-lib";
import { Encodings } from "@cantoo/pdf-lib/standard-fonts";
import type { ReceiptInput } from "@psyche/protocol";
import type { OcrLine, OcrProvider } from "./extract.ts";
import { sha256 } from "./hash.ts";
import { openPdf, type PdfFieldType, type PdfFormField, type PdfFormKind } from "./pdf.ts";

/**
 * Documents pipeline building blocks (P2). Pure functions over bytes; the task engine (S04)
 * orchestrates them with `ask_user`, the mail connector (S09) and approvals:
 *
 *   detectFormFields(pdf)          → fields to ask for (or "scanned" + OCR overlay fields)
 *   prepareFilledCopy(pdf, values) → filled, still-editable copy + review rows + its sha256
 *   (the user reviews the copy; the reply draft's approval binds to `filled.sha256`)
 *   finalizeFilledCopy(copy, sha)  → re-verifies the hash, flattens, returns the bytes to send
 *   fillReceipt(...)               → ReceiptInput for PermissionBroker.recordReceipt
 *
 * Field values never enter the receipt (they can be personal data); names and hashes do.
 */

export type FormValue = string | boolean | string[];
export type FormValues = Record<string, FormValue>;

export type FormFieldKind = Exclude<PdfFieldType, "choice"> | "dropdown" | "list" | "overlay";

export interface FormFieldSpec {
  name: string;
  /** Human label: the field tooltip, the OCR label, or the humanised name. */
  label: string;
  type: FormFieldKind;
  /** 1-based page. */
  page: number;
  /** PDF user-space rectangle [x1, y1, x2, y2]. */
  rect: [number, number, number, number];
  required: boolean;
  multiline?: boolean;
  maxLen?: number;
  /** Allowed values for radios, dropdowns and lists. */
  options?: string[];
  /** Current value in the source document. */
  value: FormValue | null;
  source: "acroform" | "ocr";
}

export interface UnsupportedField {
  name: string;
  type: PdfFieldType;
  reason: "read_only" | "signature" | "button";
}

export interface FormDetection {
  /** `scanned` = no form and no text layer: only OCR overlay fields can be filled. */
  kind: PdfFormKind | "scanned";
  /** True when `fields` has anything the pipeline can fill. */
  fillable: boolean;
  fields: FormFieldSpec[];
  unsupported: UnsupportedField[];
  numPages: number;
  sha256: string;
  warnings: string[];
}

export interface DetectOptions {
  password?: string;
  /** Called for scanned forms (no AcroForm, no text layer) to find label lines. */
  ocr?: OcrProvider;
  /** Pages to OCR at most. Default 5. */
  maxOcrPages?: number;
  signal?: AbortSignal;
}

export type FormFillErrorCode = "xfa" | "encrypted" | "binding_mismatch" | "invalid_pdf";

export class FormFillError extends Error {
  readonly code: FormFillErrorCode;
  constructor(code: FormFillErrorCode, message: string) {
    super(message);
    this.name = "FormFillError";
    this.code = code;
  }
}

/** "child_name" / "ChildName" / "form1[0].Child_Name[0]" → "Child name". */
export function humanizeFieldName(name: string): string {
  const leaf = (name.split(".").pop() ?? name).replace(/\[\d+\]$/, "");
  const words = leaf
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-\s]+/g, " ")
    .trim()
    .toLowerCase();
  return words === "" ? name : words[0]?.toUpperCase() + words.slice(1);
}

/** A scanned page has (almost) no extractable text. */
const SCANNED_TEXT_CHARS = 16;
/** "Name: ____", "Parent signature ......", "Date:" */
const LABEL_LINE = /^(.{2,60}?)\s*(?::|_{3,}|\.{4,})[\s_.]*$/;

async function detectOverlayFields(
  pdfBytes: Uint8Array,
  pages: { page: number; width: number; height: number }[],
  ocr: OcrProvider,
  signal: AbortSignal | undefined,
): Promise<FormFieldSpec[]> {
  const out: FormFieldSpec[] = [];
  const used = new Set<string>();
  for (const p of pages) {
    signal?.throwIfAborted();
    const res = await ocr.recognize(
      { bytes: pdfBytes, mime: "application/pdf", page: p.page },
      signal === undefined ? undefined : { signal },
    );
    for (const line of res.lines ?? []) {
      const field = overlayFromLine(line, p);
      if (field === undefined) continue;
      let name = field.name;
      for (let i = 2; used.has(name); i++) name = `${field.name}_${i}`;
      used.add(name);
      out.push({ ...field, name });
    }
  }
  return out;
}

function overlayFromLine(
  line: OcrLine,
  p: { page: number; width: number; height: number },
): FormFieldSpec | undefined {
  const m = LABEL_LINE.exec(line.text.trim());
  const label = m?.[1]?.trim();
  if (label === undefined || label === "") return undefined;
  const { x, y, width, height } = line.bbox;
  // Value goes right of the label text (estimated from its share of the line) up to the margin.
  const labelEnd = x + width * Math.min(1, (label.length + 1) / Math.max(1, line.text.length));
  const x1 = labelEnd * p.width + 4;
  const x2 = Math.max(x1 + 144, Math.min(p.width - 36, (x + width) * p.width));
  const top = p.height - y * p.height;
  const bottom = top - Math.max(10, height * p.height);
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  return {
    name: `ocr:p${p.page}:${slug || "field"}`,
    label,
    type: "overlay",
    page: p.page,
    rect: [x1, bottom, x2, top],
    required: false,
    value: null,
    source: "ocr",
  };
}

function toSpec(f: PdfFormField): FormFieldSpec {
  const spec: FormFieldSpec = {
    name: f.name,
    label: f.label ?? humanizeFieldName(f.name),
    type: f.type === "choice" ? (f.listBox === true ? "list" : "dropdown") : f.type,
    page: f.page,
    rect: f.rect,
    required: f.required,
    value: f.value,
    source: "acroform",
  };
  if (f.multiline === true && f.type === "text") spec.multiline = true;
  if (f.maxLen !== undefined) spec.maxLen = f.maxLen;
  if (f.options !== undefined) spec.options = f.options.map((o) => o.value);
  return spec;
}

/**
 * Finds what can be filled: AcroForm fields (radio widgets merged into one group), XFA status,
 * and, for scanned forms with an OCR provider, overlay fields placed right of label lines.
 */
export async function detectFormFields(
  bytes: Uint8Array,
  opts: DetectOptions = {},
): Promise<FormDetection> {
  const pdf = await openPdf(bytes, opts.password === undefined ? {} : { password: opts.password });
  try {
    const warnings: string[] = [];
    const fields: FormFieldSpec[] = [];
    const unsupported: UnsupportedField[] = [];
    const radios = new Map<string, FormFieldSpec>();
    for (const f of await pdf.fields()) {
      if (f.type === "signature" || f.type === "button") {
        unsupported.push({ name: f.name, type: f.type, reason: f.type });
        continue;
      }
      if (f.readOnly) {
        if (!unsupported.some((u) => u.name === f.name))
          unsupported.push({ name: f.name, type: f.type, reason: "read_only" });
        continue;
      }
      if (f.type === "radio") {
        const group = radios.get(f.name);
        if (group !== undefined) {
          if (f.exportValue !== undefined) group.options?.push(f.exportValue);
          continue;
        }
        const spec = toSpec(f);
        spec.options = f.exportValue === undefined ? [] : [f.exportValue];
        radios.set(f.name, spec);
        fields.push(spec);
        continue;
      }
      fields.push(toSpec(f));
    }
    let kind: FormDetection["kind"] = pdf.info.formKind;
    if (kind === "xfa")
      warnings.push("Pure XFA form: it cannot be filled here; ask for an AcroForm or print copy.");
    if (kind === "hybrid") warnings.push("XFA data is dropped on fill; the AcroForm is used.");
    if (kind === "none") {
      const pages: { page: number; width: number; height: number }[] = [];
      let textChars = 0;
      const maxPages = Math.min(pdf.info.numPages, opts.maxOcrPages ?? 5);
      for (let n = 1; n <= maxPages; n++) {
        textChars += (await pdf.pageText(n)).replace(/\s+/g, "").length;
        const [x0 = 0, y0 = 0, x1 = 612, y1 = 792] = (await pdf.doc.getPage(n)).view;
        pages.push({ page: n, width: x1 - x0, height: y1 - y0 });
      }
      if (textChars < SCANNED_TEXT_CHARS * pages.length) {
        kind = "scanned";
        if (opts.ocr === undefined) warnings.push("Scanned form and no OCR provider configured.");
        else fields.push(...(await detectOverlayFields(bytes, pages, opts.ocr, opts.signal)));
      }
    }
    return {
      kind,
      fillable: fields.length > 0,
      fields,
      unsupported,
      numPages: pdf.info.numPages,
      sha256: await sha256(bytes),
      warnings,
    };
  } finally {
    await pdf.close();
  }
}

export interface FillOptions {
  /** Flatten after filling (the copy that is sent). Default false (the reviewable copy). */
  flatten?: boolean;
  /** Overlay fields from a scanned-form detection; values keyed by their `name`. */
  overlays?: FormFieldSpec[];
}

export interface SkippedValue {
  name: string;
  reason:
    | "unknown_field"
    | "read_only"
    | "not_fillable"
    | "wrong_type"
    | "not_an_option"
    | "too_long"
    | "unsupported_characters";
}

export interface FillResult {
  bytes: Uint8Array;
  sha256: string;
  applied: string[];
  skipped: SkippedValue[];
  flattened: boolean;
}

const TRUE_WORDS = new Set(["true", "yes", "y", "on", "x", "checked", "1"]);
const FALSE_WORDS = new Set(["false", "no", "n", "off", "", "unchecked", "0"]);

function asBoolean(v: FormValue): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v !== "string") return undefined;
  const w = v.trim().toLowerCase();
  return TRUE_WORDS.has(w) ? true : FALSE_WORDS.has(w) ? false : undefined;
}

/** Helvetica (WinAnsi) can draw it; pdf-lib would otherwise substitute a placeholder glyph. */
function encodable(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 10 || cp === 13) continue;
    if (!Encodings.WinAnsi.canEncodeUnicodeCodePoint(cp)) return false;
  }
  return true;
}

/** Case-insensitive match against a field's options; returns the option's own spelling. */
function pickOption(options: string[], v: string): string | undefined {
  return options.find((o) => o === v) ?? options.find((o) => o.toLowerCase() === v.toLowerCase());
}

function applyValue(field: PDFField, v: FormValue): SkippedValue["reason"] | undefined {
  if (field.isReadOnly()) return "read_only";
  if (field instanceof PDFTextField) {
    if (typeof v !== "string") return "wrong_type";
    const text = field.isMultiline() ? v : v.replace(/\s*[\r\n]+\s*/g, " ");
    const max = field.getMaxLength();
    if (max !== undefined && text.length > max) return "too_long";
    if (!encodable(text)) return "unsupported_characters";
    field.setText(text);
    return undefined;
  }
  if (field instanceof PDFCheckBox) {
    const b = asBoolean(v);
    if (b === undefined) return "wrong_type";
    if (b) field.check();
    else field.uncheck();
    return undefined;
  }
  if (field instanceof PDFRadioGroup) {
    if (typeof v !== "string") return "wrong_type";
    const opt = pickOption(field.getOptions(), v);
    if (opt === undefined) return "not_an_option";
    field.select(opt);
    return undefined;
  }
  if (field instanceof PDFDropdown) {
    if (typeof v !== "string") return "wrong_type";
    const opt = pickOption(field.getOptions(), v);
    if (opt === undefined && !field.isEditable()) return "not_an_option";
    if (!encodable(opt ?? v)) return "unsupported_characters";
    field.select(opt ?? v);
    return undefined;
  }
  if (field instanceof PDFOptionList) {
    const want = Array.isArray(v) ? v : typeof v === "string" ? [v] : undefined;
    if (want === undefined) return "wrong_type";
    if (want.length > 1 && !field.isMultiselect()) return "wrong_type";
    const opts = want.map((w) => pickOption(field.getOptions(), w));
    if (opts.some((o) => o === undefined)) return "not_an_option";
    field.select(opts as string[]);
    return undefined;
  }
  return "not_fillable";
}

function drawOverlay(doc: PDFDocument, spec: FormFieldSpec, text: string, font: PDFFont): void {
  const page = doc.getPage(spec.page - 1);
  const [x1, y1, x2, y2] = spec.rect;
  let shown = text.replace(/\s*[\r\n]+\s*/g, " ");
  let size = Math.max(6, Math.min(12, (y2 - y1) * 0.8));
  while (size > 6 && font.widthOfTextAtSize(shown, size) > x2 - x1) size -= 0.5;
  while (shown.length > 1 && font.widthOfTextAtSize(shown, size) > x2 - x1)
    shown = shown.slice(0, -1);
  page.drawText(shown, {
    x: x1 + 2,
    y: y1 + (y2 - y1 - size) / 2 + 1,
    size,
    font,
    color: rgb(0, 0, 0.55),
  });
}

async function loadPdf(bytes: Uint8Array): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false, preserveXFA: true });
  } catch (err) {
    const name = (err as { name?: string }).name ?? "";
    if (/Encrypted/i.test(name) || /encrypted/i.test(String(err)))
      throw new FormFillError("encrypted", "The PDF is encrypted; ask the sender for an open copy");
    throw new FormFillError("invalid_pdf", `Not a readable PDF: ${(err as Error).message}`);
  }
}

/**
 * Fills AcroForm fields (and OCR overlay fields) with pdf-lib. Values that do not fit their field
 * are reported in `skipped`, never coerced or truncated. Pure XFA forms throw `FormFillError("xfa")`;
 * hybrid forms lose their XFA packet so every reader shows the AcroForm values.
 */
export async function fillPdfForm(
  bytes: Uint8Array,
  values: FormValues,
  opts: FillOptions = {},
): Promise<FillResult> {
  const doc = await loadPdf(bytes);
  const form = doc.getForm();
  const acroFields = form.getFields();
  if (form.hasXFA() && acroFields.length === 0)
    throw new FormFillError("xfa", "Pure XFA forms cannot be filled");
  if (form.hasXFA()) form.deleteXFA();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const overlays = new Map((opts.overlays ?? []).map((o) => [o.name, o]));
  const applied: string[] = [];
  const skipped: SkippedValue[] = [];
  for (const [name, v] of Object.entries(values)) {
    const overlay = overlays.get(name);
    if (overlay !== undefined) {
      if (typeof v !== "string") skipped.push({ name, reason: "wrong_type" });
      else if (!encodable(v)) skipped.push({ name, reason: "unsupported_characters" });
      else {
        drawOverlay(doc, overlay, v, font);
        applied.push(name);
      }
      continue;
    }
    const field = form.getFieldMaybe(name);
    if (field === undefined) {
      skipped.push({ name, reason: "unknown_field" });
      continue;
    }
    const reason = applyValue(field, v);
    if (reason === undefined) applied.push(name);
    else skipped.push({ name, reason });
  }
  if (acroFields.length > 0) form.updateFieldAppearances(font);
  if (opts.flatten === true && acroFields.length > 0) form.flatten();
  const out = await doc.save();
  return {
    bytes: out,
    sha256: await sha256(out),
    applied,
    skipped,
    flattened: opts.flatten === true,
  };
}

/** Flattens every form field into page content (the copy that leaves the device). */
export async function flattenPdf(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await loadPdf(bytes);
  const form = doc.getForm();
  if (form.hasXFA()) form.deleteXFA();
  if (form.getFields().length > 0) {
    form.updateFieldAppearances(await doc.embedFont(StandardFonts.Helvetica));
    form.flatten();
  }
  return doc.save();
}

export interface ReviewRow {
  name: string;
  label: string;
  page: number;
  /** What the user will see in the copy ("☑" / "☐" for checkboxes). */
  display: string;
}

export interface FilledCopy {
  /** "<source name> (filled).pdf" */
  name: string;
  bytes: Uint8Array;
  sha256: string;
  sourceSha256: string;
  review: ReviewRow[];
  skipped: SkippedValue[];
  /** Required fields still empty after the fill: ask the user again before review. */
  missingRequired: string[];
  /** Field names that were filled, in request order. */
  applied: string[];
}

export function filledName(name: string, suffix = "filled"): string {
  const base = name.replace(/\.pdf$/i, "");
  return `${base} (${suffix}).pdf`;
}

function display(spec: FormFieldSpec, v: FormValue): string {
  if (spec.type === "checkbox") return asBoolean(v) === true ? "☑" : "☐";
  return Array.isArray(v) ? v.join(", ") : String(v);
}

/**
 * Step "fill → preview": an editable filled copy plus the rows the review card shows. The reply
 * draft's approval should bind to `sha256` so the sent attachment is exactly what was reviewed.
 */
export async function prepareFilledCopy(
  source: { name: string; bytes: Uint8Array },
  detection: FormDetection,
  values: FormValues,
): Promise<FilledCopy> {
  const overlays = detection.fields.filter((f) => f.source === "ocr");
  const res = await fillPdfForm(source.bytes, values, { overlays });
  const specs = new Map(detection.fields.map((f) => [f.name, f]));
  const review: ReviewRow[] = [];
  for (const name of res.applied) {
    const spec = specs.get(name);
    const v = values[name];
    if (spec === undefined || v === undefined) continue;
    review.push({ name, label: spec.label, page: spec.page, display: display(spec, v) });
  }
  const filled = new Set(res.applied);
  const missingRequired = detection.fields
    .filter((f) => f.required && !filled.has(f.name) && (f.value === null || f.value === ""))
    .map((f) => f.name);
  return {
    name: filledName(source.name),
    bytes: res.bytes,
    sha256: res.sha256,
    sourceSha256: detection.sha256,
    review,
    skipped: res.skipped,
    missingRequired,
    applied: res.applied,
  };
}

export interface FinalCopy {
  name: string;
  bytes: Uint8Array;
  sha256: string;
  reviewedSha256: string;
}

/**
 * Step "flatten on send": checks the bytes are the reviewed copy (`reviewedSha256` from the
 * approval binding), then flattens. Throws `FormFillError("binding_mismatch")` otherwise.
 */
export async function finalizeFilledCopy(
  copy: { name: string; bytes: Uint8Array },
  reviewedSha256: string,
): Promise<FinalCopy> {
  const actual = await sha256(copy.bytes);
  if (actual !== reviewedSha256)
    throw new FormFillError("binding_mismatch", "The filled copy changed after it was reviewed");
  const bytes = await flattenPdf(copy.bytes);
  return { name: copy.name, bytes, sha256: await sha256(bytes), reviewedSha256 };
}

export interface FillReceiptInput {
  sourceName: string;
  copy: Pick<FilledCopy, "sourceSha256" | "applied" | "skipped">;
  final: FinalCopy;
  approvalId?: string | null;
  taskId?: string | null;
  toolCallId?: string | null;
}

/** The receipt the orchestrator records after sending: names and hashes, never field values. */
export function fillReceipt(input: FillReceiptInput): ReceiptInput {
  const n = input.copy.applied.length;
  return {
    kind: "file_write",
    outcome: "ok",
    summary: `Filled ${n} field${n === 1 ? "" : "s"} in "${input.sourceName}" and flattened "${input.final.name}"`,
    taskId: input.taskId ?? null,
    toolCallId: input.toolCallId ?? null,
    approvalId: input.approvalId ?? null,
    externalRefs: {
      sourceSha256: input.copy.sourceSha256,
      reviewedSha256: input.final.reviewedSha256,
      sentSha256: input.final.sha256,
    },
    payload: {
      action: "document.fill",
      fields: input.copy.applied,
      skipped: input.copy.skipped.map((s) => ({ name: s.name, reason: s.reason })),
      flattened: true,
    },
  };
}
