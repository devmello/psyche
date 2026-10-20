import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeModelProvider, FakeSandboxRunner } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { composeCoding, hostGit } from "../src/compose/coding.ts";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";

/**
 * #414: every tool the composed Gateway offers must have a top-level `type: "object"` input
 * schema, or Anthropic (and OpenAI) refuse the whole request. `code.git` shipped as a top-level
 * `anyOf` and broke every turn in a default install. This walks the real composition, with the
 * coding helper mounted as `partsFromEnv` mounts it.
 */

let home = "";
let composed: ComposedGateway | null = null;

afterEach(async () => {
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("composed tool schemas (#414)", () => {
  it("every registered tool advertises a top-level object", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-tool-schemas-"));
    composed = await composeGateway({
      env: {},
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
      parts: [(s) => composeCoding(s, { runner: new FakeSandboxRunner(), git: hostGit() })],
    });
    const specs = composed.loop.registry.list();
    expect(specs.map((t) => t.name)).toEqual(
      expect.arrayContaining(["code.git", "code.run", "read_file", "memory"]),
    );
    const bad = specs
      .filter((t) => {
        const s = t.inputSchema as Record<string, unknown>;
        return s.type !== "object" || s.anyOf !== undefined || s.oneOf !== undefined;
      })
      .map((t) => t.name);
    expect(bad).toEqual([]);
  });
});
