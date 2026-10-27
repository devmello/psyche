import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { arch, homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findChromium } from "@psyche/browser";
import { PROTOCOL_VERSION } from "@psyche/protocol";
import { GatewayConnection } from "@psyche/web/client";
import { afterAll, describe, expect, it } from "vitest";
import { Client } from "../../integration/walking-skeleton/harness.ts";
import { median } from "../src/report.ts";

/**
 * Startup numbers for the real `psyched` process (docs/archive/status/v1-perf.md), opt-in with
 * PSYCHE_PERF_TESTS=1 because it spawns Gateways and takes about a minute:
 *
 * - cold boot (empty `$PSYCHE_HOME`: migrations, keys) and warm boot (median of 3) to `/healthz`;
 * - idle RSS 3 s after the last warm boot;
 * - cold start to the first chat token and the warm first-token median, with a scripted
 *   OpenAI-compatible model server on loopback (no model latency: the Gateway's own cost).
 *
 * Targets: the built bundle (`apps/gateway/dist-bin/darwin-<arch>/psyched/psyched`, from
 * `node deploy/scripts/build-psyched.mjs`, or PSYCHE_PERF_PSYCHED) and the dev Gateway
 * (`node apps/gateway/src/main.ts`). Every run uses a temporary `$PSYCHE_HOME` and `HOME` and port 0,
 * so it never touches an installed Gateway or its LaunchAgent. Results: out/perf/process.json.
 * - first contentful paint of the web client the Gateway serves, in headless Chrome: the
 *   renderer's share of window-to-first-paint;
 * - with PSYCHE_PERF_PACKAGED=1 as well: window to first paint of the packaged app in
 *   `apps/desktop/out/` (never `/Applications`), launched once against this file's own psyched.
 *   It runs with scratch HOME, userData and `PSYCHE_HOME`, `--use-mock-keychain` (no Keychain
 *   prompt), `PSYCHE_GATEWAY_MODE=external` (no LaunchAgent), and the app's perf mode
 *   (`PSYCHE_PERF_FIRST_PAINT_FILE`: no psyche:// handler, shortcuts, updater or helper). It is
 *   unregistered from LaunchServices afterwards, and the owner's userData and LaunchAgent must be
 *   unchanged.
 */

const ENABLED = process.env.PSYCHE_PERF_TESTS === "1";
const ROOT = resolve(import.meta.dirname, "../../..");
const PACKAGED_APP = join(
  ROOT,
  "apps/desktop/out",
  `Psyche-darwin-${arch() === "arm64" ? "arm64" : "x64"}`,
  "Psyche.app",
);
const PACKAGED = ENABLED && process.env.PSYCHE_PERF_PACKAGED === "1" && existsSync(PACKAGED_APP);
const CHROMIUM = findChromium();

/** The slice of playwright-core this file drives (the acceptance package does not depend on it). */
interface Playwright {
  chromium: {
    launch(o: { executablePath: string; headless: boolean }): Promise<{
      newContext(): Promise<{
        newPage(): Promise<{
          goto(url: string, o: { waitUntil: "load" }): Promise<unknown>;
          evaluate<T>(fn: () => Promise<T>): Promise<T>;
        }>;
        close(): Promise<void>;
      }>;
      close(): Promise<void>;
    }>;
  };
}
const BUDGET = {
  warmBootMs: 1_000,
  coldBootMs: 2_000,
  idleRssMb: 250,
  coldStartToFirstTokenMs: 3_000,
  webFirstPaintMs: 1_000,
  windowFirstPaintMs: 2_000,
};

interface Target {
  name: string;
  argv: string[];
}

function targets(): Target[] {
  const out: Target[] = [];
  const built =
    process.env.PSYCHE_PERF_PSYCHED ??
    join(
      ROOT,
      "apps/gateway/dist-bin",
      `darwin-${arch() === "arm64" ? "arm64" : "x64"}`,
      "psyched/psyched",
    );
  if (existsSync(built)) out.push({ name: "built", argv: [built] });
  out.push({
    name: "dev",
    argv: [
      process.execPath,
      "--disable-warning=ExperimentalWarning",
      join(ROOT, "apps/gateway/src/main.ts"),
    ],
  });
  return out;
}

const dirs: string[] = [];
const children = new Set<ChildProcess>();
const results: Record<string, Record<string, number>> = {};

