import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNoSecrets, FakeCredentialBroker } from "@psyche/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  directLauncher,
  mcpCredentialTarget,
  PsycheMcpHost,
  type StdioLauncher,
} from "../src/index.ts";

const require = createRequire(import.meta.url);
const FS_SERVER = require.resolve("@modelcontextprotocol/server-filesystem/dist/index.js");
const ENV_SERVER = fileURLToPath(new URL("./fixtures/stdio-env-server.ts", import.meta.url));

const text = (content: unknown) =>
  (content as { blocks: { text?: string }[] }).blocks.map((b) => b.text ?? "").join("");

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "psyche-mcp-fs-"));
  await writeFile(join(dir, "hello.txt"), "hello from the temp dir\n");
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("filesystem reference server over stdio", () => {
  it("connects (legacy SDK v1 server), lists and calls tools inside the temp dir", async () => {
    const host = new PsycheMcpHost({ bundledServerIds: ["fs"], launcher: directLauncher() });
    try {
      const info = await host.addServer({
        id: "fs",
        name: "Filesystem",
        trust: "bundled",
        transport: { kind: "stdio", command: [process.execPath, FS_SERVER, dir] },
      });
      expect(info.status).toBe("connected");
      expect(host.describe("fs").era).toBe("legacy");
      const { tools, toolsListHash } = await host.listTools("fs");
      const names = tools.map((t) => t.name);
      expect(names).toContain("mcp__fs__read_text_file");
      expect(tools.find((t) => t.name === "mcp__fs__read_text_file")?.sideEffect).toBe("read");
      // A bundled server's tool text ships with Psyche (#281).
      expect(tools.every((t) => t.descriptionProvenance === "trusted")).toBe(true);
      expect(tools.find((t) => t.name === "mcp__fs__write_file")?.sideEffect).not.toBe("read");
      const r = await host.callTool(
        "fs",
        "read_text_file",
        { path: join(dir, "hello.txt") },
        { toolsListHash },
      );
      expect(r.isError).toBe(false);
      expect(text(r.content)).toContain("hello from the temp dir");
      const outside = await host.callTool(
        "fs",
        "read_text_file",
        { path: "/etc/hosts" },
        { toolsListHash },
      );
      expect(outside.isError).toBe(true);
    } finally {
      await host.close();
    }
  });

  it("refuses non-bundled stdio servers without a sandboxing launcher", async () => {
    const host = new PsycheMcpHost({ launcher: directLauncher() });
    const info = await host.addServer({
      id: "fs2",
      name: "Filesystem",
      trust: "unknown",
      transport: { kind: "stdio", command: [process.execPath, FS_SERVER, dir] },
    });
    expect(info.status).toBe("error");
    expect(host.describe("fs2").error).toMatch(/sandbox/);
    const none = new PsycheMcpHost();
    expect(
      (
        await none.addServer({
          id: "fs3",
          name: "x",
          trust: "unknown",
          transport: { kind: "stdio", command: ["true"] },
        })
      ).status,
    ).toBe("error");
  });

  it("passes the launch through the configured launcher", async () => {
    const seen: string[][] = [];
    const recording: StdioLauncher = {
      isolation: "srt",
      async prepare(spec) {
        seen.push(spec.command);
        const [command, ...args] = spec.command;
        return { command: command as string, args, env: spec.env };
      },
    };
    const host = new PsycheMcpHost({ launcher: recording });
    try {
      const info = await host.addServer({
        id: "fs4",
        name: "x",
        trust: "unknown",
        transport: { kind: "stdio", command: [process.execPath, FS_SERVER, dir] },
      });
      expect(info.status).toBe("connected");
      expect(seen).toEqual([[process.execPath, FS_SERVER, dir]]);
      // Unknown tier: the filesystem server's readOnlyHint is not trusted.
      const { tools } = await host.listTools("fs4");
      expect(tools.every((t) => t.sideEffect !== "read" && t.provenanceOut === "untrusted")).toBe(
        true,
      );
    } finally {
      await host.close();
    }
  });
});

describe("vault secrets injected as env at spawn", () => {
  it("the child sees the secret; nothing the host reports contains it", async () => {
    const vault = new FakeCredentialBroker();
    const secret = "sk_live_psyche_stdio_env_secret_42";
    vault.add({ slug: "api", kind: "api_key", secret, bindings: [{ connector: "mcp:envsrv" }] });
    const host = new PsycheMcpHost({
      bundledServerIds: ["envsrv"],
      launcher: directLauncher(),
      secrets: {
        credentials: vault,
        async approve({ target }) {
          expect(target).toEqual(mcpCredentialTarget("envsrv"));
          vault.approve("ap_env", { slug: "api", origin: target.value });
          return "ap_env";
        },
      },
    });
    try {
      const info = await host.addServer({
        id: "envsrv",
        name: "Env",
        trust: "bundled",
        transport: {
          kind: "stdio",
          command: [process.execPath, ENV_SERVER],
          env: { API_TOKEN: "{{cred:api}}" },
        },
      });
      expect(info.status).toBe("connected");
      const { toolsListHash, tools } = await host.listTools("envsrv");
      const len = await host.callTool("envsrv", "token_length", {}, { toolsListHash });
      expect(text(len.content)).toBe(String(secret.length));
      const ok = await host.callTool(
        "envsrv",
        "token_matches",
        { guess: "nope" },
        { toolsListHash },
      );
      expect(text(ok.content)).toBe("false");
      assertNoSecrets({
        info,
        tools,
        describe: host.describe("envsrv"),
        servers: await host.listServers(),
      });
      expect(vault.uses).toEqual([
        expect.objectContaining({
          target: "mcp:envsrv",
          approvalId: "ap_env",
          executor: "connector",
        }),
      ]);
    } finally {
      await host.close();
    }
  });

  it("a declined injection leaves the server unstarted", async () => {
    const vault = new FakeCredentialBroker();
    vault.add({
      slug: "api",
      kind: "api_key",
      secret: "zzzzzzzzzzzz",
      bindings: [{ connector: "mcp:envsrv" }],
    });
    const host = new PsycheMcpHost({
      bundledServerIds: ["envsrv"],
      launcher: directLauncher(),
      secrets: {
        credentials: vault,
        approve: async () => {
          throw new Error("owner declined");
        },
      },
    });
    const info = await host.addServer({
      id: "envsrv",
      name: "Env",
      trust: "bundled",
      transport: {
        kind: "stdio",
        command: [process.execPath, ENV_SERVER],
        env: { API_TOKEN: "{{cred:api}}" },
      },
    });
    expect(info.status).toBe("error");
    expect(vault.uses).toEqual([]);
  });
});
