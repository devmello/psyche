import { isNodeRuntime } from "./env.ts";

/**
 * DOCX text and semantic HTML via mammoth (BSD-2). The layout-faithful renderer (docx-preview)
 * lives in the React layer because it needs a DOM; mammoth is the fallback renderer and the
 * extraction path the agent reads (P4, P9).
 */

/** Browser builds take `arrayBuffer`; the Node build takes a `Buffer`. */
type MammothInput = { arrayBuffer: ArrayBuffer } | { buffer: Uint8Array };

type Mammoth = {
  extractRawText(input: MammothInput): Promise<{ value: string }>;
  convertToHtml(
    input: MammothInput,
    options?: { ignoreEmptyParagraphs?: boolean; convertImage?: unknown },
  ): Promise<{ value: string; messages: { type: string; message: string }[] }>;
  images: { imgElement(fn: (image: unknown) => Promise<{ src: string }>): unknown };
};

async function mammoth(): Promise<Mammoth> {
  const mod = (await import("mammoth")) as unknown as { default?: Mammoth } & Mammoth;
  return mod.default ?? mod;
}

function toInput(bytes: Uint8Array): MammothInput {
  const NodeBuffer = (globalThis as { Buffer?: { from(b: Uint8Array): Uint8Array } }).Buffer;
  if (isNodeRuntime() && NodeBuffer !== undefined) return { buffer: NodeBuffer.from(bytes) };
  return {
    arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  };
}

/** Paragraph text separated by blank lines. */
export async function docxToText(bytes: Uint8Array): Promise<string> {
  const { value } = await (await mammoth()).extractRawText(toInput(bytes));
  return value.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Semantic HTML. Embedded images are dropped (replaced with an empty alt) so the result has no
 * data the sanitizer must reason about; callers still sanitize before rendering.
 */
export async function docxToHtml(bytes: Uint8Array): Promise<{ html: string; warnings: string[] }> {
  const m = await mammoth();
  const result = await m.convertToHtml(
    toInput(bytes),
    {
      ignoreEmptyParagraphs: true,
      convertImage: m.images.imgElement(async () => ({ src: "" })),
    },
  );
  return { html: result.value, warnings: result.messages.map((w) => `${w.type}: ${w.message}`) };
}
