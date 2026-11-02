import {
  OCR_CAPABILITIES,
  OCR_MAX_FILE_BYTES,
  OCR_MAX_PAGES_PER_CALL,
  OCR_MIN_TEXT_CHARS,
  type OcrRecognizeParams,
  type OcrRecognizeResult,
} from "@psyche/protocol";
import { FakeNodeClient } from "./FakeNodeClient.ts";

/** One scripted file: an image (`pages` has one entry, no text layer) or a PDF. */
export interface FakeOcrFile {
  /** Text layer per page (empty for a picture-only page). */
  layers: string[];
  /** What Vision reads from each page. */
  scans: string[];
  bytes?: number;
}

/**
 * A mac-helper-shaped node serving `ocr.recognize` over scripted files, with the helper's rules:
 * pages whose text layer is shorter than `minTextChars` are recognised, at most `maxPages` per
 * call, nothing above the size cap. `recognised` lists every (path, page) it was asked to read, so
 * tests can assert what OCR never saw; `inFlight` tops out at 1 when callers are serialised.
 */
export class FakeOcrNode extends FakeNodeClient {
  readonly files = new Map<string, FakeOcrFile>();
  readonly recognised: { path: string; page: number }[] = [];
  maxInFlight = 0;
  #inFlight = 0;
  /** Milliseconds each call takes (to observe overlap). */
  delayMs = 0;

  constructor(options: { nodeId?: string } = {}) {
    super({ nodeId: options.nodeId ?? "node_mac_ocr", kind: "mac-helper" });
    const capability = OCR_CAPABILITIES[0];
    if (capability === undefined) throw new Error("ocr.recognize");
    this.handle({
      capability: structuredClone(capability),
      handle: (p) => this.#recognize(p as OcrRecognizeParams),
    });
  }

  /** A picture: no text layer, `text` is what Vision reads. */
  image(path: string, text: string, bytes = 1024): this {
    this.files.set(path, { layers: [""], scans: [text], bytes });
    return this;
  }

  pdf(path: string, pages: { layer?: string; scan?: string }[], bytes = 4096): this {
    this.files.set(path, {
      layers: pages.map((p) => p.layer ?? ""),
      scans: pages.map((p) => p.scan ?? ""),
      bytes,
    });
    return this;
  }

  async #recognize(p: OcrRecognizeParams): Promise<OcrRecognizeResult> {
    this.#inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.#inFlight);
    try {
      if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
      const file = this.files.get(p.path);
      if (file === undefined) return { pages: [], pageCount: 0, refusal: "not_a_file" };
      if ((file.bytes ?? 0) > Math.min(p.maxFileBytes ?? OCR_MAX_FILE_BYTES, OCR_MAX_FILE_BYTES))
        return { pages: [], pageCount: 0, refusal: "too_large" };
      const isPdf = p.path.toLowerCase().endsWith(".pdf");
      const min = isPdf ? (p.minTextChars ?? OCR_MIN_TEXT_CHARS) : Number.POSITIVE_INFINITY;
      const cap = Math.min(p.maxPages ?? OCR_MAX_PAGES_PER_CALL, OCR_MAX_PAGES_PER_CALL);
      const pages: OcrRecognizeResult["pages"] = [];
      let next: number | undefined;
      for (let page = p.fromPage ?? 1; page <= file.layers.length; page++) {
        if ((file.layers[page - 1] ?? "").trim().length >= min) continue;
        if (pages.length >= cap) {
          next = page;
          break;
        }
        this.recognised.push({ path: p.path, page });
        const text = (file.scans[page - 1] ?? "").trim();
        if (text !== "") pages.push({ page, text, confidence: 0.95 });
      }
      return {
        pages,
        pageCount: file.layers.length,
        ...(next === undefined ? {} : { nextPage: next }),
      };
    } finally {
      this.#inFlight -= 1;
    }
  }
}
