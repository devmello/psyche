import { statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FrameConnection } from "@psyche/browser";
import { MockBrowser, MockDesktop } from "@psyche/browser/testing";
import { type ComposedBrowser, composeBrowser } from "@psyche/gateway/compose";
import { type ModelRequest, PROTOCOL_VERSION } from "@psyche/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Client, type Skeleton, startSkeleton } from "../walking-skeleton/harness.ts";
import { calls, MAIN, ScriptedModel, say } from "../walking-skeleton/scripted-model.ts";
import { SHOPS } from "./shops.ts";

/**
 * INT-2 scenario 1 (CI-safe part): the browser from chat. The real composed Gateway drives the
 * fixture shops through the desktop bridge protocol (`MockDesktop` stands in for the Electron
 * `WebContentsView`s and enforces the same CDP allowlist). The scripted model plays the agent.
 */

type Json = Record<string, unknown>;
interface Approval {
  id: string;
  kind: string;
  status: string;
  sideEffect: string;
  scopesOffered: string[];
  surfaces: string[];
  summary?: string;
  target?: { kind: string; value: string };
  details?: Json;
}

/** The output of the newest tool result the model sees. */
function lastResult(req: ModelRequest): Json {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const parts = req.messages[i]?.parts ?? [];
    for (let j = parts.length - 1; j >= 0; j--) {
      const p = parts[j];
      if (p?.type === "tool_result") return p.output as Json;
    }
  }
  throw new Error("no tool result yet");
}

function refOf(req: ModelRequest, name: string): string {
  const text = String(lastResult(req).snapshot ?? "");
  const m = new RegExp(`"${name}"[^\\n]*?\\[ref=(ref_\\d+)\\]`).exec(text);
  if (m?.[1] === undefined) {
    throw new Error(`no ref for ${name} in:\n${text}`);
  }
  return m[1];
}

const timings: Record<string, number> = {};

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}
const approvalRoundTrips: number[] = [];
const prices: string[] = [];
const asked: Approval[] = [];
let refused = "";

async function answer(c: Client, approvalId: string, decision: "approve" | "deny") {
  const { answerToken } = await c.call<{ answerToken?: string }>("approvals.get", { approvalId });
  expect(answerToken).toBeTruthy();
  // The card arms after a short delay (docs/06); an earlier answer is refused.
  await new Promise((r) => setTimeout(r, 600));
  const t0 = performance.now();
  await c.call("approvals.answer", { approvalId, answerToken, decision, scope: "once" });
  return t0;
}

/** Approve every new non-financial card from `from` on until `done` holds. */
async function approveUntil(c: Client, from: number, done: () => boolean): Promise<void> {
  const seen = new Set<string>();
  while (!done()) {
    const next = c.events
      .slice(from)
      .filter((e) => e.event === "approval.created")
      .map((e) => (e.payload as { approval: Approval }).approval)
      .find((a) => !seen.has(a.id) && a.sideEffect !== "financial");
    if (next === undefined) {
      await new Promise((r) => setTimeout(r, 25));
      continue;
    }
    seen.add(next.id);
    await answer(c, next.id, "approve");
  }
}

const said = (c: Client, from: number, text: string) => () =>
  c.events
    .slice(from)
    .some((e) => e.event === "chat.message" && JSON.stringify(e.payload).includes(text));

