import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { FakeCredentialBroker } from "@psyche/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Relative imports, as the scenario runner does: this suite is not a dependency of either package.
import {
  containerLauncher,
  PsycheMcpHost,
  type SandboxStdioHost,
} from "../../../packages/mcp-host/src/index.ts";
import {
  buildImage,
  createSandboxRunner,
  localImageTag,
} from "../../../packages/sandbox/src/index.ts";

/**
 * Feature M3 "done when": a malicious stdio MCP server cannot read `~/.psyche/vault`. The probe
 * server tries to read a vault file the test plants on the host, `~/.ssh` and the host
 * environment from inside its sandbox container.
 *
 * Runs on CI (and locally only with PSYCHE_SANDBOX_TESTS=1, since it starts a container);
 * PSYCHE_SANDBOX_TESTS=0 always skips. Needs a container backend; builds the `core` image like
 * the sandbox suite.
 */
const optIn =
  process.env.PSYCHE_SANDBOX_TESTS !== "0" &&
  (process.env.PSYCHE_SANDBOX_TESTS === "1" || process.env.CI === "true");
const runner = createSandboxRunner({ image: localImageTag("core"), namePrefix: "psyche-m3test" });
// Compile-time proof that the real runner is what the container launcher needs (#143).
const stdioHost: SandboxStdioHost = runner;
const backend = optIn ? await runner.backend() : null;
const enabled = backend !== null;
if (!enabled) {
  console.warn(
    `[mcp-sandbox] skipped: ${!optIn ? "runs on CI or with PSYCHE_SANDBOX_TESTS=1" : "no container backend"}`,
  );
}

const text = (content: unknown) =>
  (content as { blocks: { text?: string }[] }).blocks.map((b) => b.text ?? "").join("");

describe.skipIf(!enabled)("stdio MCP server in the real sandbox container (M3)", () => {
  let psycheHome: string;
  let host: PsycheMcpHost;
  const marker = `vault-marker-${process.pid}`;
  const secret = "sk_live_psyche_m3_isolation_secret_19";

  beforeAll(async () => {
    if (backend !== null) await buildImage(backend, "core", { timeoutMs: 15 * 60_000 });
    psycheHome = await mkdtemp(join(tmpdir(), "psyche-home-"));
    await mkdir(join(psycheHome, "vault"), { recursive: true });
    await writeFile(join(psycheHome, "vault", "vault.db"), marker);
    process.env.PSYCHE_TEST_HOST_SECRET = "host-env-only";
    const vault = new FakeCredentialBroker();
    vault.add({
      slug: "probe-key",
      kind: "api_key",
      secret,
      bindings: [{ connector: "mcp:probe" }],
    });
    host = new PsycheMcpHost({
      launcher: containerLauncher({ sandbox: stdioHost }),
      secrets: {
        credentials: vault,
        async approve({ target }) {
          vault.approve("ap_probe", { slug: "probe-key", origin: target.value });
          return "ap_probe";
        },
      },
    });
    const source = await readFile(
      new URL("../../../packages/mcp-host/test/fixtures/probe-server.mjs", import.meta.url),
      "utf8",
    );
    const info = await host.addServer({
      id: "probe",
      name: "Probe",
      trust: "unknown",
      transport: {
        kind: "stdio",
        command: ["node", "--input-type=module", "-e", source],
        env: { API_TOKEN: "{{cred:probe-key}}" },
      },
    });
    expect(info.status, host.describe("probe").error).toBe("connected");
  }, 20 * 60_000);

  afterAll(async () => {
    delete process.env.PSYCHE_TEST_HOST_SECRET;
    await host?.close();
    await runner.dispose({ remove: true }).catch(() => undefined);
    await rm(psycheHome, { recursive: true, force: true });
  });

  it("cannot read the host vault, ~/.ssh or the host's files", async () => {
    const { toolsListHash } = await host.listTools("probe");
    const read = async (path: string) =>
      text((await host.callTool("probe", "read_file", { path }, { toolsListHash })).content);
    expect(await read(join(psycheHome, "vault", "vault.db"))).toMatch(/^ERR:/);
    expect(await read(join(homedir(), ".ssh", "id_ed25519"))).toMatch(/^ERR:/);
    expect(await read(join(homedir(), ".psyche", "vault", "vault.db"))).toMatch(/^ERR:/);
  });

  it("sees its own vault-injected env and none of the host's", async () => {
    const { toolsListHash } = await host.listTools("probe");
    const names = text(
      (await host.callTool("probe", "env_names", {}, { toolsListHash })).content,
    ).split(",");
    expect(names).toContain("API_TOKEN");
    expect(names).not.toContain("PSYCHE_TEST_HOST_SECRET");
    const len = text(
      (await host.callTool("probe", "env_value_length", { name: "API_TOKEN" }, { toolsListHash }))
        .content,
    );
    expect(len).toBe(String(secret.length));
  });
});
