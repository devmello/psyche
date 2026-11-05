import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxInstance, SandboxScope } from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  mcpSandboxScope,
  PsycheMcpHost,
  type PsycheMcpServerConfig,
  type SandboxStdioProcess,
  type StagedFile,
  type VmStdioHost,
  vmLauncher,
} from "../src/index.ts";

const PROBE = fileURLToPath(new URL("./fixtures/probe-server.mjs", import.meta.url));

/**
 * Stands in for the Gateway's VM runner (the sandbox PC's guest): records what the launcher asks
 * for and runs the probe server locally with exactly the env it was given.
 */
class FakeGuest implements VmStdioHost {
  up = true;
  readonly ensured: SandboxScope[] = [];
  readonly opened: {
    sandboxId: string;
    argv: string[];
    cwd?: string;
    env?: Record<string, string>;
    files?: StagedFile[];
    network?: "none" | "allow";
  }[] = [];
  readonly killed: string[] = [];
  readonly children: ChildProcess[] = [];

  ready() {
    return this.up;
  }

  async ensureSandbox(scope: SandboxScope): Promise<SandboxInstance> {
    this.ensured.push(scope);
    return {
      id: `vm:${scope.kind}:${scope.id}`,
      scope,
      backend: "vm",
      network: "none",
      workspacePath: "/workspace",
      status: "ready",
    };
  }

  async openStdio(
    sandboxId: string,
    options: Parameters<VmStdioHost["openStdio"]>[1],
  ): Promise<SandboxStdioProcess> {
    this.opened.push({ sandboxId, ...structuredClone(options) });
    const child = spawn(process.execPath, [PROBE], {
      env: { ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.children.push(child);
    const exited = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => child.once("exit", (exitCode, signal) => resolve({ exitCode, signal })),
    );
    return {
      stdin: child.stdin as NonNullable<typeof child.stdin>,
      stdout: child.stdout as NonNullable<typeof child.stdout>,
      stderr: child.stderr as NonNullable<typeof child.stderr>,
      exited,
      kill: async (signal = "TERM") => {
        this.killed.push(sandboxId);
        child.kill(signal === "KILL" ? "SIGKILL" : "SIGTERM");
        await exited;
      },
    };
  }
}

const hosts: PsycheMcpHost[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const cfg = (c: PsycheMcpServerConfig) => c;

function setup() {
  const guest = new FakeGuest();
  const host = new PsycheMcpHost({
    launcher: vmLauncher({ vm: guest, notReady: "Turn on the sandbox PC" }),
  });
  hosts.push(host);
  return { guest, host };
}

describe("stdio MCP servers in the sandbox guest (sandbox PC on Windows)", () => {
  it("runs a server in its own guest workspace with no network and only its own env", async () => {
    const { guest, host } = setup();
    const info = await host.addServer({
      id: "probe",
      name: "Probe",
      trust: "unknown",
      transport: { kind: "stdio", command: ["npx", "-y", "probe"], env: { MODE: "test" } },
    });
    expect(info.status).toBe("connected");
    expect(host.describe("probe").isolation).toBe("vm");
    expect(guest.ensured).toEqual([mcpSandboxScope("probe")]);
    expect(guest.opened[0]).toMatchObject({
      sandboxId: "vm:task:mcp:probe",
      argv: ["npx", "-y", "probe"],
      cwd: "/workspace",
      network: "none",
      env: { MODE: "test" },
    });
    expect(guest.opened[0]?.files).toBeUndefined();
    const { tools } = await host.listTools("probe");
    expect(tools.length).toBeGreaterThan(0);
    await host.removeServer("probe");
    expect(guest.killed).toEqual(["vm:task:mcp:probe"]);
  });

  it("gives the guest's network only to a server whose config allowlists hosts", async () => {
    const { guest, host } = setup();
    await host.addServer(
      cfg({
        id: "net",
        name: "Net",
        trust: "unknown",
        transport: { kind: "stdio", command: ["node", "/workspace/s.mjs"] },
        sandbox: { allowedDomains: ["api.example.com"] },
      }),
    );
    expect(guest.opened[0]?.network).toBe("allow");
  });

  it("copies a Psyche-made connector's own folder in (never shares it) and rewrites its paths", async () => {
    const { guest, host } = setup();
    const dir = mkdtempSync(join(tmpdir(), "psyche-vmcode-"));
    dirs.push(dir);
    writeFileSync(join(dir, "server.mjs"), "// server");
    mkdirSync(join(dir, "lib"));
    writeFileSync(join(dir, "lib", "util.mjs"), "export {}");
    const outside = mkdtempSync(join(tmpdir(), "psyche-outside-"));
    dirs.push(outside);
    writeFileSync(join(outside, "secret.txt"), "never copied");
    try {
      symlinkSync(join(outside, "secret.txt"), join(dir, "link.txt"));
    } catch {
      // no symlink privilege here: nothing to skip
    }
    await host.addServer(
      cfg({
        id: "made",
        name: "Made",
        trust: "unknown",
        transport: { kind: "stdio", command: ["node", join(dir, "server.mjs")] },
        cwd: dir,
        sandbox: { allowedDomains: [], allowRead: [dir] },
      }),
    );
    const opened = guest.opened[0];
    expect(opened?.cwd).toBe("/workspace");
    expect(opened?.argv).toEqual(["node", "/workspace/server.mjs"]);
    expect(opened?.network).toBe("none");
    expect(opened?.files?.map((f) => f.path).sort()).toEqual(["lib/util.mjs", "server.mjs"]);
    expect(
      Buffer.from(
        opened?.files?.find((f) => f.path === "server.mjs")?.content ?? "",
        "base64",
      ).toString("utf8"),
    ).toBe("// server");
  });

  it("refuses host folders it may not read, any write grant, and a guest that is off", async () => {
    const { guest, host } = setup();
    const dir = mkdtempSync(join(tmpdir(), "psyche-vmcwd-"));
    dirs.push(dir);
    const add = (id: string, extra: Record<string, unknown>) =>
      host.addServer(
        cfg({
          id,
          name: id,
          trust: "unknown",
          transport: { kind: "stdio", command: ["node", "s.mjs"] },
          ...extra,
        }),
      );
    const cwd = await add("cwd", { cwd: dir });
    expect(cwd.status).not.toBe("connected");
    const write = await add("write", { sandbox: { allowedDomains: [], allowWrite: [dir] } });
    expect(write.status).not.toBe("connected");
    guest.up = false;
    const off = await add("off", {});
    expect(off.status).not.toBe("connected");
    expect(host.describe("off").error).toContain("Turn on the sandbox PC");
    // Nothing reached the guest: no process ran anywhere for these.
    expect(guest.opened).toEqual([]);
  });
});
