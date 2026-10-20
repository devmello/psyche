import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelEvent, ModelRequest } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { PLUGINS_SETTING } from "../src/compose/plugins.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/**
 * T4 scenario on the composed Gateway: the owner installs a code plugin through the skill trust
 * card, switches it on, and turns plugins on. The plugin (its own restricted Node process) adds
 * office hours to the prompt as untrusted context and blocks a notification; turning the setting
 * off stops it.
 */

const FIXTURE = fileURLToPath(
  new URL("../../../packages/plugins/test/fixtures/office-hours", import.meta.url),
);
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 };
const call = (id: string, name: string, input: unknown): ModelEvent[] => [
  { type: "tool_call", id, name, input },
  { type: "usage", usage },
  { type: "finish", reason: "tool_calls" },
];
const say = (text: string): ModelEvent[] => [
  { type: "text_delta", text },
  { type: "usage", usage },
  { type: "finish", reason: "stop" },
];

let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

interface Card {
  approval: { id: string; kind: string; summary: string; details: Record<string, unknown> };
  answerToken?: string;
}

describe("code plugins in the Gateway (T4)", () => {
  it("installs through the trust card and runs only while plugins are on", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-plugins-gw-"));
    const model = new FakeModelProvider({ capabilities: { contextWindow: 200_000 } });
    model.script([
      call("c1", "notify", { title: "Report ready", body: "The weekly report is ready." }),
      say("I'll tell you during office hours."),
    ]);
    composed = await composeGateway({
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: model, model: "fake/model" },
    });
    const owner = await adminClient(composed.gateway);
    clients.push(owner);
    const source = join(home, "office-hours-src");
    cpSync(FIXTURE, source, { recursive: true });

    // 1. The trust card: a device-only skill_install that says it is a plugin.
    const proposed = await owner.call<{ proposal: { id: string }; approval: { id: string } }>(
      "plugins.proposeInstall",
      { path: source },
      ik(),
    );
    let card: Card | undefined;
    await vi.waitFor(() => {
      card = owner.events
        .filter((e) => e.event === "approval.created")
        .map((e) => e.payload as Card)
        .find((p) => p.approval.id === proposed.approval.id && p.answerToken !== undefined);
      expect(card).toBeDefined();
    });
    expect(card?.approval).toMatchObject({
      kind: "skill_install",
      summary: 'Install plugin "office-hours" 1.0.0',
      details: { kind: "plugin", capabilities: ["before_tool_call", "context"] },
    });
    await new Promise((r) => setTimeout(r, 450)); // cards arm after 400 ms
    await owner.call("approvals.answer", {
      approvalId: proposed.approval.id,
      answerToken: card?.answerToken,
      decision: "approve",
      scope: "once",
    });
    const installed = await owner.call<{ plugin: { status: string; enabled: boolean } }>(
      "plugins.install",
      { proposalId: proposed.proposal.id, approvalId: proposed.approval.id },
      ik(),
    );
    expect(installed.plugin).toMatchObject({ enabled: false, status: "disabled" });

    // 2. Its own switch on, plugins still off: nothing runs.
    await owner.call("plugins.setEnabled", { name: "office-hours", enabled: true }, ik());
    expect(await owner.call("plugins.list", {})).toMatchObject({
      enabled: false,
      plugins: [{ name: "office-hours", status: "off" }],
    });
    expect(composed.loop.plugins.list()).toEqual([]);

    // 3. Plugins on: the process starts and joins the loop.
    await owner.call("settings.set", { key: PLUGINS_SETTING, value: true }, ik());
    await vi.waitFor(async () => {
      expect(await owner.call("plugins.list", {})).toMatchObject({
        enabled: true,
        plugins: [{ status: "active" }],
      });
    });

    // 4. A turn: untrusted office-hours context, and the notification is held.
    const { thread } = await owner.call<{ thread: { id: string } }>(
      "threads.create",
      { kind: "main" },
      ik(),
    );
    await owner.call(
      "chat.send",
      { threadId: thread.id, content: "Tell me when the report is ready." },
      ik(),
    );
    await composed.gateway.context.sessions.idle();
    const first = model.requests[0] as ModelRequest;
    expect(first.system).toContain('source="plugin:office-hours" provenance="untrusted"');
    expect(first.system).toContain("The owner works 09:00-17:00 Pacific.");
    const last = model.requests.at(-1) as ModelRequest;
    expect(JSON.stringify(last.messages)).toContain(
      "blocked by plugin office-hours: notifications wait until office hours",
    );
    const sent = (await composed.notifier.list()).filter((n) => n.title === "Report ready");
    expect(sent).toEqual([]);

    // 5. Plugins off again: the process stops and leaves the loop.
    await owner.call("settings.set", { key: PLUGINS_SETTING, value: false }, ik());
    await vi.waitFor(() => expect(composed?.loop.plugins.list()).toEqual([]));
  }, 30_000);
});
