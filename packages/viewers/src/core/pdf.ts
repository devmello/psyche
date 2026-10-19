import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist/types/src/display/api.js";
import { loadPdfJs, pdfJsConfig } from "./pdfjs.ts";

export type PdfFieldType = "text" | "checkbox" | "radio" | "choice" | "button" | "signature";

export interface PdfFormField {
  /** pdf.js annotation id, used to write fill-preview values. */
  id: string;
  name: string;
  type: PdfFieldType;
  value: string | string[] | boolean | null;
  /** 1-based page number. */
  page: number;
  /** PDF user-space rectangle [x1, y1, x2, y2]. */
  rect: [number, number, number, number];
  readOnly: boolean;
  required: boolean;
  multiline?: boolean;
  maxLen?: number;
  options?: { value: string; label: string }[];
  /** Export value for checkboxes / radios ("Yes", "On", ...). */
  exportValue?: string;
}

export interface PdfOutlineNode {
  title: string;
  /** 1-based page, or undefined when the destination cannot be resolved. */
  page?: number;
  children: PdfOutlineNode[];
}

/**
 * Form technology. `xfa` = pure XFA (pdf.js can only render it; nothing in our stack fills it);
 * `hybrid` = XFA plus an AcroForm fallback (we show and fill the AcroForm fields).
 */
export type PdfFormKind = "none" | "acroform" | "hybrid" | "xfa";

export interface PdfInfo {
  numPages: number;
  title?: string;
  formKind: PdfFormKind;
  isPureXfa: boolean;
  encrypted: boolean;
}

export interface PdfSearchHit {
  page: number;
  /** Character offset in the page text. */
  index: number;
  snippet: string;
}

export interface PdfOpenOptions {
  password?: string;
}

export class PdfPasswordError extends Error {
  readonly reason: "needed" | "incorrect";
  constructor(reason: "needed" | "incorrect") {
    super(reason === "needed" ? "PDF is password-protected" : "Incorrect PDF password");
    this.name = "PdfPasswordError";
    this.reason = reason;
  }
}

const FIELD_TYPES: Record<string, PdfFieldType> = {
  Tx: "text",
  Ch: "choice",
  Sig: "signature",
};

interface RawAnnotation {
  id: string;
  subtype?: string;
  fieldName?: string;
  fieldType?: string;
  fieldValue?: unknown;
  rect: number[];
  readOnly?: boolean;
  required?: boolean;
  multiLine?: boolean;
  maxLen?: number;
  checkBox?: boolean;
  radioButton?: boolean;
  pushButton?: boolean;
  exportValue?: string;
  buttonValue?: string;
  options?: { exportValue: string; displayValue: string }[];
}

function toField(a: RawAnnotation, page: number): PdfFormField | undefined {
  if (a.subtype !== "Widget" || a.fieldName === undefined || a.fieldType === undefined)
    return undefined;
  let type: PdfFieldType = FIELD_TYPES[a.fieldType] ?? "text";
  if (a.fieldType === "Btn") type = a.checkBox ? "checkbox" : a.radioButton ? "radio" : "button";
  const rect = [
    a.rect[0] ?? 0,
    a.rect[1] ?? 0,
    a.rect[2] ?? 0,
    a.rect[3] ?? 0,
  ] as PdfFormField["rect"];
  let value: PdfFormField["value"] = null;
  if (type === "checkbox")
    value = a.fieldValue !== undefined && a.fieldValue !== "Off" && a.fieldValue === a.exportValue;
  else if (type === "radio") value = typeof a.fieldValue === "string" ? a.fieldValue : null;
  else if (Array.isArray(a.fieldValue)) value = a.fieldValue.map(String);
  else if (typeof a.fieldValue === "string") value = a.fieldValue;
  const field: PdfFormField = {
    id: a.id,
    name: a.fieldName,
    type,
    value,
    page,
    rect,
    readOnly: a.readOnly === true,
    required: a.required === true,
  };
  if (a.multiLine) field.multiline = true;
  if (typeof a.maxLen === "number" && a.maxLen > 0) field.maxLen = a.maxLen;
  if (a.options !== undefined)
    field.options = a.options.map((o) => ({ value: o.exportValue, label: o.displayValue }));
  const exportValue = a.exportValue ?? a.buttonValue;
  if (exportValue !== undefined && (type === "checkbox" || type === "radio"))
    field.exportValue = exportValue;
  return field;
}

/** An open PDF. Call `close()` when done; pdf.js holds the bytes and a worker. */
export class PdfHandle {
  readonly #task: PDFDocumentLoadingTask;
  readonly doc: PDFDocumentProxy;
  readonly info: PdfInfo;
  #text = new Map<number, Promise<string>>();

  private constructor(task: PDFDocumentLoadingTask, doc: PDFDocumentProxy, info: PdfInfo) {
    this.#task = task;
    this.doc = doc;
    this.info = info;
  }

