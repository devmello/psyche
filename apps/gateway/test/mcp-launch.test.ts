import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type RuntimeDeps, systemRuntimeDeps } from "@psyche/mcp-host";
import { MCP_PRESETS } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { composeMcp } from "../src/compose/mcp.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/**
 * Presets that start `uvx` / `npx` ("The server did not start"): the launch goes through the real
 * srt launcher and runtime resolution, with a stand-in srt script and a stand-in uvx that run the
 * echo fixture. Nothing is installed and no real srt runs.
 */

const SERVER = fileURLToPath(new URL("./fixtures/echo-mcp-server.mjs", import.meta.url));

let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

function script(path: string, body: string) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

async function setup(opts: { uvx: boolean }) {
  home = mkdtempSync(join(tmpdir(), "psyche-mcp-launch-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  // Stands in for srt: drops `--settings <file> --` and runs the rest.
  script(join(bin, "srt"), 'while [ "$1" != "--" ]; do shift; done; shift; exec "$@"');
  if (opts.uvx) script(join(bin, "uvx"), `exec "${process.execPath}" "${SERVER}"`);
  const runtime: RuntimeDeps = systemRuntimeDeps(process.execPath, () => [bin]);
  composed = await composeGateway({
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
    parts: [
      (s) =>
        composeMcp(s, {
          srt: {
            resolve: async () => ({ path: join(bin, "srt") }),
            inspect: async () => {
              throw new Error("unused");
            },
          },
          runtime,
        }),
    ],
  });
  const owner = await adminClient(composed.gateway);
  clients.push(owner);
  return owner;
}

const timePreset = () => {
  const p = MCP_PRESETS.find((x) => x.id === "time");
  if (p?.transport.kind !== "stdio") throw new Error("time preset");
  return {
    id: "time",
    name: p.label,
    transport: { kind: "stdio" as const, command: [...p.transport.command] },
    allowedDomains: [...(p.transport.domains ?? [])],
  };
};

describe("preset Set up", () => {
  // srt (Seatbelt / bubblewrap) has no Windows build; Windows MCP servers run without it.
  it.skipIf(process.platform === "win32")(
    "starts the Time preset's uvx under the srt launcher",
    async () => {
      const owner = await setup({ uvx: true });
      const { proposal } = await owner.call<{ proposal: { tools: { name: string }[] } }>(
        "mcp.probe",
        { server: timePreset() },
        ik(),
      );
      expect(proposal.tools.map((t) => t.name)).toContain("echo");
    },
  );

  it("says uv is missing, not just 'did not start'", async () => {
    const owner = await setup({ uvx: false });
    await expect(owner.call("mcp.probe", { server: timePreset() }, ik())).rejects.toThrow(
      /"failure":"uv_missing"/,
    );
  });

  it("carries the server's own stderr and a network reason", async () => {
    const owner = await setup({ uvx: true });
    const failing = {
      id: "net",
      name: "Net",
      transport: {
        kind: "stdio" as const,
        command: [
          process.execPath,
          "-e",
          "console.error('getaddrinfo ENOTFOUND pypi.org'); process.exit(3)",
        ],
      },
    };
    await expect(owner.call("mcp.probe", { server: failing }, ik())).rejects.toThrow(
      /"failure":"network_blocked".*ENOTFOUND pypi\.org/s,
    );
  });
});
