import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { SandboxInstance, SandboxNetwork, SandboxScope } from "@psyche/protocol";
import { assertNoSecrets, FakeCredentialBroker } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  containerLauncher,
  mcpSandboxScope,
  PsycheMcpHost,
  type SandboxStdioHost,
  type SandboxStdioProcess,
} from "../src/index.ts";

const PROBE = fileURLToPath(new URL("./fixtures/probe-server.mjs", import.meta.url));
const text = (content: unknown) =>
  (content as { blocks: { text?: string }[] }).blocks.map((b) => b.text ?? "").join("");

/**
 * Stands in for `ContainerSandboxRunner` (#143): `openStdio` runs the command with exactly the
 * env it was given and nothing of the host's, the way the container does. Records every call.
 */
class FakeSandboxStdio implements SandboxStdioHost {
  readonly ensured: { scope: SandboxScope; network: SandboxNetwork | undefined }[] = [];
  readonly opened: {
    sandboxId: string;
    argv: string[];
    cwd?: string;
    env?: Record<string, string>;
  }[] = [];
  readonly killed: string[] = [];
  readonly children: ChildProcess[] = [];

  async ensureSandbox(
    scope: SandboxScope,
    options: { network?: SandboxNetwork } = {},
  ): Promise<SandboxInstance> {
    this.ensured.push({ scope, network: options.network });
    return {
      id: `sbx_${scope.id.replace(/[^a-z0-9]/g, "_")}`,
      scope,
      backend: "fake",
      network: options.network ?? "none",
      workspacePath: "/workspace",
      status: "ready",
    };
  }

  async openStdio(
    sandboxId: string,
    options: { argv: string[]; cwd?: string; env?: Record<string, string> },
  ): Promise<SandboxStdioProcess> {
    this.opened.push({ sandboxId, ...structuredClone(options) });
    // The scenario's "image" runs the probe server; the argv is only recorded.
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
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.close();
});

function setup(options: { egress?: boolean } = {}) {
  const sandbox = new FakeSandboxStdio();
  const vault = new FakeCredentialBroker();
  const secret = "sk_live_psyche_container_env_secret_77";
  vault.add({ slug: "probe-key", kind: "api_key", secret, bindings: [{ connector: "mcp:probe" }] });
  const allowlists: { scope: SandboxScope; domains: string[] }[] = [];
  const host = new PsycheMcpHost({
    launcher: containerLauncher({
      sandbox,
      ...(options.egress === true
        ? {
            egressAllowlist: (scope: SandboxScope, domains: string[]) =>
              void allowlists.push({ scope, domains }),
          }
        : {}),
    }),
    secrets: {
      credentials: vault,
      async approve({ target }) {
        vault.approve("ap_probe", { slug: "probe-key", origin: target.value });
        return "ap_probe";
      },
    },
  });
  hosts.push(host);
  return { host, sandbox, secret, allowlists };
}

