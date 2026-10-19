import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { type Gateway, startGateway } from "@psyche/gateway";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";
import type { Deps } from "../src/context.ts";
import { scriptedPrompter } from "../src/prompt.ts";

/**
 * The CLI against the real Gateway (apps/gateway, in process): first contact creates a pending
 * pairing request, the owner approves it with `psyched devices approve <code>`, then the CLI's
 * commands work over the real handshake and handlers.
 */

let home: string;
let gateway: Gateway;
const quiet = { log: () => {} };

function deps(): Deps & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    env: { HOME: home, PSYCHE_HOME: home },
    io: { out: (t) => stdout.push(t), err: (t) => stderr.push(t), stdin: new PassThrough() },
    exec: async () => ({ code: 1, stdout: "", stderr: "" }),
    fetch,
    prompter: scriptedPrompter([], false),
    platform: "linux",
    uid: 501,
    now: () => new Date(),
  };
}

async function cli(...argv: string[]) {
  const d = deps();
  const code = await run([...argv, "--url", gateway.origin, "--json"], d);
  return { code, json: JSON.parse(d.stdout.join("\n") || "null") as Record<string, unknown> };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "psy-cli-"));
  gateway = await startGateway({
    config: { home, port: 0, webRoot: null },
    env: {},
    logger: quiet as never,
    retentionIntervalMs: 0,
  });
});

afterAll(async () => {
  await gateway?.stop("test");
  rmSync(home, { recursive: true, force: true });
});

describe("psyche against the real Gateway", () => {
  it("pairs through the owner's approval, then runs commands", async () => {
    const first = await cli("devices", "list");
    expect(first.code).toBe(3);
    const error = first.json.error as { code: string; details: { code: string } };
    expect(error.code).toBe("pairing");

    // The owner approves on the Gateway host (default: every operator scope, the first admin).
    const psyched = resolve(import.meta.dirname, "../../gateway/src/main.ts");
    const out = execFileSync(
      process.execPath,
      [psyched, "devices", "approve", error.details.code],
      {
        env: { ...process.env, PSYCHE_HOME: home },
        encoding: "utf8",
      },
    );
    expect(out).toMatch(/approved/);

    const list = await cli("devices", "list");
    expect(list.code).toBe(0);
    const devices = list.json.devices as { name: string; scopes: string[] }[];
    expect(devices).toHaveLength(1);
    expect(devices[0]?.scopes).toContain("operator.admin");

    expect((await cli("config", "set", "appearance.theme", "dark")).code).toBe(0);
    const got = await cli("config", "get", "appearance.theme");
    expect((got.json.settings as Record<string, unknown>)["appearance.theme"]).toBe("dark");

    const status = await cli("status");
    expect(status.code).toBe(0);
    expect((status.json.cli as { paired: boolean }).paired).toBe(true);

    expect((await cli("pairing", "list")).json.pairingRequests).toEqual([]);
  });

  it("reports methods the Gateway does not serve yet as unavailable", async () => {
    const r = await cli("skills", "list");
    expect(r.code).toBe(1);
    expect((r.json.error as { code: string }).code).toBe("unavailable");
  });

  it("doctor passes and security audit finds nothing on a default install", async () => {
    const doctor = await cli("doctor");
    const checks = doctor.json.checks as { id: string; status: string }[];
    expect(checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(checks.find((c) => c.id === "auth")?.status).toBe("ok");
    const audit = await cli("security", "audit");
    expect(audit.json.findings).toEqual([]);
    expect(audit.code).toBe(0);
  });
});
