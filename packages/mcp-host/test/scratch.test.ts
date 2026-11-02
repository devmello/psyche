import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { srtLauncher } from "../src/launcher.ts";
import {
  createScratchDir,
  MAX_SOCKET_PATH_BYTES,
  scratchFits,
  scratchReadRules,
} from "../src/scratch.ts";

/**
 * srt creates `srt-mux-<pid>-<n>.sock` in the TMPDIR it is given, and `sun_path` is 104 bytes on
 * macOS: `listen EINVAL` killed an MCP server whose scratch name carried its id and a UUID.
 */

const MUX = "srt-mux-4194304-99.sock";
const made: string[] = [];
afterAll(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
});

const spec = {
  serverId: "time-probe-7f0183dc-d49aa08e-7d9a-408c-9502-0e4b7172c755",
  trust: "unknown" as const,
  command: ["uvx", "mcp-server-time"],
  env: {},
  serverEnv: {},
  sandbox: { allowedDomains: [], allowWrite: [] as string[], denyRead: [] as string[] },
};

describe("scratch directories", () => {
  it("keeps the socket under 104 bytes for a deliberately deep home", async () => {
    const root = await mkdtemp(join(tmpdir(), "psy-deep-"));
    made.push(root);
    const deepHome = join(root, "a".repeat(40), "b".repeat(40), "c".repeat(40), ".psyche");
    const settingsDir = join(deepHome, "mcp", "srt");
    const launcher = srtLauncher({
      srtPath: "/usr/local/bin/srt",
      settingsDir,
      psycheHome: deepHome,
    });
    const p = await launcher.prepare(spec);
    const scratch = p.env.TMPDIR as string;
    made.push(scratch);
    const socket = join(scratch, MUX);
    expect(Buffer.byteLength(socket)).toBeLessThan(104);
    expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(MAX_SOCKET_PATH_BYTES);
    expect(scratch.startsWith(deepHome)).toBe(false);
    expect((await stat(scratch)).mode & 0o777).toBe(0o700);
    expect((await stat(dirname(scratch))).mode & 0o777).toBe(0o700);
    expect(p.cwd).toBe(scratch);
    // Only the scratch is writable; no other server's scratch is readable, only its own.
    const settings = JSON.parse(await readFile(p.args[1] as string, "utf8"));
    expect(settings.filesystem.allowWrite).toEqual([scratch]);
    expect(settings.filesystem.denyRead).toContain(dirname(scratch));
    expect(settings.filesystem.allowRead).toEqual([scratch]);
    expect(settings.network.allowUnixSockets).toEqual([]);
    await p.cleanup?.();
    await expect(stat(scratch)).rejects.toThrow();
  });

  it("stays under the settings directory when a socket fits there", async () => {
    // A short root: macOS's own temp dir is already ~50 bytes.
    const root = await mkdtemp("/tmp/pfs-");
    made.push(root);
    const settingsDir = join(root, ".psyche", "mcp", "srt");
    const launcher = srtLauncher({
      srtPath: "/usr/local/bin/srt",
      settingsDir,
      psycheHome: join(root, ".psyche"),
    });
    const p = await launcher.prepare(spec);
    const scratch = p.env.TMPDIR as string;
    expect(dirname(scratch)).toBe(settingsDir);
    expect(scratchFits(scratch)).toBe(true);
    expect(Buffer.byteLength(join(scratch, MUX))).toBeLessThan(104);
    const settings = JSON.parse(await readFile(p.args[1] as string, "utf8"));
    expect(settings.filesystem.allowRead).toEqual([]);
    await p.cleanup?.();
  });

  it("gives every launch its own directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "psy-uniq-"));
    made.push(root);
    const a = await createScratchDir(root);
    const b = await createScratchDir(root);
    expect(a).not.toBe(b);
  });

  it("scratchReadRules leaves a scratch inside the home alone", () => {
    expect(scratchReadRules("/h/.psyche", "/h/.psyche/mcp/srt/s-1")).toEqual({
      denyRead: [],
      allowRead: [],
    });
    expect(scratchReadRules("/h/.psyche", "/tmp/psyche-501/s-1")).toEqual({
      denyRead: ["/tmp/psyche-501"],
      allowRead: ["/tmp/psyche-501/s-1"],
    });
  });
});
