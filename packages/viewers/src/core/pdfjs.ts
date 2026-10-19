/**
 * Loads PDF.js 6. Browsers (the desktop renderer, the web client) use the modern build with a
 * self-hosted worker whose URL the shell sets once with `configurePdfJs` (for Vite:
 * `import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url"`). Never a CDN: the app must run
 * offline and must not leak which documents the user opens. Node (the Gateway's extraction, tests)
 * uses the legacy build, which runs the worker in-process.
 */

import { isNodeRuntime } from "./env.ts";

export type PdfJs = typeof import("pdfjs-dist");

export interface PdfJsConfig {
  /** URL of `pdf.worker.min.mjs`, served by the app itself. Required in browsers. */
  workerSrc?: string;
  /** Directory URL (trailing slash) of `pdfjs-dist/standard_fonts/`. */
  standardFontDataUrl?: string;
  /** Directory URL (trailing slash) of `pdfjs-dist/cmaps/`. */
  cMapUrl?: string;
}

let config: PdfJsConfig = {};
let loading: Promise<PdfJs> | undefined;

export function configurePdfJs(next: PdfJsConfig): void {
  config = { ...config, ...next };
  loading = undefined;
}

export function pdfJsConfig(): Readonly<PdfJsConfig> {
  return config;
}

export function loadPdfJs(): Promise<PdfJs> {
  loading ??= (async () => {
    if (isNodeRuntime()) {
      const lib = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfJs;
      if (config.standardFontDataUrl === undefined) {
        // Resolve the bundled font data next to the installed package (Node only).
        const nodeModule = "node:module";
        const { createRequire } = (await import(/* @vite-ignore */ nodeModule)) as {
          createRequire(url: string): { resolve(id: string): string };
        };
        const pkg = createRequire(import.meta.url).resolve("pdfjs-dist/package.json");
        const root = pkg.slice(0, pkg.length - "package.json".length);
        config = {
          ...config,
          standardFontDataUrl: `${root}standard_fonts/`,
          cMapUrl: `${root}cmaps/`,
        };
      }
      return lib;
    }
    const lib = (await import("pdfjs-dist")) as PdfJs;
    if (config.workerSrc === undefined) {
      throw new Error(
        "PDF.js worker URL not configured: call configurePdfJs({ workerSrc }) with the app's own copy of pdf.worker.min.mjs",
      );
    }
    lib.GlobalWorkerOptions.workerSrc = config.workerSrc;
    return lib;
  })();
  return loading;
}
