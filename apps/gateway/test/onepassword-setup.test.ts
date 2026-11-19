import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { updateDevice } from "@psyche/db";
import type { OnePasswordSetupStatus, OnePasswordTestResult } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import {
  checkOpPath,
  OP_IDENTIFIER,
  OP_REQUIREMENT,
  type RunOp,
} from "../src/compose/onepassword-setup.ts";
import { releaseAllGatewayLocks } from "../src/pre-update.ts";
import { adminClient, desktopClient, ik, newDeviceKey, type TestClient } from "./helpers.ts";

/**
 * Guided 1Password setup. `op` is a fake: an empty executable file for the Gateway to find, and an
 * injected runner that plays its answers. The real `op` is never run, so nothing here can ask the
 * owner's 1Password to unlock.
 */

const SECRET = "SECRET-ITEM-VALUE-do-not-leak";
const STDERR = "SECRET-STDERR-do-not-leak";
const NO_ACCOUNT = "No accounts configured for use with 1Password CLI.";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  releaseAllGatewayLocks();
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

/** A folder with an `op` executable in it (empty: the runner plays it). */
function opFolder(): string {
  const dir = tmp("psyche-op-bin-");
  chmodSync(dir, 0o755);
  writeFileSync(join(dir, "op"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  chmodSync(join(dir, "op"), 0o755);
  return dir;
}

interface Script {
  /** `op account list --format json` */
  accounts?: unknown[] | "none" | { fail: string };
  /** `op whoami --format json` */
  whoami?: { url: string; email: string } | { fail: string; killed?: boolean };
  /** `op vault list --format json` */
  vaults?: unknown[] | { fail: string };
  /** Holds `op account list` until released (a slow 1Password). */
  gate?: Promise<void>;
}

function fakeOp(script: Script) {
  const calls: { file: string; args: string[]; env: Record<string, string> }[] = [];
  const run: RunOp = async (file, args, env) => {
    calls.push({ file, args, env });
    const fail = (stderr: string, killed = false) =>
      Promise.reject(Object.assign(new Error("op failed"), { stderr, killed }));
    const key = args.slice(0, 2).join(" ");
    if (key === "account list") {
      await script.gate;
      const a = script.accounts ?? [{ url: "my.1password.com", email: "owner@example.com" }];
      if (a === "none") return { stdout: "", stderr: NO_ACCOUNT };
      if ("fail" in a) return fail(a.fail);
      return { stdout: JSON.stringify(a), stderr: "" };
    }
    if (args[0] === "whoami") {
      const w = script.whoami ?? { url: "my.1password.com", email: "owner@example.com" };
      if ("fail" in w) return fail(w.fail, w.killed);
      return {
        stdout: JSON.stringify({ ...w, user_uuid: "UUID1", account_uuid: "UUID2" }),
        stderr: "",
      };
    }
    if (key === "vault list") {
      const v = script.vaults ?? [
        { id: "v1", name: "Personal" },
        { id: "v2", name: "Work" },
      ];
      if ("fail" in v) return fail(v.fail);
      return { stdout: JSON.stringify(v), stderr: "" };
    }
    if (args[0] === "read") return { stdout: SECRET, stderr: "" };
    return fail(`${STDERR} unexpected ${args.join(" ")}`);
  };
  return { run, calls };
}

interface Boot {
  script?: Script;
  path?: string;
  config?: boolean;
  home?: string;
  /** Plays `codesign --verify` for 1Password's team: true = signed by it. */
  signed?: (path: string, requirement: string) => boolean;
  /** Holds the next codesign check until released (a slow check). */
  hold?: { next?: Promise<void> };
  platform?: NodeJS.Platform;
}

async function boot(b: Boot = {}) {
  const home = b.home ?? tmp("psyche-gw-op-");
  const keyFile = join(home, "vault.key");
  writeFileSync(keyFile, Buffer.alloc(32, 5), { mode: 0o600 });
  const op = fakeOp(b.script ?? {});
  const codesigns: string[] = [];
  const composed: ComposedGateway = await composeGateway({
    env: {},
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
    vault: {
      keyFile,
      argon2: { memory: 64, passes: 1, parallelism: 1 },
      ...(b.config === true
        ? {
            onePassword: {
              kind: "cli" as const,
              readField: async () => "x",
              unavailableReason: async () => null,
            } as never,
          }
        : {}),
    },
    onePasswordSetup: {
      run: op.run,
      path: b.path ?? opFolder(),
      dirs: [],
      platform: b.platform ?? "darwin",
      codesign: async (p: string, requirement: string) => {
        codesigns.push(p);
        const h = b.hold?.next;
        if (b.hold !== undefined) b.hold.next = undefined;
        await h;
        return (b.signed ?? (() => true))(p, requirement);
      },
    },
  });
  let stopped = false;
  const stop = async (why: string) => {
    if (stopped) return;
    stopped = true;
    await composed.stop(why);
  };
  cleanups.push(() => stop("test"));
  if (b.home === undefined) await composed.vault.setup();
  const admin = await adminClient(composed.gateway);
  cleanups.push(() => admin.close());
  return { composed, admin, op, home, stop, codesigns };
}

async function pairDevice(composed: ComposedGateway, id: string, scopes: string[]) {
  const key = newDeviceKey();
  (await desktopClient(composed.gateway, key, id)).close();
  updateDevice(composed.gateway.context.db, id, { scopes: scopes as never });
  const c = await desktopClient(composed.gateway, key, id);
  cleanups.push(() => c.close());
  return c;
}

const status = (c: TestClient, probe = true) =>
  c.call<OnePasswordSetupStatus>("vault.onePassword.status", { probe });
const opRuns = (calls: { args: string[] }[]) => calls.filter((c) => c.args[0] === "account").length;

describe("vault.onePassword.status: one answer per state", () => {
  it("not_installed: no op on PATH", async () => {
    const { admin, op } = await boot({ path: tmp("psyche-empty-") });
    expect(await status(admin)).toEqual({ state: "not_installed", connected: false, os: "macos" });
    expect(op.calls).toHaveLength(0);
  });

  it("not_integrated: op finds no account (stderr says so, or an empty list)", async () => {
    for (const accounts of ["none", []] as Script["accounts"][]) {
      const { admin } = await boot({ script: { accounts } });
      const s = await status(admin);
      expect(s.state).toBe("not_integrated");
      expect(s.op?.path).toContain("op");
      expect(s.account).toBeUndefined();
    }
    const { admin } = await boot({ script: { accounts: { fail: NO_ACCOUNT } } });
    expect((await status(admin)).state).toBe("not_integrated");
  });

  it("locked: an account exists but whoami wants 1Password unlocked", async () => {
    for (const whoami of [
      { fail: "[ERROR] account is not signed in" },
      { fail: "1Password is locked" },
      { fail: "", killed: true },
    ]) {
      const { admin } = await boot({ script: { whoami } });
      expect((await status(admin)).state).toBe("locked");
    }
  });

  it("signed_in: names the account, not the ids", async () => {
    const { admin, op } = await boot();
    const s = await status(admin);
    expect(s).toMatchObject({
      state: "signed_in",
      connected: false,
      account: { url: "my.1password.com", email: "owner@example.com" },
    });
    expect(JSON.stringify(s)).not.toContain("UUID");
    // Only the two account commands ran, without a token in the child's environment.
    expect(op.calls.map((c) => c.args[0])).toEqual(["account", "whoami"]);
    for (const c of op.calls) expect(Object.keys(c.env)).not.toContain("OP_SERVICE_ACCOUNT_TOKEN");
  });

  it("error: op fails some other way, or answers garbage", async () => {
    const a = await boot({ script: { accounts: { fail: `${STDERR} boom` } } });
    expect((await status(a.admin)).state).toBe("error");
    const b = await boot({ script: { whoami: { fail: `${STDERR} segfault` } } });
    expect((await status(b.admin)).state).toBe("error");
    const c = await boot({ script: { accounts: "none" } });
    expect((await status(c.admin)).state).toBe("not_integrated");
  });

  it("never returns what op printed on failure", async () => {
    const { admin } = await boot({ script: { whoami: { fail: `${STDERR} locked` } } });
    expect(JSON.stringify(await status(admin))).not.toContain(STDERR);
  });
});

describe("vault.onePassword.test", () => {
  it("counts vaults and nothing else", async () => {
    const { admin, op } = await boot();
    const res = await admin.call<OnePasswordTestResult>("vault.onePassword.test", {});
    expect(res.vaultCount).toBe(2);
    expect(res.status.state).toBe("signed_in");
    const text = JSON.stringify(res);
    expect(text).not.toContain("Personal");
    expect(text).not.toContain("Work");
    expect(op.calls.some((c) => c.args[0] === "read")).toBe(false);
  });

  it("is refused with the state while 1Password is not ready", async () => {
    const { admin } = await boot({ script: { whoami: { fail: "not signed in" } } });
    const res = await admin.request("vault.onePassword.test", {});
    expect(res.error).toMatchObject({ code: "unavailable", details: { reason: "locked" } });
  });

  it("an op failure while listing carries no output", async () => {
    const { admin } = await boot({ script: { vaults: { fail: `${STDERR} nope` } } });
    const res = await admin.request("vault.onePassword.test", {});
    expect(res.error).toMatchObject({ code: "unavailable", details: { reason: "op_failed" } });
    expect(JSON.stringify(res)).not.toContain(STDERR);
  });
});

describe("connect and disconnect", () => {
  const item = {
    source: "1password" as const,
    kind: "login" as const,
    name: "Shop",
    bindings: [{ origin: "https://shop.example.com" }],
    ref: { vault: "Personal", item: "Shop" },
  };

  it("links items only while connected, with no restart", async () => {
    const { admin, op } = await boot();
    const before = await admin.request("vault.linkExternal", item, ik());
    expect(before.error).toMatchObject({ code: "unavailable" });

    const connected = await admin.call<OnePasswordSetupStatus>(
      "vault.onePassword.connect",
      {},
      ik(),
    );
    expect(connected).toMatchObject({ state: "signed_in", connected: true });
    expect((await status(admin)).connected).toBe(true);

    const linked = await admin.request("vault.linkExternal", item, ik());
    expect(linked.ok).toBe(true);
    expect(JSON.stringify(linked)).not.toContain(SECRET);
    for (const c of op.calls) expect(Object.keys(c.env)).not.toContain("OP_SERVICE_ACCOUNT_TOKEN");

    const off = await admin.call<OnePasswordSetupStatus>("vault.onePassword.disconnect", {}, ik());
    expect(off.connected).toBe(false);
    const after = await admin.request("vault.linkExternal", { ...item, name: "Shop 2" }, ik());
    expect(after.error).toMatchObject({ code: "unavailable" });
  });

  it("connect needs a signed-in op, and says which step is missing", async () => {
    const { admin, composed } = await boot({ script: { whoami: { fail: "not signed in" } } });
    const res = await admin.request("vault.onePassword.connect", {}, ik());
    expect(res.error).toMatchObject({ code: "conflict", details: { reason: "locked" } });
    expect((await status(admin)).connected).toBe(false);
    expect(await composed.audit.query({ kind: "vault.onepassword_connected" })).toHaveLength(0);
  });

  it("is audited with the device, and the audit holds no account or secret", async () => {
    const { admin, composed } = await boot();
    await admin.call("vault.onePassword.connect", {}, ik());
    await admin.call("vault.onePassword.disconnect", {}, ik());
    const on = (await composed.audit.query({ kind: "vault.onepassword_connected" }))[0];
    expect(on?.actor).toMatchObject({ type: "device" });
    expect(JSON.stringify(await composed.audit.query({}))).not.toContain("owner@example.com");
    expect(await composed.audit.query({ kind: "vault.onepassword_disconnected" })).toHaveLength(1);
  });

  it("stays connected across a restart, and a raw setting write cannot switch it on", async () => {
    const { admin, home, stop } = await boot();
    const raw = await admin.request("settings.set", {
      key: "_credentials.onePasswordApp",
      value: { on: true },
    });
    expect(raw.ok).toBe(false);
    await admin.call("vault.onePassword.connect", {}, ik());
    await admin.close();
    await stop("restart");
    releaseAllGatewayLocks();
    const again = await boot({ home });
    expect((await status(again.admin)).connected).toBe(true);
  });

  it("config.json's source wins: status says so and connect/disconnect are refused", async () => {
    const { admin } = await boot({ config: true });
    expect(await status(admin)).toMatchObject({ connected: false, managedBy: "config" });
    for (const m of ["vault.onePassword.connect", "vault.onePassword.disconnect"]) {
      const res = await admin.request(m, {}, ik());
      expect(res.error, m).toMatchObject({
        code: "conflict",
        details: { reason: "managed_by_config" },
      });
    }
  });
});

describe("who may ask", () => {
  it("a device without the admin scope gets forbidden, and op is never run", async () => {
    const { composed, op } = await boot();
    const reader = await pairDevice(composed, "reader-1", ["operator.read", "operator.write"]);
    for (const m of [
      "vault.onePassword.status",
      "vault.onePassword.test",
      "vault.onePassword.connect",
      "vault.onePassword.disconnect",
    ]) {
      const res = await reader.request(m, {}, ik());
      expect(res.ok, m).toBe(false);
      expect((res.error as { code?: string } | undefined)?.code, m).toBe("forbidden");
    }
    expect(op.calls).toHaveLength(0);
  });

  it("needs no presence: a plain admin call connects", async () => {
    const { admin } = await boot();
    const res = await admin.request("vault.onePassword.connect", {}, ik());
    expect(res.ok).toBe(true);
  });
});

describe("checkOpPath", () => {
  it("accepts a plain private executable and refuses the rest", () => {
    const dir = opFolder();
    expect(checkOpPath(join(dir, "op"))).toBeDefined();
    expect(checkOpPath("op")).toBeUndefined();
    expect(checkOpPath(join(dir, "missing"))).toBeUndefined();
    chmodSync(join(dir, "op"), 0o777);
    expect(checkOpPath(join(dir, "op"))).toBeUndefined();
    chmodSync(join(dir, "op"), 0o644);
    expect(checkOpPath(join(dir, "op"))).toBeUndefined();
  });

  it("refuses a file inside Psyche's own folder, and a folder others can write", () => {
    const home = tmp("psyche-home-");
    mkdirSync(join(home, "workspace"));
    writeFileSync(join(home, "workspace", "op"), "x", { mode: 0o755 });
    expect(checkOpPath(join(home, "workspace", "op"), { psycheHome: home })).toBeUndefined();
    const open = tmp("psyche-open-");
    writeFileSync(join(open, "op"), "x", { mode: 0o755 });
    chmodSync(open, 0o777);
    expect(checkOpPath(join(open, "op"))).toBeUndefined();
  });
});

describe("opening the panel is light (N2)", () => {
  it("runs no op at all for an owner who has not connected, however often it is asked", async () => {
    const { admin, op, codesigns } = await boot();
    for (let i = 0; i < 5; i++) {
      const s = await status(admin, false);
      expect(s).toMatchObject({ state: "found", connected: false });
      expect(s.account).toBeUndefined();
    }
    expect(op.calls).toHaveLength(0);
    // The signature of the same file is checked once.
    expect(codesigns).toHaveLength(1);
  });

  it("while connected, five status calls cost at most one round of op commands (60 s cache)", async () => {
    const { admin, op } = await boot();
    await admin.call("vault.onePassword.connect", {}, ik());
    const before = opRuns(op.calls);
    for (let i = 0; i < 5; i++) expect((await status(admin, false)).state).toBe("signed_in");
    expect(opRuns(op.calls) - before).toBeLessThanOrEqual(1);
  });

  it("Check again (probe) always asks op", async () => {
    const { admin, op } = await boot();
    await status(admin, true);
    await status(admin, true);
    expect(opRuns(op.calls)).toBe(2);
  });
});

describe("the op file is pinned (N1)", () => {
  /** PATH = [planted, real]: the planted folder starts empty, so connect pins the real one. */
  async function pinned(extra: Boot = {}) {
    const planted = tmp("psyche-op-planted-");
    chmodSync(planted, 0o755);
    const real = opFolder();
    const b = await boot({ path: `${planted}:${real}`, ...extra });
    return { ...b, planted, real };
  }

  it("an op planted earlier on PATH after connect is not run", async () => {
    const { admin, op, planted, real, composed } = await pinned();
    const setOp = vi.spyOn(composed.vault, "setOnePassword");
    await admin.call("vault.onePassword.connect", {}, ik());
    writeFileSync(join(planted, "op"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(join(planted, "op"), 0o755);
    op.calls.length = 0;

    const s = await status(admin, true);
    expect(s).toMatchObject({ state: "signed_in", connected: true });
    for (const c of op.calls) expect(c.file).toBe(realpathSync(join(real, "op")));

    // A fill reads through the pinned file too, with the connected account.
    const source = setOp.mock.calls[0]?.[0];
    expect(await source?.readField({ vault: "V", item: "I" }, "password")).toBe(SECRET);
    const read = op.calls.find((c) => c.args[0] === "read");
    expect(read?.file).toBe(realpathSync(join(real, "op")));
    expect(read?.env.OP_ACCOUNT).toBe("my.1password.com");
    expect(Object.keys(read?.env ?? {})).not.toContain("OP_SERVICE_ACCOUNT_TOKEN");
  });

  it("an op that is not signed by 1Password is refused at connect, and never run", async () => {
    const { admin, op, composed } = await boot({ signed: () => false });
    const s = await status(admin, true);
    expect(s).toMatchObject({ state: "error", problem: "op_unsigned" });
    const res = await admin.request("vault.onePassword.connect", {}, ik());
    expect(res.error).toMatchObject({ code: "conflict", details: { reason: "op_unsigned" } });
    expect(op.calls).toHaveLength(0);
    expect((await status(admin, false)).connected).toBe(false);
    expect(await composed.audit.query({ kind: "vault.onepassword_connected" })).toHaveLength(0);
  });

  it("only an unsigned candidate is skipped when a signed one follows", async () => {
    const bad = opFolder();
    const good = opFolder();
    const { admin } = await boot({
      path: `${bad}:${good}`,
      signed: (p) => p.startsWith(realpathSync(good)),
    });
    const s = await status(admin, true);
    expect(s.state).toBe("signed_in");
    expect(s.op?.path).toBe(realpathSync(join(good, "op")));
  });

  it("a replaced binary that is not signed is refused at run time and the vault source answers unavailable", async () => {
    let signed = true;
    const { admin, real, op, composed } = await pinned({ signed: () => signed });
    const setOp = vi.spyOn(composed.vault, "setOnePassword");
    await admin.call("vault.onePassword.connect", {}, ik());
    const file = join(real, "op");
    rmSync(file);
    writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(file, 0o755);
    signed = false;
    op.calls.length = 0;

    const s = await status(admin, true);
    expect(s).toMatchObject({ state: "error", connected: true, problem: "op_changed" });
    const source = setOp.mock.calls[0]?.[0];
    await expect(source?.readField({ vault: "V", item: "I" }, "password")).rejects.toMatchObject({
      code: "unavailable",
      details: { reason: "op_changed" },
    });
    expect(op.calls).toHaveLength(0);
    // Disconnect still works, and Connect pins the new file after a fresh look.
    await admin.call("vault.onePassword.disconnect", {}, ik());
    writeFileSync(file, "#!/bin/sh\nexit 3\n"); // a fresh, signed build
    signed = true;
    const again = await admin.call<OnePasswordSetupStatus>("vault.onePassword.connect", {}, ik());
    expect(again.connected).toBe(true);
  });

  it("the same file changed in place is checked again, and refused when it lost its signature", async () => {
    let signed = true;
    const { admin, real, codesigns } = await pinned({ signed: () => signed });
    await admin.call("vault.onePassword.connect", {}, ik());
    const n = codesigns.length;
    await status(admin, true);
    expect(codesigns.length).toBe(n); // cached by (dev, ino, mtime)
    signed = false;
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(real, "op"), future, future);
    const s = await status(admin, true);
    expect(s).toMatchObject({ state: "error", problem: "op_unsigned" });
    expect(codesigns.length).toBe(n + 1);
  });

  it("skips the signature check off macOS", async () => {
    const { admin, codesigns } = await boot({ platform: "linux" });
    expect((await status(admin, false)).os).toBe("other");
    expect(codesigns).toHaveLength(0);
  });
});

describe("races and records", () => {
  it("a Disconnect during Connect's wait wins", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { admin, op } = await boot({ script: { gate } });
    const connecting = admin.request("vault.onePassword.connect", {}, ik());
    while (op.calls.length === 0) await new Promise((r) => setTimeout(r, 5));
    await admin.call("vault.onePassword.disconnect", {}, ik());
    release();
    const res = await connecting;
    expect(res.error).toMatchObject({ code: "conflict", details: { reason: "changed" } });
    expect((await status(admin, false)).connected).toBe(false);
  });

  it("a restart that reconnects is on the record as the app source", async () => {
    const { admin, home, stop } = await boot();
    await admin.call("vault.onePassword.connect", {}, ik());
    await admin.close();
    await stop("restart");
    releaseAllGatewayLocks();
    const again = await boot({ home });
    const entries = await again.composed.audit.query({ kind: "vault.external_source" });
    expect(entries.some((e) => (e.data as { kind?: string }).kind === "app")).toBe(true);
    expect(JSON.stringify(entries)).not.toContain("owner@example.com");
  });
});

describe("checkOpPath ancestors (N3)", () => {
  it("refuses a world-writable folder anywhere above the file, not just its parent", () => {
    const top = tmp("psyche-anc-");
    const mid = join(top, "mid");
    const bin = join(mid, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "op"), "x", { mode: 0o755 });
    chmodSync(join(bin, "op"), 0o755);
    expect(checkOpPath(join(bin, "op"))).toBeDefined();
    chmodSync(mid, 0o777);
    expect(checkOpPath(join(bin, "op"))).toBeUndefined();
  });

  it("finds Psyche's folder by identity, however the path is spelled", () => {
    const root = tmp("psyche-alias-");
    const home = join(root, "home");
    mkdirSync(join(home, "workspace"), { recursive: true });
    writeFileSync(join(home, "workspace", "op"), "x", { mode: 0o755 });
    chmodSync(join(home, "workspace", "op"), 0o755);
    const alias = join(root, "alias");
    symlinkSync(home, alias);
    expect(checkOpPath(join(alias, "workspace", "op"), { psycheHome: home })).toBeUndefined();
    expect(checkOpPath(join(home, "workspace", "op"), { psycheHome: alias })).toBeUndefined();
    // A sibling folder with a similar name is not Psyche's.
    mkdirSync(join(root, "home2"));
    writeFileSync(join(root, "home2", "op"), "x", { mode: 0o755 });
    chmodSync(join(root, "home2", "op"), 0o755);
    expect(checkOpPath(join(root, "home2", "op"), { psycheHome: home })).toBeDefined();
  });
});

describe("signature cache cannot be fooled (R1)", () => {
  it("an in-place rewrite with the old mtime put back is checked again and refused", async () => {
    let signed = true;
    const dir = opFolder();
    const { admin, codesigns } = await boot({ path: dir, signed: () => signed });
    await admin.call("vault.onePassword.connect", {}, ik());
    const file = join(dir, "op");
    const before = statSync(file);
    const n = codesigns.length;
    signed = false;
    // Same inode, same size, same mtime: only ctime tells.
    writeFileSync(file, "#!/bin/sh\nexit 2\n");
    utimesSync(file, before.atime, before.mtime);
    expect(statSync(file).ino).toBe(before.ino);
    expect(statSync(file).size).toBe(before.size);
    const s = await status(admin, true);
    expect(codesigns.length).toBe(n + 1);
    expect(s).toMatchObject({ state: "error", problem: "op_unsigned" });
  });
});

describe("an upgrade moves the op file (R3)", () => {
  /** stable/op -> versions/<v>/op, like a Homebrew cask. */
  function cask() {
    const root = tmp("psyche-cask-");
    chmodSync(root, 0o755);
    const stable = join(root, "bin");
    mkdirSync(stable);
    const install = (v: string) => {
      const d = join(root, "versions", v);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "op"), `#!/bin/sh\n# ${v}\n`, { mode: 0o755 });
      chmodSync(join(d, "op"), 0o755);
      return d;
    };
    const point = (v: string) => {
      rmSync(join(stable, "op"), { force: true });
      symlinkSync(join(root, "versions", v, "op"), join(stable, "op"));
    };
    return { root, stable, install, point };
  }

  it("re-pins to the one signed candidate, and says so in the audit", async () => {
    const c = cask();
    c.install("1");
    c.point("1");
    const { admin, composed } = await boot({ path: c.stable });
    await admin.call("vault.onePassword.connect", {}, ik());
    c.install("2");
    c.point("2");
    rmSync(join(c.root, "versions", "1"), { recursive: true });

    const s = await status(admin, true);
    expect(s).toMatchObject({ state: "signed_in", connected: true });
    expect(s.op?.path).toBe(realpathSync(join(c.root, "versions", "2", "op")));
    expect(s.repinnedAt).toBeGreaterThan(0);
    const entries = await composed.audit.query({ kind: "vault.external_source" });
    expect(entries.some((e) => (e.data as { repinned?: boolean }).repinned === true)).toBe(true);
    // Now pinned to the new file: a second look does not re-pin again.
    await status(admin, true);
    const again = await composed.audit.query({ kind: "vault.external_source" });
    expect(again.filter((e) => (e.data as { repinned?: boolean }).repinned === true)).toHaveLength(
      1,
    );
  });

  it("does not re-pin to an unsigned new candidate", async () => {
    const c = cask();
    c.install("1");
    c.point("1");
    const { admin, composed } = await boot({
      path: c.stable,
      signed: (p) => !p.includes(`${sep}2${sep}`),
    });
    await admin.call("vault.onePassword.connect", {}, ik());
    c.install("2");
    c.point("2");
    rmSync(join(c.root, "versions", "1"), { recursive: true });
    const s = await status(admin, true);
    expect(s).toMatchObject({ state: "error", connected: true, problem: "op_changed" });
    const entries = await composed.audit.query({ kind: "vault.external_source" });
    expect(entries.some((e) => (e.data as { repinned?: boolean }).repinned === true)).toBe(false);
  });

  it("does not re-pin to a signed copy found through another PATH folder", async () => {
    const c = cask();
    c.install("1");
    c.point("1");
    const other = opFolder();
    const { admin, composed } = await boot({ path: `${c.stable}:${other}` });
    await admin.call("vault.onePassword.connect", {}, ik());
    // The upgrade removed the old version and the symlink dangles; a signed op sits elsewhere.
    rmSync(join(c.root, "versions", "1"), { recursive: true });
    const s = await status(admin, true);
    expect(s).toMatchObject({ state: "error", connected: true, problem: "op_changed" });
    expect(s.repinnedAt).toBeUndefined();
    const entries = await composed.audit.query({ kind: "vault.external_source" });
    expect(entries.some((e) => (e.data as { repinned?: boolean }).repinned === true)).toBe(false);
  });

  it("never re-pins where the signature is not checked", async () => {
    const c = cask();
    c.install("1");
    c.point("1");
    const { admin } = await boot({ path: c.stable, platform: "linux" });
    await admin.call("vault.onePassword.connect", {}, ik());
    c.install("2");
    c.point("2");
    rmSync(join(c.root, "versions", "1"), { recursive: true });
    expect((await status(admin, true)).problem).toBe("op_changed");
  });
});

