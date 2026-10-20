import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CdpBridgeDriver,
  createRoutingDriver,
  FsQuarantineWriter,
  OriginPolicy,
  type RealChrome,
  type RealChromeOptions,
} from "@psyche/browser";
import { MockDesktop } from "@psyche/browser/testing";
import {
  type ComposedBrowser,
  type ComposeServices,
  composeBrowser,
  createRealChromeMode,
} from "@psyche/gateway/compose";
import { canonicalUrl } from "@psyche/permissions";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Skeleton, startSkeleton } from "../walking-skeleton/harness.ts";
import { calls, MAIN, ScriptedModel, say } from "../walking-skeleton/scripted-model.ts";

/**
 * Real-Chrome mode (I13) in the composed Gateway, with a fake Chrome process (no browser runs
 * here; the real-Chrome proof is `packages/browser` behind PSYCHE_BROWSER_TESTS=1).
 */
type Json = Record<string, unknown>;

/** A Chrome that never existed: the launcher's contract without a process. */
function fakeChrome(port: number, launches: RealChromeOptions[]) {
  return async (options: RealChromeOptions): Promise<RealChrome> => {
    launches.push(options);
    let running = true;
    const exits = new Set<() => void>();
    const chrome: RealChrome & { crash(): void } = {
      endpoint: `ws://127.0.0.1:${port}/devtools/browser/fake`,
      port,
      pid: 999_999,
      userDataDir: join(options.psycheHome ?? "/nonexistent", "browser", "real-chrome", "default"),
      startedAt: Date.now(),
      get running() {
        return running;
      },
      onExit(l) {
        exits.add(l);
      },
      async close() {
        running = false;
      },
      crash() {
        running = false;
        for (const l of exits) l();
      },
    };
    lastChrome = chrome;
    return chrome;
  };
}
let lastChrome: (RealChrome & { crash(): void }) | undefined;

describe("I13: real-Chrome consent through the real broker", () => {
  const model = new ScriptedModel();
  const launches: RealChromeOptions[] = [];
  let sk: Skeleton;
  let browser: ComposedBrowser;
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "psyche-i13-"));
    const chromeDesktop = new MockDesktop({ quarantineDir: dir });
    const chromeDriver = new CdpBridgeDriver(await chromeDesktop.connect(), {
      library: new FsQuarantineWriter(join(dir, "lib")),
    });
    sk = await startSkeleton({
      model: { provider: model, model: MAIN },
      parts: [
        (s) => {
          browser = composeBrowser(s, {
            socketPath: false,
            realChrome: {
              enabled: true,
              launch: fakeChrome(47_311, launches),
              connect: () => chromeDriver,
            },
          });
          return browser;
        },
      ],
    });
  }, 30_000);
  afterAll(async () => {
    await sk?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("asks once, on the owner's device, with presence; without it Chrome never starts", async () => {
    const c = sk.client;
    const { thread } = await c.call<{ thread: { id: string } }>(
      "threads.create",
      { kind: "main" },
      true,
    );
    model.chat.script([
      calls([
        "r1",
        "browser.use_real_chrome",
        { url: "https://shop-b.example.net/", reason: "1Password signs you in there" },
      ]),
      say("I could not use your Chrome."),
    ]);
    const from = c.mark;
    await c.call(
      "chat.send",
      { threadId: thread.id, content: "Sign in to shop B with 1Password" },
      true,
    );
    const { approval } = await c.event<{ approval: Json }>(
      "approval.created",
      () => true,
      from,
      15_000,
    );
    expect(approval).toMatchObject({
      kind: "policy_change",
      sideEffect: "destructive",
      deviceOnly: true,
      requiresAuthentication: true,
      scopesOffered: ["once"],
      target: { kind: "app", value: "chrome" },
    });
    expect(String(approval.summary)).toContain("1Password signs you in there");
    expect((approval.surfaces as string[]).every((s) => !s.includes(":"))).toBe(true);

    const { answerToken } = await c.call<{ answerToken?: string }>("approvals.get", {
      approvalId: approval.id,
    });
    await new Promise((r) => setTimeout(r, 600));
    // No Touch ID or passkey: an approval is refused (presence fails closed until S14/S01).
    await expect(
      c.call("approvals.answer", {
        approvalId: approval.id,
        answerToken,
        decision: "approve",
        scope: "once",
      }),
    ).rejects.toThrow();
    await c.call("approvals.answer", {
      approvalId: approval.id,
      answerToken,
      decision: "deny",
      scope: "once",
    });
    await c.event(
      "chat.message",
      (p: Json) => JSON.stringify(p).includes("could not use your Chrome"),
      from,
      15_000,
    );
    expect(launches).toHaveLength(0);
    expect(browser.realChrome.status()).toEqual({ attached: false, sessions: 0 });
  });
});

