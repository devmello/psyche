import {
  type NodeClient,
  OCR_MAX_FILE_BYTES,
  OCR_MAX_PAGES_PER_CALL,
  OCR_MIN_TEXT_CHARS,
  type OcrRecognizeResult,
} from "@psyche/protocol";
import { hostWords } from "@psyche/protocol/host-words";
import type { OcrText } from "@psyche/search";

/**
 * Vision OCR for search ingest (roadmap R6/R7, docs/design/search-roadmap-2026.md §3.4). The Mac
 * helper's `ocr.recognize` reads an image or the image-only pages of a PDF with Apple Vision, on
 * this Mac. The Gateway keeps no model and no state of its own: it forwards one file at a time
 * (a queue of one, shared by the files source and the Library), and nodes.invoke / agent tools
 * cannot reach `ocr.*` (`isUnreachableCapability`).
 */

/** A helper call is given this long (an image takes ~0.3 s; a 20-page scan about 10 s). */
export const OCR_CALL_TIMEOUT_MS = 90_000;

/** The newest live Mac helper node that offers `ocr.recognize`, or undefined. */
export type OcrNode = () => Pick<NodeClient, "invoke"> | undefined;

export type Recognize = (path: string, signal: AbortSignal) => Promise<OcrText | undefined>;

/**
 * `ocr.recognize` through the helper. Calls run one after another, whoever asks, so the helper
 * never recognises two pages at once. Resolves undefined when there is no helper or the file
 * cannot be read (unsupported, too large, unreadable); throws when the helper fails.
 */
export function helperRecognizer(
  node: OcrNode,
  opts: { maxFileBytes?: number; timeoutMs?: number } = {},
): Recognize {
  let tail: Promise<unknown> = Promise.resolve();
  return (path, signal) => {
    const run = async (): Promise<OcrText | undefined> => {
      if (signal.aborted) return undefined;
      const client = node();
      if (client === undefined) return undefined;
      const res = await client.invoke(
        "ocr.recognize",
        {
          path,
          maxPages: OCR_MAX_PAGES_PER_CALL,
          minTextChars: OCR_MIN_TEXT_CHARS,
          maxFileBytes: opts.maxFileBytes ?? OCR_MAX_FILE_BYTES,
        },
        { timeoutMs: opts.timeoutMs ?? OCR_CALL_TIMEOUT_MS, signal },
      );
      if (!res.ok)
        throw new Error(res.error?.message ?? `${hostWords().helper} could not read the file`);
      const out = res.result as OcrRecognizeResult;
      if (out.refusal !== undefined) return undefined;
      const text = out.pages
        .map((p) => p.text.trim())
        .filter((t) => t !== "")
        .join("\n\n");
      return { text, pages: out.pages.length };
    };
    const next = tail.then(run, run);
    tail = next.catch(() => undefined);
    return next;
  };
}