describe("the startup audit tells the truth (R5)", () => {
  it("records available: false when the pinned file is gone", async () => {
    const dir = opFolder();
    const { admin, home, stop } = await boot({ path: dir });
    await admin.call("vault.onePassword.connect", {}, ik());
    await admin.close();
    await stop("restart");
    releaseAllGatewayLocks();
    rmSync(join(dir, "op"));
    const again = await boot({ home, path: tmp("psyche-empty-") });
    const entries = await again.composed.audit.query({ kind: "vault.external_source" });
    const startup = entries.filter((e) => (e.data as { kind?: string }).kind === "app");
    expect(startup.at(-1)?.data).toMatchObject({ available: false });
  });
});

describe("checkOpPath, tighter again (R2)", () => {
  function opIn(mode: number): string {
    const top = tmp("psyche-mode-");
    const bin = join(top, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "op"), "x", { mode: 0o755 });
    chmodSync(join(bin, "op"), 0o755);
    chmodSync(bin, mode);
    return join(bin, "op");
  }

  it("refuses a group-writable folder, however the group is meant", () => {
    expect(checkOpPath(opIn(0o755))).toBeDefined();
    expect(checkOpPath(opIn(0o775))).toBeUndefined();
    expect(checkOpPath(opIn(0o770))).toBeUndefined();
    expect(checkOpPath(opIn(0o777))).toBeUndefined();
  });

  it("looks at the folder of a symlink as given, not only at its target", () => {
    const top = tmp("psyche-sym-");
    const open = join(top, "open");
    mkdirSync(open);
    symlinkSync("/bin/sh", join(open, "op"));
    chmodSync(open, 0o777);
    expect(checkOpPath(join(open, "op"))).toBeUndefined();
  });

  it("refuses a folder owned by someone else", () => {
    const op = opIn(0o755);
    // Pretend the Gateway runs as another user: the folders (and the file) are not theirs.
    expect(checkOpPath(op, { uid: (process.getuid?.() ?? 1000) + 1 })).toBeUndefined();
  });
});

