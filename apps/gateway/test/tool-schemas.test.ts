import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliDriver, CliResult } from "@psyche/sandbox";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { deferToolFor } from "../src/compose/capabilities.ts";
import { type ComposedGateway, composeGateway, partsFromEnv } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";

/**
 * #414: every tool the Gateway offers must have a top-level `type: "object"` input schema, or
 * Anthropic (and OpenAI) refuse the whole request. `code.git` and the loop's `memory` shipped as
 * a top-level `anyOf` and broke every turn in a default install. This composes the real Gateway
 * with the default parts (`partsFromEnv` with an empty environment, as psyched starts), only the
 * sandbox's container CLI faked so `exec` and `code.run` are offered without a container here,
 * and checks every registered tool. Nothing is hand-picked.
 */

/** A container CLI that runs nothing: Docker is "present", nothing exists yet. */
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

afterEach(async () => {
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("composed tool schemas (#414)", () => {
  it("every tool of the default composition advertises a top-level object", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-tool-schemas-"));
    composed = await composeGateway({
      env: {},
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
      parts: partsFromEnv(
        {},
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
    const specs = composed.loop.registry.list();
    // The default composition, including the two tools that shipped broken.
    expect(specs.map((t) => t.name)).toEqual(
      expect.arrayContaining(["memory", "code.git", "code.run", "exec", "notify", "read_file"]),
    );
    const bad = specs
      .filter((t) => {
        const s = t.inputSchema as Record<string, unknown>;
        return (
          s.type !== "object" ||
          s.anyOf !== undefined ||
          s.oneOf !== undefined ||
          s.allOf !== undefined ||
          typeof s.properties !== "object"
        );
      })
      .map((t) => t.name);
    expect(bad).toEqual([]);
  });
});

/**
 * Progressive disclosure: the tool schemas sent with every request before and after deferral, in
 * the default composition (no MCP servers yet; each server adds its whole `tools/list` before).
 * Tokens are the loop's own estimate (4 characters ≈ 1 token). Prints the numbers for the PR.
 */
describe("deferred tools: prompt size", () => {
  it("sends far fewer schema tokens with the default loading policy", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-prompt-size-"));
    composed = await composeGateway({
      env: {},
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
      parts: partsFromEnv(
        {},
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
    const all = composed.loop.registry.list();
    const finder = new Set(["tool_search", "load_tools"]);
    const defer = deferToolFor(composed.gateway.context.db);
    const before = all.filter((t) => !finder.has(t.name));
    const after = all.filter((t) => finder.has(t.name) || !defer(t));
    const tokens = (specs: typeof all) => Math.ceil(JSON.stringify(specs).length / 4);
    const b = tokens(before);
    const a = tokens(after);
    console.log(
      `tool schemas per request: before ${before.length} tools ≈ ${b} tokens; after ${after.length} tools ≈ ${a} tokens (${Math.round((1 - a / b) * 100)}% less); on demand ${all.length - after.length}`,
    );
    expect(after.map((t) => t.name)).toEqual(
      expect.arrayContaining(["read_file", "memory", "find_capability", "tool_search"]),
    );
    expect(a).toBeLessThan(b * 0.6);
  });
});