describe("I13: real-Chrome lifecycle in the composition", () => {
  let sk: Skeleton;
  let services: ComposeServices;
  let browser: ComposedBrowser;
  let dir: string;
  const launches: RealChromeOptions[] = [];
  const port = 47_312;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "psyche-i13b-"));
    sk = await startSkeleton({
      model: { provider: new ScriptedModel(), model: MAIN },
      parts: [
        (s) => {
          services = s;
          browser = composeBrowser(s, { socketPath: false });
          return browser;
        },
      ],
    });
  }, 30_000);
  afterAll(async () => {
    await sk?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("registers the DevTools port as Psyche's own, shows the indicator, and cleans up", async () => {
    const chromeDesktop = new MockDesktop({ quarantineDir: dir });
    const chromeClient = await chromeDesktop.connect();
    const library = new FsQuarantineWriter(join(dir, "lib"));
    const router = createRoutingDriver(() => {
      throw new Error("no desktop");
    });
    const mode = createRealChromeMode({
      services,
      router,
      setup: {
        enabled: true,
        launch: fakeChrome(port, launches),
        connect: () => new CdpBridgeDriver(chromeClient, { library }),
      },
      library,
      broker: services.broker,
      keyFor: (callId) => `task_${callId}`,
      policyFor: () => new OriginPolicy(),
      taskIdFor: (callId) => `task_${callId}`,
    });
    const s1 = await mode.attach("a");
    const s2 = await mode.attach("b");
    expect(s2).not.toBe(s1);
    expect(await mode.attach("a")).toBe(s1);
    expect(launches).toHaveLength(1);
    expect(launches[0]?.psycheHome).toBe(services.home);
    expect(services.ownPorts.list()).toContain(port);
    // The localhost rule refuses the DevTools port, whoever asks.
    expect(await browser.localProject.check(canonicalUrl(`http://127.0.0.1:${port}/json`))).toEqual(
      {
        ok: false,
        reason: "psyche_port",
      },
    );
    expect(mode.status()).toMatchObject({ attached: true, port, pid: 999_999, sessions: 2 });
    const indicator = (await sk.composed.notifier.list({ unresolvedOnly: true })).find(
      (n) => n.title === "Psyche is driving your Chrome",
    );
    expect(indicator).toBeDefined();

    expect(await mode.detach("a")).toBe(true);
    expect(mode.status().attached).toBe(true);
    expect(await mode.detach("b")).toBe(true);
    expect(await mode.detach("b")).toBe(false);
    expect(mode.status()).toEqual({ attached: false, sessions: 0 });
    expect(services.ownPorts.list()).not.toContain(port);
    expect(lastChrome?.running).toBe(false);
    expect(
      (await sk.composed.notifier.list({ unresolvedOnly: true })).some(
        (n) => n.title === "Psyche is driving your Chrome",
      ),
    ).toBe(false);

    // Chrome quits on its own: everything is torn down as well.
    await mode.attach("c");
    expect(services.ownPorts.list()).toContain(port);
    lastChrome?.crash();
    await new Promise((r) => setTimeout(r, 20));
    expect(mode.status().attached).toBe(false);
    expect(services.ownPorts.list()).not.toContain(port);
    expect(mode.attached("c")).toBeUndefined();
    chromeDesktop.disconnect();
  });
});
