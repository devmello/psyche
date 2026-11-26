import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TURN_CONTEXT_STUB } from "@psyche/agent-core";
import { getAgentThreadState, putAgentThreadState } from "@psyche/db";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { scrubSavedRecall } from "../src/compose/saved-recall.ts";
import { silentLogger } from "../src/log.ts";

let home = "";
let composed: ComposedGateway | null = null;

afterEach(async () => {
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

async function compose(): Promise<ComposedGateway> {
  home = mkdtempSync(join(tmpdir(), "psyche-recall-"));
  return composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db") },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
  });
}

const saved = (text: string) => ({
  messages: [
    {
      role: "user",
      parts: [
        { type: "text", text, turnContext: true },
        { type: "text", text: "what do I know about Sam?" },
      ],
    },
    { role: "assistant", parts: [{ type: "text", text: "A few things." }] },
  ],
  checklist: [],
});

describe("Forget cuts recalled text out of saved threads", () => {
  it("replaces turn context in idle threads, leaves running ones to their run", async () => {
    composed = await compose();
    const db = composed.db;
    putAgentThreadState(db, "thr_idle", saved("Sam has condition X"));
    putAgentThreadState(db, "thr_busy", saved("Sam has condition X"));
    expect(scrubSavedRecall(db, (id) => id === "thr_busy")).toBe(1);
    const idle = JSON.stringify(getAgentThreadState(db, "thr_idle"));
    expect(idle).not.toContain("condition X");
    expect(idle).toContain(TURN_CONTEXT_STUB);
    expect(idle).toContain("what do I know about Sam?");
    expect(JSON.stringify(getAgentThreadState(db, "thr_busy"))).toContain("condition X");
  });

  it("runs when the Gateway heals after a memory forget", async () => {
    composed = await compose();
    putAgentThreadState(composed.db, "thr_a", saved("Sam has condition X"));
    composed.gateway.context.messageScrub.heal?.();
    expect(JSON.stringify(getAgentThreadState(composed.db, "thr_a"))).not.toContain("condition X");
  });
});
