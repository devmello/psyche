import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteAgentThreadState, getAgentThreadState, listAllMessages } from "@psyche/db";
import type { ModelCallOptions, ModelEvent, ModelRequest, Thread } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/** Stop, then a new message: the model must not see two unanswered requests (QA batch C, item 2). */

let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

/** The first call streams a little, then waits for Stop; later calls reply from the script. */
class StoppableProvider extends FakeModelProvider {
  streaming = false;
  #first = true;
  override async *stream(
    request: ModelRequest,
    options: ModelCallOptions = {},
  ): AsyncIterable<ModelEvent> {
    if (!this.#first) {
      yield* super.stream(request, options);
      return;
    }
    this.#first = false;
    this.requests.push(structuredClone(request));
    yield { type: "text_delta", text: "Chapter one." };
    this.streaming = true;
    await new Promise<void>((resolve) => {
      if (options.signal?.aborted === true) resolve();
      options.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    yield { type: "finish", reason: "cancelled" };
  }
}

type Msg = ModelRequest["messages"][number];
const textOf = (m: Msg) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");

async function boot(provider: StoppableProvider): Promise<TestClient> {
  composed = await composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider, model: "fake/model" },
  });
  const owner = await adminClient(composed.gateway);
  clients.push(owner);
  return owner;
}

/** How the next turn gets its model history after Stop. */
const paths = [
  ["the saved model-side state", "same"],
  ["the saved state after a Gateway restart", "restart"],
  ["a history rebuilt from the messages (no saved state)", "rebuild"],
] as const;

describe("chat.cancel then a new message", () => {
  it.each(paths)(
    "marks the stopped request in the next turn's model input: %s",
    async (_label, how) => {
      const provider = new StoppableProvider();
      provider.script([[{ type: "text_delta", text: "OK" }]]);
      home = mkdtempSync(join(tmpdir(), "psyche-stop-"));
      let owner = await boot(provider);
      const thread = (
        await owner.call<{ thread: Thread }>("threads.create", { kind: "main" }, ik())
      ).thread;

      await owner.call("chat.send", { threadId: thread.id, content: "Write a long essay." }, ik());
      await vi.waitFor(() => expect(provider.streaming).toBe(true));
      expect(await owner.call("chat.cancel", { threadId: thread.id })).toEqual({ cancelled: true });
      await composed?.gateway.context.sessions.idle();

      if (how === "restart") {
        for (const c of clients.splice(0)) c.close();
        await composed?.stop("restart");
        owner = await boot(provider);
      }
      if (how === "rebuild") {
        // Positive control: the live path saved a state, and dropping it forces the rebuild.
        expect(getAgentThreadState((composed as ComposedGateway).db, thread.id)).toBeDefined();
        deleteAgentThreadState((composed as ComposedGateway).db, thread.id);
      }

      await owner.call("chat.send", { threadId: thread.id, content: "Just say OK." }, ik());
      await composed?.gateway.context.sessions.idle();

      // The second model request: the essay request is closed by the stop, the new message is last.
      expect(provider.requests).toHaveLength(2);
      const sent = provider.requests[1]?.messages ?? [];
      const essay = sent.findIndex((m) => textOf(m).includes("Write a long essay."));
      const stop = sent.findIndex(
        (m) => m.role === "assistant" && textOf(m).includes("(stopped by the owner)"),
      );
      expect(essay).toBeGreaterThanOrEqual(0);
      expect(stop).toBeGreaterThan(essay);
      expect(textOf(sent.at(-1) as Msg)).toContain("Just say OK.");
      expect(sent.at(-1)?.role).toBe("user");

      // The owner's message is still in the thread; the marker is model context only.
      const shown = listAllMessages((composed as ComposedGateway).db, thread.id).map((m) =>
        m.blocks.map((b) => (b.type === "text" ? b.md : "")).join(""),
      );
      expect(shown).toContain("Write a long essay.");
      expect(shown.join("\n")).not.toContain("stopped by the owner");
    },
  );
});
