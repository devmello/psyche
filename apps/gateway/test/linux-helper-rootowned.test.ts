import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSetting } from "@psyche/db";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { HOST_HELPER_STATUS_SETTING } from "../src/nodes/registry.ts";
import {
  linuxPeerChecker,
  PACKAGED_HELPER,
  packagedHelperInstalled,
} from "../src/transports/peer-check.ts";
import { startTestGateway, type TestGateway } from "./helpers.ts";

/**
 * The packaged, root-owned helper against the real peer check, run as an ordinary user. Needs the
 * helper installed as root at `LINUX_PACKAGED_HELPER_PATH`, which `scripts/ci/linux-helper-
 * rootowned.sh` does (and removes again) before it sets `LINUX_HELPER_ROOTOWNED=1`. This is the
 * test that fixture-based checks cannot replace: the Gateway reads `/proc` as an unprivileged
 * user, and anything that needs privileges there (for instance following `map_files`) refuses
 * every real helper.
 */

const enabled =
  process.platform === "linux" &&
  process.env.LINUX_HELPER_ROOTOWNED === "1" &&
  process.getuid?.() !== 0 &&
  existsSync(PACKAGED_HELPER);

const status = (t: TestGateway) =>
  getSetting(t.gateway.context.db, HOST_HELPER_STATUS_SETTING)?.value as Record<string, unknown>;

async function until<T>(what: string, read: () => T | undefined, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = read();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!enabled)("the root-owned packaged helper, checked as an ordinary user", () => {
  const children: ChildProcess[] = [];
  const dirs: string[] = [];
  let t: TestGateway | null = null;

  const tmp = (prefix: string) => {
    const d = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(d);
    return d;
  };
  const start = async () => {
    await t?.cleanup();
    // Strict, as the real psyched is when the packaged helper is installed.
    t = await startTestGateway({
      peerChecker: linuxPeerChecker(),
      peerCheckRequired: () => packagedHelperInstalled(),
    });
    return t;
  };
  const spawnHelper = (bin: string, extraEnv: Record<string, string> = {}) => {
    const state = tmp("psyche-helper-state-");
    const child = spawn(bin, ["--idle-timeout", "0"], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: state,
        PSYCHE_HELPER_STATE: join(state, "state"),
        PSYCHE_HOME: (t as TestGateway).home,
        ...extraEnv,
      },
      stdio: "ignore",
    });
    children.push(child);
    return child;
  };

  afterEach(() => {
    for (const c of children.splice(0)) c.kill("SIGKILL");
  });
  afterAll(async () => {
    await t?.cleanup();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("is root_owned, and pairs as the Host helper", async () => {
    const g = await start();
    spawnHelper(PACKAGED_HELPER);
    const id = await until(
      "the helper to pair",
      () => g.gateway.context.nodes.hostHelpers()[0]?.info.id,
    );
    expect(g.gateway.context.nodes.isHostHelper(id)).toBe(true);
    expect(status(g)).toMatchObject({ peerCheck: "root_owned", peerCheckReason: "packaged" });
  }, 30000);

  it("a user-owned copy of the helper is refused, and the status says why", async () => {
    const g = await start();
    const copy = join(tmp("psyche-copy-"), "psyche-helper");
    copyFileSync(PACKAGED_HELPER, copy);
    chmodSync(copy, 0o755);
    spawnHelper(copy);
    const refused = await until(
      "the refusal",
      () => status(g)?.refused as Record<string, unknown> | undefined,
    );
    expect(refused).toMatchObject({ peerCheck: "user_owned", required: true });
    expect(g.gateway.context.nodes.hostHelpers()).toEqual([]);
  }, 30000);

  it("the packaged helper started with a loader path is a mismatch and is refused", async () => {
    const g = await start();
    spawnHelper(PACKAGED_HELPER, { LD_LIBRARY_PATH: tmpdir() });
    const refused = await until(
      "the refusal",
      () => status(g)?.refused as Record<string, unknown> | undefined,
    );
    expect(refused).toMatchObject({ peerCheck: "mismatch", reason: "loader_env", required: true });
    expect(g.gateway.context.nodes.hostHelpers()).toEqual([]);
  }, 30000);

  it("refuses to start with LD_PRELOAD set (hygiene), so it never connects", async () => {
    const g = await start();
    const child = spawnHelper(PACKAGED_HELPER, { LD_PRELOAD: "/nonexistent.so" });
    const code = await new Promise<number | null>((resolve) =>
      child.once("exit", (c) => resolve(c)),
    );
    expect(code).not.toBe(0);
    expect(g.gateway.context.nodes.hostHelpers()).toEqual([]);
  }, 30000);
});
