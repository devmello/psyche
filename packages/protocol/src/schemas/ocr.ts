import { type Static, Type } from "@sinclair/typebox";
import { StringEnum } from "../common.ts";
import type { NodeCapability } from "./identity.ts";

/**
 * On-device text recognition on the Mac (roadmap R6/R7, docs/design/search-roadmap-2026.md §3.4).
 * The mac helper's `ocr.recognize` runs Apple Vision (`VNRecognizeTextRequest`, `.accurate`) over
 * one image or the image-only pages of one PDF: system models, no download, nothing leaves the
 * Mac, and no state stays resident (the memory is the helper's, only while a page is recognised).
 *
 * Only the Gateway's search ingest calls it (`nodes.invoke` and agent tools cannot reach `ocr.*`),
 * with paths it already holds: files inside folders the owner granted and Library items. What
 * comes back is untrusted content and takes the provenance of its file.
 */

/** A text layer shorter than this (characters) makes a PDF page a candidate for recognition. */
export const OCR_MIN_TEXT_CHARS = 30;
/** Pages recognised in one call; the Gateway sends one file at a time and a file in small steps. */
export const OCR_MAX_PAGES_PER_CALL = 20;
/** Largest image or PDF the helper reads, bytes (larger ones are refused, not downsampled). */
export const OCR_MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Text kept per page. */
export const OCR_MAX_PAGE_CHARS = 20_000;

export const OcrRecognizeParams = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      maxLength: 4096,
      description: "An absolute path to a PNG, JPEG, HEIC, TIFF, GIF, WebP or PDF file",
    }),
    pages: Type.Optional(
      Type.Array(Type.Integer({ minimum: 1 }), {
        maxItems: 200,
        description: "PDF only: 1-based pages to consider (default: from the start)",
      }),
    ),
    fromPage: Type.Optional(
      Type.Integer({ minimum: 1, description: "PDF only: first page to consider (default 1)" }),
    ),
    maxPages: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: OCR_MAX_PAGES_PER_CALL,
        description: "At most this many pages are recognised in this call",
      }),
    ),
    minTextChars: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 1000,
        description: "PDF only: pages whose text layer is shorter than this are recognised",
      }),
    ),
    maxFileBytes: Type.Optional(
      Type.Integer({ minimum: 1024, maximum: OCR_MAX_FILE_BYTES, description: "Size cap" }),
    ),
  },
  { $id: "OcrRecognizeParams" },
);
export type OcrRecognizeParams = Static<typeof OcrRecognizeParams>;

export const OcrPage = Type.Object(
  {
    page: Type.Integer({ minimum: 1, description: "1 for an image" }),
    text: Type.String({ maxLength: OCR_MAX_PAGE_CHARS }),
    confidence: Type.Number({ minimum: 0, maximum: 1, description: "Mean line confidence" }),
  },
  { $id: "OcrPage" },
);
export type OcrPage = Static<typeof OcrPage>;

/** Why a file produced no text at all. */
export const OcrRefusal = StringEnum(
  ["unsupported_type", "too_large", "not_a_file", "unreadable", "unavailable"],
  { $id: "OcrRefusal" },
);
export type OcrRefusal = Static<typeof OcrRefusal>;

export const OcrRecognizeResult = Type.Object(
  {
    pages: Type.Array(OcrPage, { description: "Only pages that were recognised, in order" }),
    pageCount: Type.Integer({ minimum: 0, description: "Pages in the document (1 for an image)" }),
    nextPage: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "PDF only: where a next call continues, when pages remain",
      }),
    ),
    refusal: Type.Optional(OcrRefusal),
  },
  { $id: "OcrRecognizeResult" },
);
export type OcrRecognizeResult = Static<typeof OcrRecognizeResult>;

export const OCR_CAPABILITIES: readonly NodeCapability[] = [
  {
    name: "ocr.recognize",
    description:
      "On-device text recognition (Apple Vision) of an image or the image-only pages of a PDF; search ingest only",
    sideEffect: "read",
    targetKind: "path",
  },
];