describe("INT-2 scenario 1: browser from chat", () => {
  const model = new ScriptedModel();
  let sk: Skeleton;
  let c: Client;
  let browser: ComposedBrowser;
  let desktop: MockDesktop;
  let dir: string;
  let threadId = "";
  let tabId = "";
  const statuses: Json[] = [];
  const A = () => desktop.browser.origin("a");
  const B = () => desktop.browser.origin("b");

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "psyche-int2-dl-"));
    const shops = new MockBrowser({ site: SHOPS });
    // Public-looking origins: the broker refuses loopback targets that are not the owner's
    // project (security prohibitions), and the mock never resolves names.
    shops.origin = (h) =>
      h === "a"
        ? "https://shop-a.example.com"
        : h === "b"
          ? "https://shop-b.example.net"
          : "https://evil.example.org";
    desktop = new MockDesktop({ browser: shops, quarantineDir: dir });
    sk = await startSkeleton({
      model: { provider: model, model: MAIN },
      parts: [
        (s) => {
          // An empty origin set: each shop needs a new-origin approval.
          browser = composeBrowser(s, { socketPath: false, record: true });
          return browser;
        },
      ],
    });
    c = sk.client;
    const gatewaySide = await desktop.connect();
    // What the desktop is asked to display (status pill, highlight).
    const call = gatewaySide.call.bind(gatewaySide);
    gatewaySide.call = ((method: string, params: Json) => {
      if (method === "bridge.tab.status") statuses.push(params);
      return call(method as never, params as never);
    }) as typeof gatewaySide.call;
    browser.attach(gatewaySide);
    const { thread } = await c.call<{ thread: { id: string } }>(
      "threads.create",
      { kind: "main" },
      true,
    );
    threadId = thread.id;
  });

  afterAll(async () => {
    // biome-ignore lint/suspicious/noConsole: the timings go to docs/status (INT-2).
    console.log(`INT-2 browser timings ${JSON.stringify(timings)}`);
    desktop?.disconnect();
    await sk?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("compares both shops, holds the cheaper stand in a cart and stops at checkout", async () => {
    model.chat.script([
      calls(["b1", "browser.open_tab", { url: `${A()}/` }]),
      (req) => {
        tabId = String((lastResult(req).tab as Json).id);
        return calls(["b2", "browser.snapshot", { tabId }]);
      },
      (req) =>
        calls([
          "b3",
          "browser.type",
          { tabId, ref: refOf(req, "Search products"), text: "13-inch laptop stand", submit: true },
        ]),
      () => calls(["b4w", "browser.wait", { tabId, for: { kind: "text", text: "Results" } }]),
      () => calls(["b4", "browser.snapshot", { tabId }]),
      (req) => {
        prices.push(String(lastResult(req).snapshot).match(/\$\d+\.\d\d/)?.[0] ?? "");
        return calls(["b5", "browser.navigate", { tabId, url: `${B()}/` }]);
      },
      () => calls(["b6", "browser.snapshot", { tabId }]),
      (req) =>
        calls([
          "b7",
          "browser.type",
          { tabId, ref: refOf(req, "Search products"), text: "13-inch laptop stand", submit: true },
        ]),
      () => calls(["b8w", "browser.wait", { tabId, for: { kind: "text", text: "Results" } }]),
      () => calls(["b8", "browser.snapshot", { tabId }]),
      (req) => {
        prices.push(String(lastResult(req).snapshot).match(/\$\d+\.\d\d/)?.[0] ?? "");
        return calls([
          "b9",
          "browser.click",
          { tabId, target: { ref: refOf(req, "Add to cart") } },
        ]);
      },
      () => calls(["b10w", "browser.wait", { tabId, for: { kind: "text", text: "Your cart" } }]),
      () => calls(["b10", "browser.snapshot", { tabId }]),
      (req) =>
        calls(["b11", "browser.click", { tabId, target: { ref: refOf(req, "Place order") } }]),
      say(
        "Stand Shop B has it for $29.00 (Shop A: $39.00). It is in the cart: 1 × Laptop Stand 13-inch, total $29.00. I stopped before checkout.",
      ),
    ]);
    const from = c.mark;
    await c.call(
      "chat.send",
      {
        threadId,
        content: `Find the cheapest 13-inch laptop stand on ${A()} and ${B()} and hold the best one in a cart`,
      },
      true,
    );
    // The owner answers each card as it arrives; the purchase card is declined (M3 hand-off).
    const seen = new Set<string>();
    let purchase: Approval | undefined;
    while (purchase === undefined) {
      const next = await c.event<{ approval: Approval }>(
        "approval.created",
        (p) => !seen.has(p.approval.id),
        from,
        15_000,
      );
      const a = next.approval;
      seen.add(a.id);
      asked.push(a);
      if (a.sideEffect === "financial") {
        purchase = a;
        await answer(c, a.id, "deny");
      } else {
        const t0 = await answer(c, a.id, "approve");
        await c.event(
          "approval.updated",
          (p: { approval: Approval }) => p.approval.id === a.id,
          from,
        );
        approvalRoundTrips.push(performance.now() - t0);
      }
    }
    await c.event(
      "chat.message",
      (p) => JSON.stringify(p).includes("stopped before checkout"),
      from,
    );

    expect(prices).toEqual(["$39.00", "$29.00"]);
    // Both shops were new origins and asked before any page was loaded there.
    for (const origin of [A(), B()]) {
      expect(asked.some((a) => a.target?.kind === "origin" && a.target.value === origin)).toBe(
        true,
      );
    }
    // Checkout is a purchase: once only, device surfaces only (never chat), bound to shop B.
    expect(purchase.scopesOffered).toEqual(["once"]);
    expect(purchase.surfaces.every((sf) => !sf.includes(":"))).toBe(true);
    expect(purchase.target).toEqual({ kind: "origin", value: B() });
    expect(desktop.tab(tabId).url).toBe(`${B()}/cart`);
    expect(desktop.browser.submissions.some((sub) => sub.path === "/checkout")).toBe(false);
    timings.approvalCards = asked.length;
  });

  it("showed the status pill and highlighted the element acted on", () => {
    expect(statuses.some((s) => s.text === "Typing")).toBe(true);
    expect(statuses.some((s) => s.text === "Clicking" && s.highlight !== undefined)).toBe(true);
  });

  it("hands control to the owner and takes it back; refs are re-read after", async () => {
    desktop.takeControl(tabId);
    await waitFor(async () => {
      const { tabs } = await c.call<{ tabs: { tabId: string; controller: string }[] }>(
        "browser.tabs",
        {},
      );
      return tabs.find((t) => t.tabId === tabId)?.controller === "user";
    });
    model.chat.script([
      // Reads still work while the owner holds the tab; input is refused.
      () => calls(["t1", "browser.press", { tabId, keys: "Tab" }]),
      (req) => {
        refused = JSON.stringify(lastResult(req));
        return say("You have the browser; tell me when you are done.");
      },
    ]);
    const from = c.mark;
    await c.call("chat.send", { threadId, content: "Let me sign in first" }, true);
    await approveUntil(c, from, said(c, from, "You have the browser"));
    expect(refused).toContain("user_in_control");
    // The owner types their own login in the pane (the agent never sees the password).
    desktop.release(tabId);
    model.chat.script([
      () => calls(["t2", "browser.snapshot", { tabId }]),
      (req) => {
        expect(lastResult(req).snapshot).toBeDefined();
        return say("Back in control; the cart still holds the stand.");
      },
    ]);
    const again = c.mark;
    await c.call("chat.send", { threadId, content: "Done, continue" }, true);
    await approveUntil(c, again, said(c, again, "Back in control"));
  });

  it("keeps the run going when the desktop client goes away (pane or window closed)", async () => {
    model.chat.script([
      () => calls(["k1", "browser.snapshot", { tabId }]),
      say("Still holding the cart at Stand Shop B."),
    ]);
    await c.call("chat.send", { threadId, content: "Are we still good?" }, true);
    // The window closes mid-turn; the run keeps going and the next window sees the answer.
    c.stop();
    const back = await sk.connect();
    c = back;
    void approveUntil(back, 0, said(back, 0, "Still holding the cart")).catch(() => undefined);
    await waitFor(async () =>
      JSON.stringify(await back.call("chat.history", { threadId })).includes(
        "Still holding the cart",
      ),
    );
  });

  it("Activity has every browser action, and the session was recorded for replay", async () => {
    const { receipts } = await c.call<{ receipts: Json[] }>("receipts.list", {});
    const history = await c.call<{ messages: Json[] }>("chat.history", { threadId });
    const text = JSON.stringify(history);
    for (const tool of ["browser.open_tab", "browser.type", "browser.navigate", "browser.click"]) {
      expect(text).toContain(tool);
    }
    expect(Array.isArray(receipts)).toBe(true);
    const rec = browser.recordings.get(`thread:${threadId}`);
    expect(rec).toBeDefined();
    await new Promise((r) => setTimeout(r, 300));
    expect(rec?.index.frames.length ?? 0).toBeGreaterThan(0);
    const t0 = performance.now();
    await browser.driver?.snapshot(tabId);
    timings.snapshotMs = Math.round(performance.now() - t0);
    timings.approvalAnswerToUpdateMsMax = Math.round(Math.max(...approvalRoundTrips));
    expect(timings.snapshotMs).toBeLessThan(300);
  });
});