afterAll(() => {
  for (const c of children) c.kill("SIGKILL");
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  if (!ENABLED) return;
  mkdirSync(join(ROOT, "out/perf"), { recursive: true });
  writeFileSync(
    join(ROOT, "out/perf/process.json"),
    `${JSON.stringify(
      {
        machine: `${process.platform}/${process.arch} node ${process.versions.node}`,
        at: new Date().toISOString(),
        budgets: BUDGET,
        results,
      },
      null,
      2,
    )}\n`,
  );
});

const temp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
};

interface Running {
  child: ChildProcess;
  origin: string;
  listenMs: number;
  healthMs: number;
  stop(): Promise<void>;
}

/** Spawns a Gateway with only what launchd gives it and times it to `/healthz`. */
async function boot(
  t: Target,
  home: string,
  userHome: string,
  extra: NodeJS.ProcessEnv = {},
): Promise<Running> {
  const t0 = performance.now();
  const [cmd, ...args] = t.argv as [string, ...string[]];
  const child = spawn(cmd, args, {
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: userHome,
      PSYCHE_HOME: home,
      PSYCHE_PORT: "0",
      PSYCHE_BROWSER: "off",
      ...extra,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  children.add(child);
  const { origin, listenMs } = await new Promise<{ origin: string; listenMs: number }>(
    (ok, fail) => {
      let buf = "";
      const timer = setTimeout(
        () => fail(new Error(`${t.name}: no "gateway listening" in 30 s\n${buf}`)),
        30_000,
      );
      child.stderr?.on("data", (d) => {
        buf += String(d);
        const m = /"msg":"gateway listening","origin":"(http:\/\/127\.0\.0\.1:\d+)"/.exec(buf);
        if (m) {
          clearTimeout(timer);
          ok({ origin: m[1] as string, listenMs: performance.now() - t0 });
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        fail(new Error(`${t.name} exited ${code}\n${buf}`));
      });
    },
  );
  for (;;) {
    const r = await fetch(`${origin}/healthz`).catch(() => null);
    if (r?.ok) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  const healthMs = performance.now() - t0;
  return {
    child,
    origin,
    listenMs,
    healthMs,
    stop: () =>
      new Promise((done) => {
        child.removeAllListeners("exit");
        child.once("exit", () => {
          children.delete(child);
          done();
        });
        child.kill("SIGTERM");
      }),
  };
}

function rssMb(pid: number): number {
  return Math.round(
    Number(
      execFileSync("/bin/ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim(),
    ) / 1024,
  );
}

/** An OpenAI-compatible server that streams one scripted reply to every chat request. */
async function scriptedModelServer(): Promise<{ url: string; close(): void }> {
  const chunk = (delta: Record<string, unknown>, finish: string | null, usage?: unknown) =>
    `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "scripted", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => {
      body += d;
    });
    req.on("end", () => {
      if (req.url?.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "scripted", object: "model" }] }));
        return;
      }
      const stream = (JSON.parse(body || "{}") as { stream?: boolean }).stream === true;
      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
      if (!stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "c1",
            object: "chat.completion",
            created: 0,
            model: "scripted",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "Scripted title" },
                finish_reason: "stop",
              },
            ],
            usage,
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(chunk({ role: "assistant", content: "Hello" }, null));
      res.write(chunk({ content: " from the scripted model." }, null));
      res.write(chunk({}, "stop", usage));
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}/v1`, close: () => server.close() };
}

/** Pairs like the desktop: loopback, the per-launch handshake secret, an Ed25519 device key. */
async function desktopClient(origin: string, home: string): Promise<Client> {
  const { privateKey } = generateKeyPairSync("ed25519");
  const publicKey = String(privateKey.export({ format: "jwk" }).x);
  const deviceId = `dev_${createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("base64url").slice(0, 22)}`;
  const handshakeSecret = readFileSync(join(home, "run", "handshake.secret"), "utf8").trim();
  const client = new Client(
    (onStatus, onEvent) =>
      new GatewayConnection({
        wsUrl: `${origin.replace("http", "ws")}/ws`,
        healthUrl: `${origin}/healthz`,
        connectParams: () => ({
          protocolVersion: { min: 1, max: PROTOCOL_VERSION },
          deviceId,
          publicKey,
          role: "client",
          platform: "macos",
          deviceFamily: "desktop",
          name: "perf",
          handshakeSecret,
        }),
        sign: (payload) => sign(null, payload, privateKey).toString("base64url"),
        onStatus,
        onEvent,
      }),
  );
  client.start();
  await client.until(() => client.status?.phase === "paired", "pairing", 15_000);
  return client;
}

describe.skipIf(!ENABLED)("psyched process startup (PSYCHE_PERF_TESTS=1)", () => {
  for (const t of targets()) {
    it(`${t.name}: cold and warm boot to /healthz, idle RSS`, async () => {
      const home = temp(`psyche-perf-${t.name}-`);
      const userHome = temp(`psyche-perf-user-${t.name}-`);
      const cold = await boot(t, home, userHome);
      await cold.stop();
      const warm: number[] = [];
      let last: Running | undefined;
      for (let i = 0; i < 3; i += 1) {
        last = await boot(t, home, userHome);
        warm.push(last.healthMs);
        if (i < 2) await last.stop();
      }
      await new Promise((r) => setTimeout(r, 3_000));
      const rss = rssMb(last?.child.pid as number);
      await last?.stop();
      results[t.name] = {
        ...results[t.name],
        coldBootMs: Math.round(cold.healthMs),
        warmBootMs: Math.round(median(warm)),
        idleRssMb: rss,
      };
      if (t.name === "built") {
        expect(results[t.name]?.warmBootMs).toBeLessThan(BUDGET.warmBootMs);
        expect(rss).toBeLessThan(BUDGET.idleRssMb);
      }
    }, 120_000);

    it(`${t.name}: cold start to the first chat token (scripted model)`, async () => {
      const model = await scriptedModelServer();
      const home = temp(`psyche-perf-chat-${t.name}-`);
      const userHome = temp(`psyche-perf-chatuser-${t.name}-`);
      const env = { PSYCHE_MODEL: "lmstudio/scripted", PSYCHE_LMSTUDIO_URL: model.url };
      try {
        const t0 = performance.now();
        const gw = await boot(t, home, userHome, env);
        const client = await desktopClient(gw.origin, home);
        const { thread } = await client.call<{ thread: { id: string } }>(
          "threads.create",
          { kind: "main" },
          true,
        );
        const deltas: number[] = [];
        let coldToFirst = 0;
        for (let i = 0; i < 3; i += 1) {
          const from = client.mark;
          const sent = performance.now();
          await client.call("chat.send", { threadId: thread.id, content: `ping ${i + 1}` }, true);
          await client.event("chat.delta", () => true, from, 30_000);
          if (i === 0) coldToFirst = performance.now() - t0;
          deltas.push(performance.now() - sent);
          await client.event<{ run: { status: string } }>(
            "run.updated",
            (p) => ["done", "failed", "cancelled"].includes(p.run.status),
            from,
            30_000,
          );
        }
        client.stop();
        await gw.stop();
        results[t.name] = {
          ...results[t.name],
          coldStartToFirstTokenMs: Math.round(coldToFirst),
          firstTokenMs: Math.round(median(deltas)),
        };
        if (t.name === "built") expect(coldToFirst).toBeLessThan(BUDGET.coldStartToFirstTokenMs);
      } finally {
        model.close();
      }
    }, 120_000);
  }

  it.skipIf(CHROMIUM === undefined)(
    "web client first contentful paint (headless Chrome)",
    async () => {
      const t = targets()[0] as Target;
      const home = temp("psyche-perf-web-");
      const gw = await boot(t, home, temp("psyche-perf-webuser-"));
      // @psyche/browser's own playwright-core (the acceptance package does not depend on it).
      const { chromium } = createRequire(import.meta.resolve("@psyche/browser"))(
        "playwright-core",
      ) as Playwright;
      const browser = await chromium.launch({ executablePath: CHROMIUM as string, headless: true });
      try {
        const samples: number[] = [];
        for (let i = 0; i < 3; i += 1) {
          const context = await browser.newContext();
          const page = await context.newPage();
          await page.goto(`${gw.origin}/`, { waitUntil: "load" });
          const fcp = await page.evaluate(
            () =>
              new Promise<number>((done) => {
                const seen = performance.getEntriesByName("first-contentful-paint")[0];
                if (seen) return done(seen.startTime);
                new PerformanceObserver((list) => {
                  const e = list.getEntriesByName("first-contentful-paint")[0];
                  if (e) done(e.startTime);
                }).observe({ type: "paint", buffered: true });
              }),
          );
          samples.push(fcp);
          await context.close();
        }
        results.web = { ...results.web, firstContentfulPaintMs: Math.round(median(samples)) };
        expect(results.web?.firstContentfulPaintMs).toBeLessThan(BUDGET.webFirstPaintMs);
      } finally {
        await browser.close();
        await gw.stop();
      }
    },
    120_000,
  );
  it.skipIf(!PACKAGED)(
    "packaged app: window to first paint (one launch, scratch everything)",
    async () => {
      if (PACKAGED_APP.startsWith("/Applications/")) throw new Error("refusing an installed app");
      const realHome = homedir();
      const owned = [
        join(realHome, "Library/Application Support/Psyche"),
        join(realHome, "Library/LaunchAgents/com.psyche.gateway.plist"),
        join(realHome, "Library/Preferences/com.psyche.desktop.plist"),
        join(realHome, "Library/Saved Application State/com.psyche.desktop.savedState"),
      ];
      const before = owned.map((p) => (existsSync(p) ? statSync(p).mtimeMs : null));
      const t = targets()[0] as Target;
      const home = temp("psyche-perf-app-");
      const userHome = temp("psyche-perf-appuser-");
      const gw = await boot(t, home, userHome);
      const file = join(temp("psyche-perf-paint-"), "first-paint.json");
      const spawnedAt = Date.now();
      const app = spawn(
        join(PACKAGED_APP, "Contents/MacOS/Psyche"),
        [
          "--use-mock-keychain",
          `--user-data-dir=${join(userHome, "userData")}`,
          // Launched from a test, the window is not frontmost; Chromium treats an occluded window
          // as hidden and does not paint it (the second packaged run, docs/archive/status/s22.md).
          "--disable-backgrounding-occluded-windows",
          "--disable-features=CalculateNativeWinOcclusion",
        ],
        {
          env: {
            PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
            HOME: userHome,
            CFFIXED_USER_HOME: userHome,
            PSYCHE_HOME: home,
            PSYCHE_GATEWAY_MODE: "external",
            PSYCHE_GATEWAY_ORIGIN: gw.origin,
            PSYCHE_PERF_FIRST_PAINT_FILE: file,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      children.add(app);
      let appLog = "";
      app.stdout?.on("data", (d) => {
        appLog += String(d);
      });
      app.stderr?.on("data", (d) => {
        appLog += String(d);
      });
      try {
        // The app writes each startup stage; `painted`, `no-paint` and `error` are final.
        type Record = {
          stage: string;
          mainStartAt: number;
          didFinishLoadAt?: number;
          firstContentfulPaintAt?: number;
        };
        const read = (): Record | undefined =>
          existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record) : undefined;
        const deadline = Date.now() + 30_000;
        let record = read();
        while (
          !["painted", "no-paint", "error"].includes(record?.stage ?? "") &&
          Date.now() < deadline
        ) {
          await new Promise((r) => setTimeout(r, 50));
          record = read();
        }
        if (record?.didFinishLoadAt !== undefined) {
          results.packaged = { didFinishLoadMs: record.didFinishLoadAt - spawnedAt };
        }
        if (record?.stage !== "painted" || record.firstContentfulPaintAt === undefined) {
          throw new Error(
            `no first paint: ${JSON.stringify(record ?? "no record")}\napp log:\n${appLog.slice(-4000)}`,
          );
        }
        results.packaged = {
          windowFirstPaintMs: record.firstContentfulPaintAt - spawnedAt,
          mainStartMs: record.mainStartAt - spawnedAt,
          didFinishLoadMs: (record.didFinishLoadAt ?? 0) - spawnedAt,
        };
        expect(results.packaged.windowFirstPaintMs).toBeLessThan(BUDGET.windowFirstPaintMs);
      } finally {
        if (app.exitCode === null) {
          await new Promise<void>((done) => {
            const t = setTimeout(() => {
              app.kill("SIGKILL");
              done();
            }, 10_000);
            app.once("exit", () => {
              clearTimeout(t);
              done();
            });
          });
        }
        children.delete(app);
        await gw.stop();
        // The measured copy leaves no LaunchServices registration behind.
        execFileSync(
          "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
          ["-u", PACKAGED_APP],
        );
      }
      const after = owned.map((p) => (existsSync(p) ? statSync(p).mtimeMs : null));
      expect(after).toEqual(before);
    },
    120_000,
  );
});
