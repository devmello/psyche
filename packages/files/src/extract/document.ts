import { docxSource, xlsxSource } from "./office.ts";
import {
  type DocumentFormat,
  type DocumentPage,
  type DocumentSource,
  pageDocument,
} from "./pager.ts";
import { pdfSource } from "./pdf.ts";

export interface ExtractRequest {
  format: DocumentFormat;
  bytes: Uint8Array;
  offset: number;
  maxChars: number;
  /** Bytes any one ZIP part may expand to. */
  inflateCap: number;
}

/** Extracts one page of text in this thread; `extractDocument` runs it in a bounded worker. */
export async function extractInProcess(req: ExtractRequest): Promise<DocumentPage> {
  let src: DocumentSource;
  switch (req.format) {
    case "pdf":
      src = await pdfSource(req.bytes);
      break;
    case "docx":
      src = docxSource(req.bytes, req.inflateCap);
      break;
    case "xlsx":
      src = xlsxSource(req.bytes, req.inflateCap);
      break;
  }
  try {
    return await pageDocument(req.format, src, req.offset, req.maxChars);
  } finally {
    await src.close?.();
  }
}
