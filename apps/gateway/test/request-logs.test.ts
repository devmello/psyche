import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessRequest, ProcessRunner } from "@psyche/speech";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import type { ComposeServices } from "../src/compose/services.ts";
import { composeSpeech, warnUnsandboxed } from "../src/compose/speech.ts";
import { createLogger } from "../src/log.ts";
import {
  desktopClient,
  ik,
  startTestGateway,
  type TestClient,
  type TestGateway,
} from "./helpers.ts";

/** #540: what an owner sees in the Gateway's log. */

let t: TestGateway | null = null;
let composed: ComposedGateway | null = null;
let home = "";
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await t?.cleanup();
  t = null;
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
});

const parsed = (logs: string[]) => logs.map((l) => JSON.parse(l) as Record<string, unknown>);

describe("Gateway log lines (#540)", () => {
  it("names the method and device of a failed request, never its params", async () => {
    const logs: string[] = [];
    t = await startTestGateway({ logger: createLogger((l) => logs.push(l), "debug") });
    const desk = await desktopClient(t.gateway);
    clients.push(desk);
    const res = await desk.request(
      "nodes.invoke",
      { nodeId: "node_missing", capability: "calendar.list_events", params: { q: "PRIVATE-1" } },
      ik(),
    );
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
    const line = parsed(logs).find((l) => l.msg === "request failed");
    expect(line).toMatchObject({ level: "info", method: "nodes.invoke", code: "not_found" });
    expect(typeof line?.deviceId).toBe("string");
    expect(logs.join("\n")).not.toContain("PRIVATE-1");
  });

  it("keeps the srt hint at debug on start, and warns once when a local tool runs without it", async () => {
    const logs: string[] = [];
    home = mkdtempSync(join(tmpdir(), "psyche-logs-"));
    let services: ComposeServices | undefined;
    composed = await composeGateway({
      env: {},
      logger: createLogger((l) => logs.push(l), "debug"),
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
      parts: [
        (s) => {
          services = s;
          return composeSpeech({})(s);
        },
      ],
    });
    const hints = () => parsed(logs).filter((l) => l.msg === "speech.unsandboxed");
    // Speech is always composed: every start logs the hint, at debug only.
    expect(hints().length).toBeGreaterThan(0);
    expect(hints().every((l) => l.level === "debug")).toBe(true);

    const ran: ProcessRequest[] = [];
    const inner: ProcessRunner = {
      run: async (request) => {
        ran.push(request);
        return { exitCode: 0, stdout: Buffer.alloc(0), stderr: "", timedOut: false } as never;
      },
    };
    const runner = warnUnsandboxed(inner, services as ComposeServices);
    await runner.run({ argv: ["/opt/homebrew/bin/ffmpeg", "-i", "pipe:0"] } as ProcessRequest);
    await runner.run({ argv: ["whisper-cli"] } as ProcessRequest);
    expect(ran).toHaveLength(2);
    expect(hints().filter((l) => l.level !== "debug")).toEqual([
      expect.objectContaining({ level: "warn", tool: "ffmpeg" }),
    ]);
  });
});
