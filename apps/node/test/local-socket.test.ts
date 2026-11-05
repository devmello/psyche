import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { localGatewaySocket } from "../src/local-socket.ts";
import { devicePlatformOf } from "../src/runtime.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function home(): string {
  const d = mkdtempSync(join(tmpdir(), "pn-home-"));
  dirs.push(d);
  mkdirSync(join(d, "run"));
  return d;
}

describe("the local Gateway endpoint", () => {
  it("is the pipe the Gateway recorded in run/node-socket (Windows)", () => {
    const h = home();
    const pipe = "\\\\.\\pipe\\psyche-node-0123456789abcdef";
    writeFileSync(join(h, "run", "node-socket"), `${pipe}\n`);
    expect(localGatewaySocket(h)).toBe(pipe);
  });

  it("is a recorded socket only while the file exists, else run/node.sock, else none", () => {
    const h = home();
    expect(localGatewaySocket(h)).toBeUndefined();
    const moved = join(h, "moved.sock");
    writeFileSync(join(h, "run", "node-socket"), `${moved}\n`);
    expect(localGatewaySocket(h)).toBeUndefined();
    writeFileSync(moved, "");
    expect(localGatewaySocket(h)).toBe(moved);
    rmSync(join(h, "run", "node-socket"));
    writeFileSync(join(h, "run", "node.sock"), "");
    expect(localGatewaySocket(h)).toBe(join(h, "run", "node.sock"));
  });
});

describe("the platform a node declares", () => {
  it("maps Node's platform names to the protocol's", () => {
    expect(devicePlatformOf("darwin")).toBe("macos");
    expect(devicePlatformOf("win32")).toBe("windows");
    expect(devicePlatformOf("linux")).toBe("linux");
    expect(devicePlatformOf("freebsd")).toBe("linux");
  });
});
