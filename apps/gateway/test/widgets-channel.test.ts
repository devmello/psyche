import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryCursorStore } from "@psyche/channels";
import type { ModelEvent } from "@psyche/protocol";
import { FakeMessagesNode, FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ComposedChannels, composeChannels } from "../src/compose/channels.ts";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import type { ComposeServices } from "../src/compose/services.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/** Widgets in a channel (generative-ui-2026 §8): the owner gets a text fallback, never a widget. */

const ACCOUNT = "psyche@icloud.com";
const OWNER = "+15550001111";
const OWNER_CHAT = `iMessage;-;${OWNER}`;
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 };
const say = (text: string): ModelEvent[] => [
  { type: "text_delta", text },
  { type: "usage", usage },
  { type: "finish", reason: "stop" },
];
// FakeMessagesNode stamps rows from 2026-10-19T12:00Z; the Gateway's clock runs from there.
const BASE = Date.parse("2026-10-19T12:00:00.000Z");
const started = Date.now();
const clock = { now: () => BASE + (Date.now() - started) };

let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

async function setup(model: FakeModelProvider) {
  home = mkdtempSync(join(tmpdir(), "psyche-imessage-"));
  const node = new FakeMessagesNode();
  let channels: ComposedChannels | undefined;
  let services: ComposeServices | undefined;
  composed = await composeGateway({
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    clock,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: model, model: "fake/model" },
    parts: [
      (s) => {
        services = s;
        channels = composeChannels(s, {
          imessage: { account: ACCOUNT, node: () => node, cursor: new MemoryCursorStore() },
          healthIntervalMs: 0,
        });
        return channels;
      },
    ],
  });
  const owner = await adminClient(composed.gateway);
  clients.push(owner);
  await owner.call(
    "channels.configure",
    {
      type: "imessage",
      account: ACCOUNT,
      dmPolicy: "allowlist",
      allowFrom: [OWNER],
      ownerIds: [OWNER],
    },
    ik(),
  );
  await vi.waitFor(() =>
    expect(node.invocations.some((i) => i.capability === "messages.watch")).toBe(true),
  );
  return { node, services: services as ComposeServices };
}

const spec = {
  v: 1,
  title: "Inbox cleanup",
  fallbackText: "Inbox cleanup: 3 of 5 steps done (60%).",
  root: {
    id: "root",
    type: "stack",
    children: [
      { id: "p", type: "progress", label: "Cleanup", value: 3, max: 5 },
      {
        id: "steps",
        type: "checklist",
        items: [
          { id: "s1", label: "Archive newsletters", state: "done" },
          { id: "s2", label: "Draft replies", state: "active" },
        ],
      },
      {
        id: "go",
        type: "button",
        label: "Draft the replies now",
        action: { kind: "reply", text: "go" },
      },
    ],
  },
};

describe("widgets in a channel", () => {
  it("sends the fallback text and a text rendering of the main nodes, with no controls", async () => {
    const { node } = await setup(
      FakeModelProvider.script([
        [
          { type: "tool_call", id: "c1", name: "render_ui", input: { spec } },
          { type: "usage", usage },
          { type: "finish", reason: "tool_calls" },
        ] as ModelEvent[],
        say("All set."),
      ]),
    );
    node.receive({ from: OWNER, text: "clean my inbox" });
    await vi.waitFor(() => expect(node.sends.length).toBeGreaterThanOrEqual(1), { timeout: 8000 });
    const first = node.sends[0]?.text ?? "";
    expect(first).toContain("Inbox cleanup: 3 of 5 steps done (60%).");
    expect(first).toContain("Cleanup: 3/5 · 60%");
    expect(first).toContain("☑ Archive newsletters");
    expect(first).toContain("▸ Draft replies");
    expect(first).not.toContain("Draft the replies now");
    expect(first).not.toMatch(/widget|wdg_|\[ui/i);
  });
});