  static async open(bytes: Uint8Array, opts: PdfOpenOptions = {}): Promise<PdfHandle> {
    const pdfjs = await loadPdfJs();
    const cfg = pdfJsConfig();
    const task = pdfjs.getDocument({
      // pdf.js transfers (detaches) the buffer; hand it a copy so callers keep theirs.
      data: bytes.slice(),
      ...(opts.password === undefined ? {} : { password: opts.password }),
      enableXfa: true,
      isEvalSupported: false,
      // Never run document JavaScript; the scripting sandbox is not loaded.
      enableScripting: false,
      verbosity: 0,
      ...(cfg.standardFontDataUrl === undefined
        ? {}
        : { standardFontDataUrl: cfg.standardFontDataUrl }),
      ...(cfg.cMapUrl === undefined ? {} : { cMapUrl: cfg.cMapUrl, cMapPacked: true }),
    } as Parameters<typeof pdfjs.getDocument>[0]);
    let doc: PDFDocumentProxy;
    try {
      doc = await task.promise;
    } catch (err) {
      await task.destroy();
      if ((err as { name?: string }).name === "PasswordException") {
        const code = (err as { code?: number }).code;
        throw new PdfPasswordError(code === 2 ? "incorrect" : "needed");
      }
      throw err;
    }
    const meta = await doc.getMetadata().catch(() => undefined);
    const raw = (meta?.info ?? {}) as Record<string, unknown>;
    const hasXfa = raw.IsXFAPresent === true;
    const hasAcro = raw.IsAcroFormPresent === true;
    const isPureXfa = doc.isPureXfa || (hasXfa && !hasAcro);
    const formKind: PdfFormKind = isPureXfa
      ? "xfa"
      : hasXfa
        ? "hybrid"
        : hasAcro
          ? "acroform"
          : "none";
    const title = typeof raw.Title === "string" && raw.Title.trim() !== "" ? raw.Title : undefined;
    return new PdfHandle(task, doc, {
      numPages: doc.numPages,
      ...(title === undefined ? {} : { title }),
      formKind,
      isPureXfa,
      encrypted: typeof raw.EncryptFilterName === "string",
    });
  }

  /** Plain text of a 1-based page; lines joined with "\n". Cached. */
  pageText(page: number): Promise<string> {
    let cached = this.#text.get(page);
    if (cached === undefined) {
      cached = (async () => {
        const p = await this.doc.getPage(page);
        const content = await p.getTextContent();
        let out = "";
        for (const item of content.items) {
          if (!("str" in item)) continue;
          out += item.str;
          if (item.hasEOL) out += "\n";
        }
        p.cleanup();
        return out.replace(/[ \t]+\n/g, "\n").trimEnd();
      })();
      this.#text.set(page, cached);
    }
    return cached;
  }

  /** AcroForm fields from every page's widget annotations, in page order. */
  async fields(): Promise<PdfFormField[]> {
    if (this.info.formKind === "none" || this.info.formKind === "xfa") return [];
    const out: PdfFormField[] = [];
    for (let n = 1; n <= this.info.numPages; n++) {
      const page = await this.doc.getPage(n);
      const anns = (await page.getAnnotations({ intent: "display" })) as RawAnnotation[];
      for (const a of anns) {
        const f = toField(a, n);
        if (f !== undefined) out.push(f);
      }
    }
    return out;
  }

  async outline(): Promise<PdfOutlineNode[]> {
    const items = (await this.doc.getOutline()) ?? [];
    type Item = (typeof items)[number];
    const resolve = async (item: Item): Promise<PdfOutlineNode> => {
      let page: number | undefined;
      try {
        const dest =
          typeof item.dest === "string" ? await this.doc.getDestination(item.dest) : item.dest;
        const ref = dest?.[0] as { num: number; gen: number } | number | undefined;
        if (typeof ref === "number") page = ref + 1;
        else if (ref !== undefined && ref !== null) page = (await this.doc.getPageIndex(ref)) + 1;
      } catch {
        page = undefined;
      }
      const children = await Promise.all((item.items ?? []).map(resolve));
      return { title: item.title, ...(page === undefined ? {} : { page }), children };
    };
    return Promise.all(items.map(resolve));
  }

  /** Case-insensitive search across pages; stops after `maxHits`. */
  async search(query: string, maxHits = 200): Promise<PdfSearchHit[]> {
    const q = query.trim().toLowerCase();
    if (q === "") return [];
    const hits: PdfSearchHit[] = [];
    for (let n = 1; n <= this.info.numPages && hits.length < maxHits; n++) {
      const text = await this.pageText(n);
      const lower = text.toLowerCase();
      let at = lower.indexOf(q);
      while (at !== -1 && hits.length < maxHits) {
        const start = Math.max(0, at - 40);
        const snippet = text
          .slice(start, at + q.length + 40)
          .replace(/\s+/g, " ")
          .trim();
        hits.push({ page: n, index: at, snippet });
        at = lower.indexOf(q, at + q.length);
      }
    }
    return hits;
  }

  /**
   * Fill preview: writes values into pdf.js's annotation storage and returns a saved copy. The
   * original bytes are untouched. Values are keyed by field name; checkboxes take booleans.
   * Real filling and flattening (P2) use pdf-lib in M2.
   */
  async fillPreview(values: Record<string, string | boolean | string[]>): Promise<Uint8Array> {
    if (this.info.formKind === "xfa") throw new Error("XFA forms are not supported");
    const fields = await this.fields();
    const storage = this.doc.annotationStorage;
    for (const f of fields) {
      if (!(f.name in values) || f.readOnly) continue;
      const v = values[f.name];
      if (f.type === "checkbox") storage.setValue(f.id, { value: v === true });
      else if (f.type === "radio") storage.setValue(f.id, { value: v === f.exportValue });
      else storage.setValue(f.id, { value: v });
    }
    return this.doc.saveDocument();
  }

  async close(): Promise<void> {
    await this.#task.destroy();
  }
}

export const openPdf = PdfHandle.open;