describe("a re-pin cannot undo a Disconnect (B1)", () => {
  it("a Disconnect made while the new file's signature is checked wins, also after a restart", async () => {
    const root = tmp("psyche-race-");
    chmodSync(root, 0o755);
    const stable = join(root, "bin");
    mkdirSync(stable);
    const install = (v: string) => {
      const d = join(root, "versions", v);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "op"), `#!/bin/sh\n# ${v}\n`, { mode: 0o755 });
      chmodSync(join(d, "op"), 0o755);
      rmSync(join(stable, "op"), { force: true });
      symlinkSync(join(d, "op"), join(stable, "op"));
    };
    install("1");
    const hold: { next?: Promise<void> } = {};
    const { admin, composed, codesigns, home, stop } = await boot({ path: stable, hold });
    const setOp = vi.spyOn(composed.vault, "setOnePassword");
    await admin.call("vault.onePassword.connect", {}, ik());
    install("2");
    rmSync(join(root, "versions", "1"), { recursive: true });

    // A fill finds the pinned file gone and starts to re-pin; its signature check is slow.
    let release = () => {};
    hold.next = new Promise<void>((r) => {
      release = r;
    });
    const n = codesigns.length;
    const fill = setOp.mock.calls[0]?.[0]?.readField({ vault: "V", item: "I" }, "password");
    const settled = fill?.then(
      () => "read",
      (e: { details?: { reason?: string } }) => e.details?.reason,
    );
    while (codesigns.length === n) await new Promise((r) => setTimeout(r, 5));

    await admin.call("vault.onePassword.disconnect", {}, ik());
    release();
    expect(await settled).toBe("op_changed");

    expect((await status(admin, false)).connected).toBe(false);
    expect(await composed.audit.query({ kind: "vault.external_source" })).toHaveLength(0);
    await admin.close();
    await stop("restart");
    releaseAllGatewayLocks();
    const again = await boot({ home, path: stable });
    expect((await status(again.admin, false)).connected).toBe(false);
  });
});

