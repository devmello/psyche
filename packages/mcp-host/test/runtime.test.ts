import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCP_PRESETS } from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { diagnoseLaunch } from "../src/diagnose.ts";
import { resolvingSrtLauncher, type StdioLaunchSpec } from "../src/launcher.ts";
import { RUNTIME_MISSING_TEXT, type RuntimeDeps, resolveRuntimeCommand } from "../src/runtime.ts";

const NODE = "/Applications/Psyche.app/Contents/Resources/runtime/node";

/** A Mac with Homebrew Node (npm) and uv in `~/.local/bin`; nothing is read from disk. */
function mac(files: Record<string, string | true>): RuntimeDeps {
  return {
    nodePath: NODE,
    searchDirs: () => ["/opt/homebrew/bin", "/Users/me/.local/bin"],
    isFile: async (p) => p in files,
    realpath: async (p) => {
      const v = files[p];
      return typeof v === "string" ? v : p;
    },
  };
}

const NPX_CLI = "/opt/homebrew/lib/node_modules/npm/bin/npx-cli.js";
const withNpm = { "/opt/homebrew/bin/npx": NPX_CLI, [NPX_CLI]: true as const };
const withUv = { "/Users/me/.local/bin/uvx": true as const };

const presetCommand = (id: string): string[] => {
  const t = MCP_PRESETS.find((p) => p.id === id)?.transport;
  if (t?.kind !== "stdio") throw new Error(`no stdio preset ${id}`);
  return [...t.command];
};

describe("resolveRuntimeCommand", () => {
  it("runs the Time preset's uvx by absolute path with caches in scratch", async () => {
    const r = await resolveRuntimeCommand(presetCommand("time"), mac(withUv), "/s");
    expect(presetCommand("time")).toEqual(["uvx", "mcp-server-time"]);
    expect(r.command).toEqual(["/Users/me/.local/bin/uvx", "mcp-server-time"]);
    expect(r.runtime).toBe("uv");
    expect(r.env.PATH?.split(":")[0]).toBe("/Users/me/.local/bin");
    expect(r.env.UV_CACHE_DIR).toBe("/s/uv-cache");
  });

  it("runs npx servers on Psyche's bundled Node, not a system npx or node", async () => {
    const r = await resolveRuntimeCommand(presetCommand("brave-search"), mac(withNpm), "/s");
    expect(r.command.slice(0, 3)).toEqual([NODE, NPX_CLI, "-y"]);
    expect(r.env.PATH?.split(":")[0]).toBe("/Applications/Psyche.app/Contents/Resources/runtime");
    expect(r.env.npm_config_cache).toBe("/s/npm-cache");
  });

  it("names the missing runtime", async () => {
    await expect(resolveRuntimeCommand(["uvx", "x"], mac({}), "/s")).rejects.toThrow(
      RUNTIME_MISSING_TEXT.uv,
    );
    await expect(resolveRuntimeCommand(["npx", "-y", "x"], mac({}), "/s")).rejects.toThrow(
      RUNTIME_MISSING_TEXT.node,
    );
  });

  it("leaves absolute commands alone", async () => {
    const r = await resolveRuntimeCommand(["/usr/bin/true"], mac({}), "/s");
    expect(r).toEqual({ command: ["/usr/bin/true"], env: {}, runtime: null });
  });
});

describe("srt launch command for the Time preset", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  const spec = (command: string[]): StdioLaunchSpec => ({
    serverId: "time",
    trust: "verified",
    command,
    env: { PATH: "/usr/bin:/bin" },
    serverEnv: {},
    sandbox: { allowedDomains: ["pypi.org"], allowWrite: [], denyRead: [] },
  });

  it("wraps the resolved command in srt, with the package index allowed", async () => {
    dir = await mkdtemp(join(tmpdir(), "psyche-rt-"));
    const launcher = resolvingSrtLauncher({
      resolve: async () => ({ path: "/fake/srt" }),
      settingsDir: dir,
      psycheHome: "/home/.psyche",
      runtime: mac(withUv),
    });
    const launch = await launcher.prepare(spec(presetCommand("time")));
    expect(launch.command).toBe("/fake/srt");
    expect(launch.args.slice(2)).toEqual(["--", "/Users/me/.local/bin/uvx", "mcp-server-time"]);
    const settings = JSON.parse(await readFile(launch.args[1] as string, "utf8"));
    expect(settings.network.allowedDomains).toEqual(["pypi.org"]);
    expect(launch.env.PATH).toContain("/Users/me/.local/bin");
    expect(launch.env.UV_CACHE_DIR?.startsWith(launch.env.TMPDIR as string)).toBe(true);
    await launch.cleanup?.();
  });

  it("refuses without launching when uv is missing", async () => {
    dir = await mkdtemp(join(tmpdir(), "psyche-rt-"));
    const launcher = resolvingSrtLauncher({
      resolve: async () => ({ path: "/fake/srt" }),
      settingsDir: dir,
      runtime: mac({}),
    });
    await expect(launcher.prepare(spec(["uvx", "mcp-server-time"]))).rejects.toThrow(
      RUNTIME_MISSING_TEXT.uv,
    );
  });
});

describe("diagnoseLaunch", () => {
  it("reads the real reason", () => {
    expect(diagnoseLaunch(RUNTIME_MISSING_TEXT.uv, "").failure).toBe("uv_missing");
    expect(diagnoseLaunch(RUNTIME_MISSING_TEXT.node, "").failure).toBe("node_missing");
    expect(diagnoseLaunch("srt is not available (not_found)", "").failure).toBe("no_srt");
    expect(diagnoseLaunch("spawn uvx ENOENT", "").failure).toBe("command_not_found");
    const net = diagnoseLaunch(
      "MCP error -32000: Connection closed",
      "getaddrinfo ENOTFOUND pypi.org",
    );
    expect(net.failure).toBe("network_blocked");
    const exited = diagnoseLaunch("MCP error -32000: Connection closed", "Traceback\nexit code 2");
    expect(exited).toMatchObject({ failure: "exited", exitCode: 2 });
  });
});
