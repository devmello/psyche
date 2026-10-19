/** Shared helpers for the real-Chrome suites (playwright-core, no browser download). */
import { existsSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export function findChrome(): string | undefined {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  return candidates.find((p): p is string => p !== undefined && p !== "" && existsSync(p));
}

export const chrome = findChrome();

/** JSON that is safe inside an inline <script> (no "</script>" breakout). */
export const js = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

export interface Srv {
  server: Server;
  origin: string;
  hits: string[];
}

export async function serve(handler: (path: string, res: ServerResponse) => void): Promise<Srv> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? "");
    handler(req.url ?? "/", res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { server, origin: `http://127.0.0.1:${port}`, hits };
}

/** Bundles a browser entry (ESM, code-split) into a fresh temp dir with esbuild. */
export async function bundleForBrowser(entry: string): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const esbuild = await import("esbuild");
  const outdir = await mkdtemp(join(tmpdir(), "psyche-viewers-"));
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    minify: true,
    format: "esm",
    splitting: true,
    outdir,
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "error",
  });
  return outdir;
}

const TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".html": "text/html; charset=utf-8",
};

/** Serves files from `dir` (404 otherwise) with the given extra headers. */
export function staticHandler(dir: string, headers: Record<string, string> = {}) {
  return async (path: string, res: ServerResponse) => {
    const { readFile } = await import("node:fs/promises");
    const { extname, join, normalize } = await import("node:path");
    const rel = normalize(path.split("?")[0] ?? "/").replace(/^(\.\.[/\\])+/, "");
    try {
      const body = await readFile(join(dir, rel));
      res.writeHead(200, {
        "Content-Type": TYPES[extname(rel)] ?? "application/octet-stream",
        ...headers,
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  };
}
