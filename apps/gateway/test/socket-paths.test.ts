import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BRIDGE_SOCKET_POINTER, BridgeServer, defaultBridgeSocketPath } from "@psyche/browser";
import { createScratchDir, scratchFits } from "@psyche/mcp-host";
import { afterAll, describe, expect, it } from "vitest";
import { recordBridgeSocket } from "../src/compose/browser.ts";
import { execHostSrtSettings } from "../src/compose/exec-host.ts";
import { resolveNodeSocketPath } from "../src/socket-path.ts";

/**
 * Every Unix socket Psyche or srt creates fits macOS's 104-byte `sun_path` for any `$PSYCHE_HOME`:
 * the node socket, the browser bridge, and the `srt-mux-*.sock` files srt makes in a command's or
 * MCP server's scratch directory (`TMPDIR`).
 */

const LIMIT = 104;
const MUX = "srt-mux-4194304-99.sock";
const cleanup: string[] = [];
afterAll(async () => {
  for (const d of cleanup) await rm(d, { recursive: true, force: true });
});

const homes = {
  usual: "/Users/devmello/.psyche",
  deep: `/Users/${"a".repeat(30)}/${"b".repeat(30)}/${"c".repeat(30)}/.psyche`,
};

describe.each(Object.entries(homes))("%s PSYCHE_HOME", (_name, home) => {
  it("node socket and browser bridge socket fit", () => {
    const node = resolveNodeSocketPath(home, undefined);
    const bridge = defaultBridgeSocketPath(home);
    expect(Buffer.byteLength(node)).toBeLessThan(LIMIT);
    expect(Buffer.byteLength(bridge)).toBeLessThan(LIMIT);
  });

  it("a scratch next to the settings files fits only when the home is short", () => {
    expect(scratchFits(join(home, "mcp", "srt", "s-0123456789"))).toBe(home === homes.usual);
  });

  it("the MCP and exec-host scratch directories leave room for srt's mux socket", async () => {
    for (const sub of ["mcp/srt", "exec-host"]) {
      // The usual home is not created: only a scratch that fits is made under it, in a temp root.
      const base = home === homes.usual ? await mkdtemp("/tmp/pfs-") : join(home, sub);
      cleanup.push(base);
      const dir = home === homes.usual ? join(base, "x") : base;
      const scratch = await createScratchDir(dir);
      cleanup.push(scratch);
      expect(Buffer.byteLength(join(scratch, MUX))).toBeLessThan(LIMIT);
    }
  });
});

describe("exec-host profile", () => {
  it("keeps a scratch outside the home unreadable except for its own command", () => {
    const scratch = "/tmp/psyche-501/s-abc";
    const s = execHostSrtSettings({
      psycheHome: homes.deep,
      userHome: "/Users/me",
      scratch,
      writable: [],
      allowedDomains: [],
    }) as { filesystem: Record<string, string[]> };
    expect(s.filesystem.allowWrite).toEqual([scratch]);
    expect(s.filesystem.denyRead).toContain(dirname(scratch));
    expect(s.filesystem.allowRead).toEqual([scratch]);
  });
});

describe("browser bridge socket pointer", () => {
  it("records a moved socket for the desktop, and clears it when the default fits again", async () => {
    const home = await mkdtemp(join(tmpdir(), "psy-ptr-"));
    cleanup.push(home);
    const moved = "/tmp/psyche-501/b-abc.sock";
    await recordBridgeSocket(home, moved);
    const pointer = join(home, "run", BRIDGE_SOCKET_POINTER);
    expect((await readFile(pointer, "utf8")).trim()).toBe(moved);
    await recordBridgeSocket(home, join(home, "run", "browser-bridge.sock"));
    await expect(readFile(pointer)).rejects.toThrow();
  });
});

describe("listening for real", () => {
  it("a deep home's bridge socket and an srt mux socket in the scratch both bind", async () => {
    const root = await mkdtemp("/tmp/pfs-");
    cleanup.push(root);
    const deepHome = join(root, "d".repeat(40), "e".repeat(40), ".psyche");
    const socketPath = defaultBridgeSocketPath(deepHome);
    expect(Buffer.byteLength(socketPath)).toBeLessThan(LIMIT);
    const bridge = new BridgeServer({
      socketPath,
      handshakeSecret: "s",
      gatewayVersion: "test",
      onClient: () => undefined,
    });
    await bridge.listen();
    await bridge.close();

    const scratch = await createScratchDir(join(deepHome, "mcp", "srt"));
    cleanup.push(scratch);
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(join(scratch, MUX), resolve);
    });
    server.close();
  });
});
