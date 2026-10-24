import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockBrowser, MockDesktop } from "@psyche/browser/testing";
import {
  type ComposedBrowser,
  type ComposeServices,
  composeBrowser,
} from "@psyche/gateway/compose";
import type { ModelRequest } from "@psyche/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Client, type Skeleton, startSkeleton } from "../walking-skeleton/harness.ts";
import { calls, MAIN, ScriptedModel, say } from "../walking-skeleton/scripted-model.ts";

/**
 * Pause-when-unwatched (#272) in the composed Gateway: the browser part reads the owner's
 * attention from `ComposeServices.attention` (the Gateway's half, S01) and the bundled
 * sensitive-category list from the broker's policy. A mock desktop is attached (the browser tools
 * are offered only with one, #556), its fixture hosts standing in for a sensitive site
 * (accounts.google.com) and an ordinary one (example.com). What matters is whether the attention
 * check refused a call before any page work.
 */
type Json = Record<string, unknown>;

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

describe("#272: the browser's sensitive origins in the composed Gateway", () => {
  const model = new ScriptedModel();
  let services: ComposeServices;
  let sk: Skeleton;
  let c: Client;
  let threadId = "";
  let browser: ComposedBrowser;
  let desktop: MockDesktop;
  let dir = "";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "psyche-att-"));
    sk = await startSkeleton({
      model: { provider: model, model: MAIN },
      parts: [
        (s) => {
          services = s;
          browser = composeBrowser(s, { socketPath: false });
          return browser;
        },
      ],
    });
    c = sk.client;
    const fixture = new MockBrowser();
    fixture.origin = (h) =>
      h === "a"
        ? "https://accounts.google.com"
        : h === "b"
          ? "https://example.com"
          : "https://evil.example.org";
    desktop = new MockDesktop({ browser: fixture, quarantineDir: dir });
    browser.attach(await desktop.connect());
    const { thread } = await c.call<{ thread: { id: string } }>(
      "threads.create",
      { kind: "main" },
      true,
    );
    threadId = thread.id;
  }, 30_000);
  afterAll(async () => {
    desktop?.disconnect();
    await sk?.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  /** One scripted turn that opens `url`; approves whatever card comes; returns the tool result. */
  async function openTab(url: string): Promise<Json> {
    let result: Json | undefined;
    model.chat.script([
      calls(["o1", "browser.open_tab", { url }]),
      (req) => {
        result = lastResult(req);
        return say("done");
      },
    ]);
    const from = c.mark;
    await c.call("chat.send", { threadId, content: `open ${url}` }, true);
    const seen = new Set<string>();
    while (result === undefined) {
      const next = c.events
        .slice(from)
        .filter((e) => e.event === "approval.created")
        .map((e) => (e.payload as { approval: { id: string } }).approval)
        .find((a) => !seen.has(a.id));
      if (next === undefined) {
        await new Promise((r) => setTimeout(r, 25));
        continue;
      }
      seen.add(next.id);
      const { answerToken } = await c.call<{ answerToken?: string }>("approvals.get", {
        approvalId: next.id,
      });
      await new Promise((r) => setTimeout(r, 600));
      await c.call("approvals.answer", {
        approvalId: next.id,
        answerToken,
        decision: "approve",
        scope: "once",
      });
    }
    await c.event("chat.message", (p: Json) => JSON.stringify(p).includes("done"), from, 15_000);
    return result;
  }

  it("parks on a sensitive site (accounts.google.com, bundled list) with the pane hidden", async () => {
    // The owner's chat message counts as input, so the pane decides here: the desktop reports it
    // hidden (window minimized).
    services.attention.report("browser", false, false);
    const r = await openTab("https://accounts.google.com/");
    expect(r).toMatchObject({
      error: {
        code: "presence_required",
        details: { reason: "awaiting_attention", paneVisible: false },
      },
    });
  });

  it("leaves ordinary sites alone, and sensitive ones once the owner is watching", async () => {
    services.attention.report("browser", false, false);
    const plain = await openTab("https://example.com/");
    expect(plain.error).toBeUndefined();
    expect((plain.tab as Json | undefined)?.url).toBe("https://example.com/");

    services.attention.report("browser", true, true);
    const watched = await openTab("https://accounts.google.com/");
    expect(watched.error).toBeUndefined();
    expect((watched.tab as Json | undefined)?.url).toBe("https://accounts.google.com/");
  });
});
