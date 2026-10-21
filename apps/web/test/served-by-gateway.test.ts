import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Gateway, type GatewayOptions, startGateway } from "@psyche/gateway";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Feature A8: the production web build is what the Gateway serves at `/`. */
const webRoot = fileURLToPath(new URL("..", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "psy-web-"));
const outDir = join(dir, "dist");
let gw: Gateway;

beforeAll(async () => {
  await build({
    root: webRoot,
    configFile: join(webRoot, "vite.config.ts"),
    logLevel: "silent",
    build: { outDir, emptyOutDir: true, sourcemap: false },
  });
  gw = await startGateway({
    config: {
      home: join(dir, "home"),
      port: 0,
      dbPath: ":memory:",
      webRoot: outDir,
      nodeSocketPath: join(dir, "n.sock"),
    },
    env: {},
    logger: { log() {} } satisfies GatewayOptions["logger"],
  });
}, 120_000);

afterAll(async () => {
  await gw?.stop("test");
  rmSync(dir, { recursive: true, force: true });
});

describe("web build served by the Gateway", () => {
  it("serves index.html with the strict CSP and its assets", async () => {
    const res = await fetch(`${gw.origin}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain("default-src 'self'; script-src 'self';");
    expect(html).not.toContain("unsafe-inline' 'unsafe-eval");
    const script = /<script type="module" crossorigin src="([^"]+)"/.exec(html)?.[1];
    expect(script).toBeTruthy();
    const js = await fetch(`${gw.origin}${script}`);
    expect(js.status).toBe(200);
    const code = await js.text();
    expect(code).toContain("Psyche isn't reachable right now");
    // The composed app (A8): the kit's onboarding and chat column ship in the web bundle.
    expect(code).toContain("Open the main chat");
    // The kit's stylesheet is built by Tailwind and linked from index.html.
    const css = /<link rel="stylesheet" crossorigin href="([^"]+)"/.exec(html)?.[1];
    expect(css).toBeTruthy();
    const sheet = await fetch(`${gw.origin}${css}`);
    expect(sheet.status).toBe(200);
    expect(await sheet.text()).toContain("--accent");
  });

  it("answers /healthz next to the UI", async () => {
    const res = await fetch(`${gw.origin}/healthz`);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });
});