describe("the bridge socket", () => {
  it("accepts the desktop's bridge.hello with the Gateway's handshake secret only", async () => {
    const model = new ScriptedModel();
    const socketPath = join("/tmp", `psyche-int2-${process.pid}.sock`);
    let b: ComposedBrowser | undefined;
    const sk = await startSkeleton({
      model: { provider: model, model: MAIN },
      parts: [
        (s) => {
          b = composeBrowser(s, { socketPath });
          return b;
        },
      ],
    });
    try {
      const hello = (secret: string) =>
        new Promise<unknown>((resolve, reject) => {
          const sock = createConnection(socketPath);
          const conn = new FrameConnection(sock, {});
          sock.once("connect", () => {
            conn
              .request("bridge.hello", {
                protocolVersion: PROTOCOL_VERSION,
                handshakeSecret: secret,
                desktopVersion: "int-2",
              })
              .then(resolve, reject);
          });
          sock.once("error", reject);
        });
      await expect(hello("wrong")).rejects.toThrow();
      expect(b?.driver).toBeUndefined();
      await expect(hello(sk.composed.gateway.handshakeSecret)).resolves.toMatchObject({
        protocolVersion: PROTOCOL_VERSION,
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(b?.driver).toBeDefined();
      // The socket is the owner's only (0600).
      const mode = statSync(socketPath).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      await sk.stop();
    }
  });
});
