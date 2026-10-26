import { mcpTrustFor } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { presetServer } from "../src/screens/settings/mcp-preset-build.ts";
import { MCP_PRESETS } from "../src/screens/settings/mcp-presets.ts";

/** The gallery's Official badge and the Gateway's `verified` tier read one list (`mcpTrustFor`). */

/** Presets whose address is the owner's own, so no vendor list can vouch for it. */
const OWNER_ADDRESS = new Set(["home-assistant"]);

function inputFor(preset: (typeof MCP_PRESETS)[number]) {
  const values: Record<string, string> = {};
  for (const f of preset.fields) {
    values[f.id] =
      f.kind === "secret"
        ? `${f.prefix ?? ""}secret`
        : f.arg === true && preset.transport.kind === "http"
          ? "https://home.example.com/api/mcp"
          : "/tmp/x";
  }
  return presetServer(preset, values, "n1").input;
}

describe("gallery presets and verified trust", () => {
  for (const preset of MCP_PRESETS) {
    const official = preset.official && !OWNER_ADDRESS.has(preset.id);
    it(`${preset.id}: ${official ? "verified" : "unknown"}`, () => {
      const t = inputFor(preset).transport;
      const tier = mcpTrustFor(
        t.kind === "stdio" ? { kind: "stdio", command: t.command } : { kind: "http", url: t.url },
      );
      expect(tier).toBe(official ? "verified" : "unknown");
    });
  }
});
