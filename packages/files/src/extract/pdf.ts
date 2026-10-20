import { DocumentError, type DocumentSource } from "./pager.ts";

type PdfJs = typeof import("pdfjs-dist");

/**
 * A PDF's text layer, one page per unit, with PDF.js's Node build (the library @psyche/viewers
 * uses, with the same hardening: no eval, no document JavaScript). Pages load on demand, so a call
 * only parses the pages it returns.
 */
export async function pdfSource(bytes: Uint8Array): Promise<DocumentSource> {
  const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfJs;
  const task = pdfjs.getDocument({
    data: bytes,
    isEvalSupported: false,
    enableScripting: false,
    enableXfa: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  } as Parameters<PdfJs["getDocument"]>[0]);
  let doc: Awaited<typeof task.promise>;
  try {
    doc = await task.promise;
  } catch (err) {
    await task.destroy();
    if ((err as { name?: string }).name === "PasswordException") {
      throw new DocumentError("the PDF is password-protected");
    }
    throw new DocumentError("unreadable PDF");
  }
  const blank: number[] = [];
  return {
    unit: "page",
    count: doc.numPages,
    label: (i) => `page ${i + 1}`,
    async text(i) {
      const page = await doc.getPage(i + 1);
      try {
        const content = await page.getTextContent();
        let out = "";
        for (const item of content.items) {
          if (!("str" in item)) continue;
          out += item.str;
          if (item.hasEOL) out += "\n";
        }
        out = out.replace(/[ \t]+\n/g, "\n").trimEnd();
        if (out.trim() === "") blank.push(i + 1);
        return out;
      } finally {
        page.cleanup();
      }
    },
    warnings: () =>
      blank.length === 0
        ? []
        : [
            `No text layer on page${blank.length > 1 ? "s" : ""} ${blank.join(", ")} (scanned?); OCR is not available to read_file`,
          ],
    close: () => task.destroy(),
  };
}
