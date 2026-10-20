import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateDevice } from "@psyche/db";
import { FakeModelProvider, FakePermissionBroker } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { OwnerAttention, parkWhenUnwatched } from "../src/compose/attention.ts";
import { createComputerUse } from "../src/compose/computer.ts";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import type { ComposeServices } from "../src/compose/services.ts";
import { silentLogger } from "../src/log.ts";
import {
  TestClient as Client,
  desktopClient,
  handshake,
  ik,
  newDeviceKey,
  type TestClient,
  wsUrlOf,
} from "./helpers.ts";

/** #272: the desktop's pause-when-unwatched signal (`attention.report`). */

let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("attention.report (#272)", () => {
  it("is accepted from the desktop shell only, and drives the shared attention", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-attention-"));
    let services: ComposeServices | undefined;
    composed = await composeGateway({
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
      parts: [
        (s) => {
          services = s;
          return {};
        },
      ],
    });
    const desk = await desktopClient(composed.gateway);
    clients.push(desk);
    await desk.call("attention.report", { pane: "computer", visible: false }, ik());
    const attention = (services as ComposeServices).attention;
    expect(attention.paneHidden("computer")).toBe(true);
    expect(attention.paneHidden("browser")).toBe(false);
    await desk.call("attention.report", { pane: "computer", visible: true, input: true }, ik());
    expect(attention.paneHidden("computer")).toBe(false);
    expect(attention.lastInput()).toBeDefined();

    // A CLI paired with write scope may not claim the owner is watching.
    const key = newDeviceKey();
    const first = await Client.open(wsUrlOf(composed.gateway));
    await handshake(first, composed.gateway.origin, {
      key,
      deviceId: "cli-1",
      deviceFamily: "cli",
    });
    first.close();
    updateDevice(composed.db, "cli-1", {
      scopes: ["operator.read", "operator.write"],
      pairedAt: new Date().toISOString(),
    });
    const cli = await Client.open(wsUrlOf(composed.gateway));
    clients.push(cli);
    await handshake(cli, composed.gateway.origin, { key, deviceId: "cli-1", deviceFamily: "cli" });
    await expect(
      cli.call("attention.report", { pane: "computer", visible: true, input: true }, ik()),
    ).rejects.toThrow(/"code":"forbidden"/);
  });

  it("a hidden computer-use pane makes sensitive apps ask, whatever the input", () => {
    const attention = new OwnerAttention(() => 1_000);
    attention.noteInput();
    const cu = createComputerUse({
      broker: new FakePermissionBroker(),
      helper: () => undefined,
      context: () => {
        throw new Error("unused");
      },
      cancelRun: () => undefined,
      now: () => 1_000,
      lastOwnerInput: () => attention.lastInput(),
      paneHidden: () => attention.paneHidden("computer"),
    });
    const act = cu.registrations().find((r) => r.spec.name === "computer.act")?.describeCall;
    const click = { app: "com.apple.MobileSMS", action: "click", x: 1, y: 2 };
    expect(act?.(click)?.summary).not.toMatch(/away/);
    attention.report("computer", false, false);
    expect(act?.(click)?.summary).toMatch(/^While you're away: /);
  });

  it("counts the owner's own messages and answers as input, not the agent's", () => {
    let now = 5;
    const a = new OwnerAttention(() => now);
    a.observe(
      JSON.stringify({ event: "chat.message", payload: { message: { role: "assistant" } } }),
    );
    expect(a.lastInput()).toBeUndefined();
    a.observe(
      JSON.stringify({
        event: "chat.message",
        payload: { message: { role: "user", provenance: "owner" } },
      }),
    );
    expect(a.lastInput()).toBe(5);
    now = 9;
    a.observe(
      JSON.stringify({
        event: "approval.updated",
        payload: { approval: { decidedBy: { deviceId: "d1" } } },
      }),
    );
    expect(a.lastInput()).toBe(9);
  });

  it("parks a Task's call that answers awaiting_attention until the owner is back, then retries", async () => {
    let now = 0;
    const attention = new OwnerAttention(() => now);
    const notified: string[] = [];
    const registered = new Map<string, import("@psyche/protocol").ToolRegistration>();
    const registry = parkWhenUnwatched(
      {
        list: () => [],
        get: (n) => registered.get(n),
        register: (r) => {
          registered.set(r.spec.name, r);
          return () => registered.delete(r.spec.name);
        },
      },
      {
        attention,
        taskOf: (callId) => (callId.startsWith("task") ? "task_1" : undefined),
        notify: (taskId, tool) => notified.push(`${taskId}:${tool}`),
      },
    );
    let calls = 0;
    registry.register({
      spec: {
        name: "browser.snapshot",
        description: "",
        inputSchema: {},
        sideEffect: "read",
        provenanceOut: "untrusted",
      },
      execute: async () => {
        calls += 1;
        return attention.attended("browser")
          ? { output: { ok: true }, provenance: "untrusted" }
          : {
              output: {
                error: {
                  code: "presence_required",
                  message: "away",
                  details: { reason: "awaiting_attention" },
                },
              },
              isError: true,
              provenance: "untrusted",
            };
      },
    });
    const tool = registered.get("browser.snapshot");
    const signal = new AbortController().signal;
    // A chat turn gets the answer as is.
    const chat = await tool?.execute("chat_1", {}, signal, () => undefined);
    expect(chat?.isError).toBe(true);
    // A Task waits; the owner comes back; the call runs again and succeeds.
    const parked = tool?.execute("task_1", {}, signal, () => undefined);
    await new Promise((r) => setTimeout(r, 10));
    expect(notified).toEqual(["task_1:browser.snapshot"]);
    now = 1_000;
    attention.report("browser", true, true);
    expect(await parked).toMatchObject({ output: { ok: true } });
    expect(calls).toBe(3);
    // Cancelling the Task ends the wait with the original answer.
    now = 1_000 + 6 * 60_000;
    const stop = new AbortController();
    const cancelled = tool?.execute("task_2", {}, stop.signal, () => undefined);
    stop.abort();
    expect((await cancelled)?.isError).toBe(true);
  });
});