describe("the binary's identifier is pinned too (N1)", () => {
  const identOf = (other: string) => (p: string, requirement: string) => {
    const want = /identifier "([^"]+)"/.exec(requirement)?.[1];
    return (p.startsWith(other) ? "com.agilebits.other" : OP_IDENTIFIER) === want;
  };

  it("asks for the identifier and the team", () => {
    expect(OP_REQUIREMENT).toContain(`identifier "${OP_IDENTIFIER}" and anchor apple generic`);
    expect(OP_REQUIREMENT).toContain('certificate leaf[subject.OU] = "2BUA8C4S2C"');
    // Pinned verbatim: the codesign stub can't catch a wrong constant (round 4 of #1375).
    expect(OP_IDENTIFIER).toBe("com.1password.op");
    expect(OP_REQUIREMENT).toBe(
      'identifier "com.1password.op" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = "2BUA8C4S2C"',
    );
  });

  it("another binary signed by the same team with a different identifier is refused", async () => {
    const other = opFolder();
    const { admin, op } = await boot({
      path: other,
      signed: identOf(realpathSync(other)),
    });
    expect(await status(admin, true)).toMatchObject({ state: "error", problem: "op_unsigned" });
    const res = await admin.request("vault.onePassword.connect", {}, ik());
    expect(res.error).toMatchObject({ code: "conflict", details: { reason: "op_unsigned" } });
    expect(op.calls).toHaveLength(0);
  });

  it("skips it for a genuine one further along PATH", async () => {
    const other = opFolder();
    const good = opFolder();
    const { admin } = await boot({
      path: `${other}:${good}`,
      signed: identOf(realpathSync(other)),
    });
    const s = await status(admin, true);
    expect(s.state).toBe("signed_in");
    expect(s.op?.path).toBe(realpathSync(join(good, "op")));
  });
});

describe("a refused folder is named (N4)", () => {
  it("reports op_unsafe_folder, not not_installed, and does not loosen the rule", async () => {
    const dir = opFolder();
    chmodSync(dir, 0o775);
    const { admin, op } = await boot({ path: dir });
    const s = await status(admin, true);
    expect(s).toMatchObject({ state: "error", problem: "op_unsafe_folder" });
    expect(s.op).toBeUndefined();
    const res = await admin.request("vault.onePassword.connect", {}, ik());
    expect(res.error).toMatchObject({ code: "conflict", details: { reason: "op_unsafe_folder" } });
    expect(op.calls).toHaveLength(0);
  });

  it("still says not_installed when there is no op at all", async () => {
    const { admin } = await boot({ path: tmp("psyche-empty-") });
    expect((await status(admin, true)).state).toBe("not_installed");
  });
});
