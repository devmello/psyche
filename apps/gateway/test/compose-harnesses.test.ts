import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliDriver, CliResult } from "@psyche/sandbox";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_CODE_SETTING } from "../src/compose/harnesses.ts";
import { type ComposedGateway, composeGateway, partsFromEnv } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/** C10 in the Gateway: Claude Code is offered only while the owner configured it. */

const fakeCli: CliDriver = {
  start(_file, args) {
    const a = [...args];
    const absent = a[0] === "inspect" || (a[0] === "volume" && a[1] === "inspect");
    const result: CliResult = {
      exitCode: absent ? 1 : 0,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 1,
    };
    return { pid: 1, done: Promise.resolve(result), kill: () => undefined };
  },
  stream() {
    throw new Error("no container in this test");
  },
};

let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("coding harnesses in the Gateway (C10)", () => {
  it("registers Claude Code with the setting and removes it without", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-harness-gw-"));
    composed = await composeGateway({
      env: {},
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
      parts: partsFromEnv(
        { PSYCHE_BROWSER: "off" },
        {
          sandboxRunner: {
            driver: fakeCli,
            detect: async () => [{ kind: "docker", cli: "/usr/bin/docker", version: "29" }],
            image: "psyche-sandbox:core-dev",
            idleTimeoutMs: 0,
          },
        },
      ),
    });
    const owner = await adminClient(composed.gateway);
    clients.push(owner);
    expect(composed.loop.harnesses.list()).toEqual([]);
    await owner.call(
      "settings.set",
      {
        key: CLAUDE_CODE_SETTING,
        value: { enabled: true, credential: "anthropic", model: "sonnet" },
      },
      ik(),
    );
    await vi.waitFor(() =>
      expect(composed?.loop.harnesses.list()).toEqual([{ id: "claude-code", name: "Claude Code" }]),
    );
    await owner.call("settings.set", { key: CLAUDE_CODE_SETTING, value: { enabled: false } }, ik());
    await vi.waitFor(() => expect(composed?.loop.harnesses.list()).toEqual([]));
  }, 30_000);
});
