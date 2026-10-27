import { Worker } from "node:worker_threads";
import { entryUrl } from "@psyche/assets";
import { PsycheError } from "@psyche/protocol";
import type { ExtractRequest } from "./document.ts";
import type { DocumentFormat, DocumentPage } from "./pager.ts";

export { type DocumentFormat, type DocumentPage, UNIT_STRIDE } from "./pager.ts";

/** Bounds on `read_file`'s document extraction. */
export const EXTRACT_LIMITS = {
  /** Largest PDF, DOCX or XLSX `read_file` extracts. */
  fileBytes: 64 * 1024 * 1024,
  /** Bytes one ZIP part (document.xml, a worksheet) may inflate to. */
  inflateBytes: 64 * 1024 * 1024,
  /** Characters of text per call. */
  chars: 64 * 1024,
  /** Wall-clock budget per call; the worker is terminated after it. */
  timeoutMs: 30_000,
  /** V8 heap of the extraction worker. */
  heapMb: 512,
};

const EXTENSIONS: Record<string, DocumentFormat> = {
  pdf: "pdf",
  docx: "docx",
  docm: "docx",
  xlsx: "xlsx",
  xlsm: "xlsx",
};

/** The document format a path's extension claims, if `read_file` extracts it. */
export function documentFormatOf(path: string): DocumentFormat | undefined {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? undefined : EXTENSIONS[path.slice(dot + 1).toLowerCase()];
}

/** Whether the file's first bytes agree with the format its extension claims. */
export function magicMatches(format: DocumentFormat, head: Uint8Array): boolean {
  if (format === "pdf") {
    // Readers accept the header anywhere in the first KiB.
    return Buffer.from(head.subarray(0, 1024)).includes("%PDF-");
  }
  return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
}

export interface ExtractOptions {
  offset: number;
  maxChars?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Extracts one bounded page of text in a worker thread with a capped heap and a deadline, so a
 * hostile or huge document cannot exhaust the Gateway's memory or block its event loop.
 */
export function extractDocument(
  format: DocumentFormat,
  bytes: Uint8Array,
  opts: ExtractOptions,
): Promise<DocumentPage> {
  const req: ExtractRequest = {
    format,
    bytes,
    offset: opts.offset,
    maxChars: opts.maxChars ?? EXTRACT_LIMITS.chars,
    inflateCap: EXTRACT_LIMITS.inflateBytes,
  };
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new PsycheError("cancelled", "cancelled"));
      return;
    }
    const worker = new Worker(
      entryUrl(new URL("./worker.ts", import.meta.url), "extract-worker.mjs"),
      {
        resourceLimits: {
          maxOldGenerationSizeMb: EXTRACT_LIMITS.heapMb,
          maxYoungGenerationSizeMb: 64,
        },
      },
    );
    let settled = false;
    const finish = (err: PsycheError | undefined, page?: DocumentPage) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      void worker.terminate();
      if (err !== undefined) reject(err);
      else resolve(page as DocumentPage);
    };
    const onAbort = () => finish(new PsycheError("cancelled", "cancelled"));
    const timer = setTimeout(
      () => finish(new PsycheError("timeout", "text extraction took too long")),
      opts.timeoutMs ?? EXTRACT_LIMITS.timeoutMs,
    );
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    worker.once(
      "message",
      (msg: { ok: true; page: DocumentPage } | { ok: false; message: string }) =>
        msg.ok
          ? finish(undefined, msg.page)
          : finish(new PsycheError("invalid_params", `${format.toUpperCase()}: ${msg.message}`)),
    );
    worker.once("error", (err: NodeJS.ErrnoException) =>
      finish(
        new PsycheError(
          "invalid_params",
          err.code === "ERR_WORKER_OUT_OF_MEMORY"
            ? `${format.toUpperCase()}: the document needs more than ${EXTRACT_LIMITS.heapMb} MB to extract`
            : `${format.toUpperCase()}: could not extract text`,
        ),
      ),
    );
    worker.once("exit", () =>
      finish(new PsycheError("internal", "the extraction worker exited early")),
    );
    worker.postMessage(req);
  });
}
