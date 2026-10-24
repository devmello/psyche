/**
 * Live gate for #557: a real model (Haiku by default) answers a current-facts question through
 * the built-in `web.search` / `web.fetch` tools against the real web. Skipped unless
 * `PSYCHE_LIVE_TESTS=1` and `ANTHROPIC_API_KEY` are set. With `PSYCHE_SEARCH_BRAVE_KEY` it uses
 * Brave; otherwise DuckDuckGo's HTML endpoint (keyless, rate-limited).
 *
 *   set -a; . /path/to/psyche/.env; set +a
 *   PSYCHE_LIVE_TESTS=1 pnpm --filter @psyche/gateway exec vitest run test/web-tools.live.test.ts --maxWorkers=1
 *
 * Spends a few thousand tokens. The key is read through a test-only `KeySource` and never
 * printed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiSdkAdapter, type KeySource } from "@psyche/model-router";
import { ResolvedSecret } from "@psyche/protocol";
import { afterAll, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

const LIVE = process.env.PSYCHE_LIVE_TESTS === "1" && (process.env.ANTHROPIC_API_KEY ?? "") !== "";
const MODEL = process.env.PSYCHE_LIVE_ANTHROPIC_MODEL ?? "claude-haiku-5-5";

const envKeys: KeySource = {
  resolve: async (_profile, target) => {
    const v = process.env.ANTHROPIC_API_KEY;
    return v === undefined
      ? undefined
      : new ResolvedSecret(v, { credentialId: "env:ANTHROPIC_API_KEY", target });
  },
  redact: (t) => {
    const v = process.env.ANTHROPIC_API_KEY;
    return v === undefined || v.length === 0 ? t : t.split(v).join("•••");
  },
};

describe.skipIf(!LIVE)("live: web.search with Haiku (#557)", () => {
  let home = "";
  let composed: ComposedGateway | null = null;
  const clients: TestClient[] = [];

  afterAll(async () => {
    for (const c of clients) c.close();
    await composed?.stop("test");
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("finds the current Node.js LTS with web.search instead of saying it has no search tool", {
    timeout: 240_000,
  }, async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-web-live-"));
    const provider = new AiSdkAdapter(
      { id: "anthropic", kind: "anthropic", profiles: [{ id: "env", credential: "{{cred:env}}" }] },
      { keys: envKeys },
    );
    const env: Record<string, string> = {};
    if (process.env.PSYCHE_SEARCH_BRAVE_KEY)
      env.PSYCHE_SEARCH_BRAVE_KEY = process.env.PSYCHE_SEARCH_BRAVE_KEY;
    composed = await composeGateway({
      env,
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      timeZone: "UTC",
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider, model: `anthropic/${MODEL}` },
    });
    const owner = await adminClient(composed.gateway);
    clients.push(owner);
    const { thread } = await owner.call<{ thread: { id: string } }>(
      "threads.create",
      { kind: "main" },
      ik(),
    );
    await owner.call(
      "chat.send",
      {
        threadId: thread.id,
        content:
          "What is the current Node.js LTS version? Look it up, then answer in one sentence.",
      },
      ik(),
    );

    // Approve any read card (a new origin for web.fetch) until the run settles.
    const answered = new Set<string>();
    const until = Date.now() + 200_000;
    const settled = () =>
      owner.events.some((e) => {
        if (e.event !== "run.updated") return false;
        const s = (e.payload as { run: { status: string } }).run.status;
        return s === "done" || s === "failed" || s === "cancelled";
      });
    while (!settled()) {
      if (Date.now() > until) throw new Error("the live turn did not finish");
      const card = owner.events
        .filter((e) => e.event === "approval.created")
        .map((e) => e.payload as { approval: { id: string }; answerToken?: string })
        .find((p) => !answered.has(p.approval.id) && p.answerToken !== undefined);
      if (card === undefined) {
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      answered.add(card.approval.id);
      await new Promise((r) => setTimeout(r, 450));
      await owner.call("approvals.answer", {
        approvalId: card.approval.id,
        answerToken: card.answerToken,
        decision: "approve",
        scope: "once",
      });
    }

    if (process.env.PSYCHE_LIVE_DEBUG === "1") {
      for (const e of owner.events) {
        if (
          e.event === "run.updated" ||
          e.event === "tool_call.updated" ||
          e.event === "chat.message"
        )
          console.warn(e.event, JSON.stringify(e.payload).slice(0, 400));
      }
    }
    const calls = owner.events
      .filter((e) => e.event === "tool_call.updated")
      .map((e) => (e.payload as { toolCall: { tool: string; status: string } }).toolCall);
    expect(calls.some((c) => c.tool === "web.search" && c.status === "ok")).toBe(true);
    const reply = owner.events
      .filter((e) => e.event === "chat.message")
      .map(
        (e) => e.payload as { message: { role: string; blocks: { type: string; md?: string }[] } },
      )
      .filter((p) => p.message.role === "agent")
      .flatMap((p) => p.message.blocks.map((b) => b.md ?? ""))
      .join("\n");
    expect(reply).not.toMatch(/don'?t have (a|any) (web )?search/i);
    expect(reply).toMatch(/\b(2[0-9]|3[0-9])\b/); // an LTS major such as 22 or 24
  });
});