describe("stdio MCP servers in the sandbox container (M3)", () => {
  it("runs an unknown server in its own sandbox with network none, only its own env, over pipes", async () => {
    const { host, sandbox, secret } = setup();
    process.env.PSYCHE_TEST_HOST_ONLY = "host-only-value";
    try {
      const info = await host.addServer({
        id: "probe",
        name: "Probe",
        trust: "unknown",
        transport: {
          kind: "stdio",
          command: ["node", "/workspace/server.mjs"],
          env: { API_TOKEN: "{{cred:probe-key}}", MODE: "test" },
        },
      });
      expect(info.status).toBe("connected");
      expect(host.describe("probe").isolation).toBe("container");
      expect(sandbox.ensured).toEqual([{ scope: mcpSandboxScope("probe"), network: "none" }]);
      expect(sandbox.opened[0]).toMatchObject({
        sandboxId: "sbx_mcp_probe",
        argv: ["node", "/workspace/server.mjs"],
        cwd: "/workspace",
      });
      // The secret goes to the runner as env (delivered inside the container), never in argv.
      expect(sandbox.opened[0]?.env).toEqual({ API_TOKEN: secret, MODE: "test" });
      expect(JSON.stringify(sandbox.opened[0]?.argv)).not.toContain(secret);
      const { toolsListHash, tools } = await host.listTools("probe");
      expect(tools.map((t) => t.name).sort()).toEqual([
        "mcp__probe__env_names",
        "mcp__probe__env_value_length",
        "mcp__probe__read_file",
      ]);
      // Unknown servers' annotations are hints only: nothing is downgraded to read.
      expect(tools.every((t) => t.sideEffect !== "read")).toBe(true);
      // Their descriptions and schemas are the server's words (#281).
      expect(tools.every((t) => t.descriptionProvenance === "untrusted")).toBe(true);
      const names = await host.callTool("probe", "env_names", {}, { toolsListHash });
      // macOS adds `__CF_*` to every process; nothing of the host's environment is visible.
      const visible = text(names.content)
        .split(",")
        .filter((n) => !n.startsWith("__CF_"));
      expect(visible).toEqual(["API_TOKEN", "MODE"]);
      const len = await host.callTool(
        "probe",
        "env_value_length",
        { name: "API_TOKEN" },
        { toolsListHash },
      );
      expect(text(len.content)).toBe(String(secret.length));
      assertNoSecrets({ info, details: host.describe("probe"), tools });
    } finally {
      delete process.env.PSYCHE_TEST_HOST_ONLY;
    }
  });

  it("kills the server process when it is removed", async () => {
    const { host, sandbox } = setup();
    await host.addServer({
      id: "probe",
      name: "Probe",
      trust: "unknown",
      transport: { kind: "stdio", command: ["node", "s.mjs"] },
    });
    await host.removeServer("probe");
    expect(sandbox.killed).toEqual(["sbx_mcp_probe"]);
    expect(sandbox.children[0]?.exitCode !== null || sandbox.children[0]?.signalCode !== null).toBe(
      true,
    );
  });

  it("refuses host write roots and host working directories", async () => {
    const { host, sandbox } = setup();
    const a = await host.addServer({
      id: "writer",
      name: "Writer",
      trust: "unknown",
      transport: { kind: "stdio", command: ["node", "s.mjs"] },
      sandbox: { allowWrite: ["/Users/owner/Documents"] },
    } as never);
    expect(a.status).toBe("error");
    expect(host.describe("writer").error).toMatch(/host folders/);
    const b = await host.addServer({
      id: "cwd",
      name: "Cwd",
      trust: "unknown",
      transport: { kind: "stdio", command: ["node", "s.mjs"] },
      cwd: "/Users/owner",
    } as never);
    expect(b.status).toBe("error");
    expect(host.describe("cwd").error).toMatch(/inside \/workspace/);
    expect(sandbox.ensured).toEqual([]);
  });

  it("network needs the egress proxy: refused without one, proxy network with the allowlist handed over", async () => {
    const none = setup();
    const r = await none.host.addServer({
      id: "net",
      name: "Net",
      trust: "unknown",
      transport: { kind: "stdio", command: ["node", "s.mjs"] },
      sandbox: { allowedDomains: ["api.example.com"] },
    } as never);
    expect(r.status).toBe("error");
    expect(none.host.describe("net").error).toMatch(/egress proxy/);
    const withProxy = setup({ egress: true });
    const ok = await withProxy.host.addServer({
      id: "net",
      name: "Net",
      trust: "unknown",
      transport: { kind: "stdio", command: ["node", "s.mjs"] },
      sandbox: { allowedDomains: ["api.example.com", "api.example.com"] },
    } as never);
    expect(ok.status).toBe("connected");
    expect(withProxy.allowlists).toEqual([
      { scope: mcpSandboxScope("net"), domains: ["api.example.com"] },
    ]);
    expect(withProxy.sandbox.ensured[0]?.network).toBe("proxy");
  });

  it("each server gets its own sandbox scope", async () => {
    const { host, sandbox } = setup();
    await host.addServer({
      id: "one",
      name: "One",
      trust: "unknown",
      transport: { kind: "stdio", command: ["node", "a.mjs"] },
    });
    await host.addServer({
      id: "two",
      name: "Two",
      trust: "unknown",
      transport: { kind: "stdio", command: ["node", "b.mjs"] },
    });
    expect(sandbox.ensured.map((e) => e.scope.id)).toEqual(["mcp:one", "mcp:two"]);
  });
});
