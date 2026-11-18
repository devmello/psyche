import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateDevice } from "@psyche/db";
import type { PresenceVerifier } from "@psyche/permissions";
import type { LinkSetupStatus } from "@psyche/protocol";

type Scope = "operator.read" | "operator.write" | "operator.approvals" | "operator.admin";

import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import {
  checkLinkCliPath,
  countOpenSpends,
  detectLinkClis,
  isLinkUrl,
  parseLogin,
  type RunLink,
  runFile,
  unwrapJson,
} from "../src/compose/link-setup.ts";
import { adminClient, desktopClient, ik, newDeviceKey, type TestClient } from "./helpers.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => {
    try {
      chmodSync(d, 0o700);
    } catch {}
    rmSync(d, { recursive: true, force: true });
  });
  return d;
}

const statRealpath = (p: string): string => realpathSync(p);

const TOKEN = "SECRET-TOKEN-do-not-leak-123";
const DEVICE_CODE = "SECRET-DEVICE-CODE-do-not-show-456";

/**
 * A stand-in for link-cli: state lives in LINK_AUTH_FILE; `<file>.approve` plays the owner signing
 * in on Link's page. Like the real one (built on incur) it prints `--format json` results as one
 * buffered ARRAY of what the command yielded, and `auth login` insists on `--no-financial-insights`.
 */
const cliSource = (esm: boolean) => `
${esm ? 'import fs from "node:fs";' : 'const fs = require("node:fs");'}
const file = process.env.LINK_AUTH_FILE;
const a = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify([o]));
if (a[0] === "auth" && a[1] === "login") {
  if (!a.includes("--no-financial-insights")) { process.stderr.write("${TOKEN}"); process.exit(3); }
  out({ verification_url: "https://login.link.com/device?c=1", phrase: "blue-otter-moon", device_code: "${DEVICE_CODE}" });
} else if (a[0] === "auth" && a[1] === "status") {
  if (fs.existsSync(file + ".approve") && !fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ access_token: "${TOKEN}" }), { mode: 0o644 });
  out({ authenticated: fs.existsSync(file) });
} else if (a[0] === "auth" && a[1] === "logout") { try { fs.unlinkSync(file); } catch {} out({ ok: true }); }
else if (a[0] === "payment-methods") process.stdout.write(JSON.stringify([{ id: "csmrpd_1", type: "card", card: { brand: "visa", last4: "1881" }, is_default: true }]));
else { process.stderr.write("${TOKEN}"); process.exit(2); }
`;

/** A Link CLI as npm lays it out: `<root>/package.json` and `<root>/dist/cli.<ext>`. */
function fakeCli(ext: "js" | "mjs" | "cjs" = "js", root = tmp("psyche-link-cli-")): string {
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@stripe/link-cli" }));
  const file = join(root, "dist", `cli.${ext}`);
  writeFileSync(file, cliSource(ext === "mjs"), { mode: 0o644 });
  return file;
}

describe("checkLinkCliPath", () => {
  it("accepts a real file in private folders and returns the resolved path", () => {
    const real = fakeCli();
    expect(checkLinkCliPath(real)).toEqual({ ok: true, real: statRealpath(real) });
  });

  it("follows a symlink and judges the target, never the link", () => {
    const real = fakeCli();
    const bin = tmp("psyche-link-bin-");
    symlinkSync(real, join(bin, "link-cli"));
    expect(checkLinkCliPath(join(bin, "link-cli"))).toEqual({ ok: true, real: statRealpath(real) });
    // A link to a program someone else can write is refused, however tidy the link's folder is.
    const bad = fakeCli();
    chmodSync(bad, 0o666);
    symlinkSync(bad, join(bin, "evil"));
    expect(checkLinkCliPath(join(bin, "evil"))).toEqual({ ok: false, reason: "writable" });
  });

  it.each([
    ["relative", "link-cli", "not_absolute"],
    ["missing", "/no/such/dir/link-cli", "missing"],
  ])("refuses a %s path", (_n, path, reason) => {
    expect(checkLinkCliPath(path)).toEqual({ ok: false, reason });
  });

  it("refuses a folder, a group-writable file and a file without exec rights", () => {
    const real = fakeCli();
    expect(checkLinkCliPath(join(real, ".."))).toEqual({ ok: false, reason: "not_a_file" });
    chmodSync(real, 0o664);
    expect(checkLinkCliPath(real)).toEqual({ ok: false, reason: "writable" });
    const plain = join(tmp("psyche-link-plain-"), "link-cli");
    writeFileSync(plain, "#!/bin/sh\n", { mode: 0o644 });
    expect(checkLinkCliPath(plain)).toEqual({ ok: false, reason: "not_executable" });
  });

  it("refuses a file under a folder others can write", () => {
    const real = fakeCli();
    chmodSync(join(real, ".."), 0o777);
    expect(checkLinkCliPath(real)).toEqual({ ok: false, reason: "parent_writable" });
    chmodSync(join(real, ".."), 0o770);
    expect(checkLinkCliPath(real)).toEqual({ ok: false, reason: "parent_writable" });
  });

  it.skipIf(process.getuid?.() === 0)("refuses another user's file or folder", () => {
    const real = fakeCli();
    const me = statSync(real).uid;
    expect(checkLinkCliPath(real, { uid: me + 1 })).toEqual({ ok: false, reason: "wrong_owner" });
    // The file is the user's but a folder above it is not.
    const dir = statRealpath(join(real, ".."));
    const lstat = (p: string) => {
      const s = statSync(p);
      return {
        uid: p === dir ? me + 1 : s.uid,
        mode: s.mode,
        isFile: () => s.isFile(),
        isDirectory: () => s.isDirectory(),
        isSymbolicLink: () => false,
      };
    };
    expect(checkLinkCliPath(real, { lstat })).toEqual({ ok: false, reason: "parent_wrong_owner" });
  });

  it("refuses anything inside Psyche's own folder, even a perfect copy of the package", () => {
    const home = tmp("psyche-home-");
    // A planted script (the agent can write under workspace/) that also fakes the package name.
    const planted = fakeCli("js", join(home, "workspace", "x"));
    expect(checkLinkCliPath(planted, { psycheHome: home })).toEqual({
      ok: false,
      reason: "in_psyche_home",
    });
    // Reached through a symlink from outside, the resolved path is what counts.
    const bin = tmp("psyche-link-bin-");
    symlinkSync(planted, join(bin, "link-cli"));
    expect(checkLinkCliPath(join(bin, "link-cli"), { psycheHome: home })).toEqual({
      ok: false,
      reason: "in_psyche_home",
    });
    // The same package outside the folder is fine.
    const outside = fakeCli();
    expect(checkLinkCliPath(outside, { psycheHome: home })).toMatchObject({ ok: true });
  });

  it("runs only scripts of the @stripe/link-cli package, and `.mjs` and `.cjs` count as scripts", () => {
    // A user-owned script on its own, or in some other package, is not the Link CLI.
    const lone = join(tmp("psyche-lone-"), "x.js");
    writeFileSync(lone, "console.log(1)", { mode: 0o644 });
    expect(checkLinkCliPath(lone)).toEqual({ ok: false, reason: "not_link_cli" });
    const other = fakeCli();
    writeFileSync(join(other, "..", "..", "package.json"), JSON.stringify({ name: "evil" }));
    expect(checkLinkCliPath(other)).toEqual({ ok: false, reason: "not_link_cli" });
    for (const ext of ["mjs", "cjs"] as const) {
      const real = fakeCli(ext);
      expect(checkLinkCliPath(real)).toEqual({ ok: true, real: statRealpath(real) });
      writeFileSync(join(real, "..", "..", "package.json"), "{}");
      expect(checkLinkCliPath(real)).toEqual({ ok: false, reason: "not_link_cli" });
    }
    // A program (not a script) needs no package, only its execute bit.
    const bin = join(tmp("psyche-exe-"), "link-cli");
    writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
    expect(checkLinkCliPath(bin)).toMatchObject({ ok: true });
  });

  it("refuses Volta's shim, which runs whichever tool its own name says", () => {
    const dir = tmp("psyche-volta-");
    writeFileSync(join(dir, "volta-shim"), "#!/bin/sh\n", { mode: 0o755 });
    symlinkSync(join(dir, "volta-shim"), join(dir, "link-cli"));
    expect(checkLinkCliPath(join(dir, "link-cli"))).toEqual({ ok: false, reason: "volta_shim" });
  });
});

describe("detecting the CLI", () => {
  it("finds link-cli on PATH and reports an unsafe one as refused", () => {
    const good = tmp("psyche-link-good-");
    const real = fakeCli();
    symlinkSync(real, join(good, "link-cli"));
    const bad = tmp("psyche-link-bad-");
    writeFileSync(join(bad, "link-cli"), "#!/bin/sh\n");
    chmodSync(join(bad, "link-cli"), 0o777);
    const r = detectLinkClis({ env: { PATH: `${good}:${bad}` }, home: tmp("psyche-home-") });
    expect(r.found).toEqual([statRealpath(real)]);
    expect(r.rejected).toEqual([{ path: join(bad, "link-cli"), reason: "writable" }]);
  });
});

describe("Link's sign-in page", () => {
  it.each([
    "https://login.link.com/device?c=1",
    "https://link.com/x",
    "https://app.link.com/approve",
  ])("accepts %s", (u) => expect(isLinkUrl(u)).toBe(true));
  it.each([
    "http://login.link.com/",
    "https://link.com.evil.example/",
    "https://evil.example/link.com",
    "https://notlink.com/",
    "https://user@login.link.com@evil.example/",
    "javascript:alert(1)",
    "not a url",
  ])("refuses %s", (u) => expect(isLinkUrl(u)).toBe(false));

  it("reads the page and phrase from the CLI's JSON, and nothing off Link's hosts", () => {
    expect(parseLogin('{"verification_url":"https://login.link.com/d","phrase":"a-b-c"}')).toEqual({
      url: "https://login.link.com/d",
      phrase: "a-b-c",
    });
    expect(
      parseLogin('{"verification_url":"https://evil.example/d","phrase":"a-b-c"}'),
    ).toBeUndefined();
    expect(parseLogin("not json")).toBeUndefined();
  });

  it("reads the array incur prints, and the {ok, data} wrapper", () => {
    const body = { verification_url: "https://login.link.com/d", phrase: "a-b-c" };
    const want = { url: "https://login.link.com/d", phrase: "a-b-c" };
    expect(parseLogin(JSON.stringify([body]))).toEqual(want);
    expect(parseLogin(JSON.stringify({ ok: true, data: body }))).toEqual(want);
  });

  it("shows only a `phrase` (else a `user_code`), never a device code", () => {
    const url = { verification_url: "https://login.link.com/d" };
    expect(
      parseLogin(JSON.stringify({ ...url, device_code: DEVICE_CODE, user_code: "WXYZ-1234" })),
    ).toEqual({ url: "https://login.link.com/d", phrase: "WXYZ-1234" });
    expect(
      parseLogin(
        JSON.stringify({ ...url, user_code: "WXYZ-1234", device_code: DEVICE_CODE, phrase: "a-b" }),
      ),
    ).toEqual({ url: "https://login.link.com/d", phrase: "a-b" });
    // Keys that merely contain "code" are not phrases.
    for (const key of ["device_code", "verification_code", "code", "deviceCode"]) {
      expect(parseLogin(JSON.stringify({ ...url, [key]: DEVICE_CODE }))).toEqual({
        url: "https://login.link.com/d",
        phrase: "",
      });
    }
  });
});

describe("the JSON the CLI prints", () => {
  it("unwraps incur's one-element array and the {ok, data} wrapper", () => {
    const body = { authenticated: true, email: "a@b.c" };
    expect(unwrapJson([body])).toEqual(body);
    expect(unwrapJson({ ok: true, data: body })).toEqual(body);
    expect(unwrapJson({ ok: true, data: [body] })).toEqual(body);
    expect(unwrapJson(body)).toEqual(body);
    expect(unwrapJson([])).toBeUndefined();
  });
});

describe("open spends", () => {
  const now = Date.parse("2026-11-18T12:00:00Z");
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  const spend = (status: string, state: string, msAgo: number) => ({
    status,
    payment: { state },
    createdAt: iso(msAgo),
  });
  it.each([
    ["waiting for approval", spend("pending_approval", "none", 60_000), 1],
    ["approved, card out, nothing settled", spend("approved", "none", 60_000), 1],
    ["a hold", spend("succeeded", "held", 60_000), 1],
    ["finished", spend("succeeded", "captured", 60_000), 0],
    ["failed", spend("failed", "none", 60_000), 0],
    ["a stale waiting record", spend("pending_approval", "none", 3 * 3_600_000), 0],
  ])("%s", (_n, p, open) => {
    const broker = { list: () => [p] } as never;
    expect(countOpenSpends(broker, now)).toBe(open);
  });
});

describe("guided setup in the composed Gateway", () => {
  interface BootOptions {
    pollMs?: number;
    statusTtlMs?: number;
    presence?: PresenceVerifier;
    run?: RunLink;
    /** Spend records on disk before the Gateway starts: [id, status, age in ms]. */
    spends?: [string, string, number][];
  }

  async function boot(cli: string, extra: BootOptions = {}) {
    const home = tmp("psyche-gw-link-");
    const keyFile = join(home, "vault.key");
    writeFileSync(keyFile, Buffer.alloc(32, 7), { mode: 0o600 });
    const bin = tmp("psyche-link-path-");
    symlinkSync(cli, join(bin, "link-cli"));
    if (extra.spends) {
      const dir = join(home, "vault", "payments");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      for (const [id, status, age] of extra.spends)
        writeFileSync(
          join(dir, `${id}.json`),
          JSON.stringify({
            spendRequestId: id,
            approvalId: "ap_1",
            taskId: null,
            merchantName: "Shop",
            merchantHost: "shop.example",
            amount: 1000,
            currency: "usd",
            status,
            approvalUrl: null,
            card: null,
            fundingSource: null,
            payment: { state: "none", held: 0, captured: 0, refunded: 0, refs: {} },
            createdAt: Date.now() - age,
            revealedAt: null,
          }),
        );
    }
    const composed: ComposedGateway = await composeGateway({
      env: {},
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
      vault: { keyFile, argon2: { memory: 64, passes: 1, parallelism: 1 } },
      ...(extra.presence === undefined ? {} : { presence: extra.presence }),
      payments: {
        link: {
          detect: { env: { PATH: bin }, home: tmp("psyche-h-") },
          pollMs: extra.pollMs ?? 20,
          ...(extra.statusTtlMs === undefined ? {} : { statusTtlMs: extra.statusTtlMs }),
          ...(extra.run === undefined ? {} : { run: extra.run }),
        },
      },
    });
    cleanups.push(() => composed.stop("test"));
    return { home, composed };
  }

  async function bootAdmin(cli: string, extra: BootOptions = {}) {
    const b = await boot(cli, extra);
    const admin = await adminClient(b.composed.gateway);
    cleanups.push(() => admin.close());
    return { ...b, admin };
  }

  async function pairDevice(composed: ComposedGateway, id: string, scopes: Scope[]) {
    const key = newDeviceKey();
    (await desktopClient(composed.gateway, key, id)).close();
    updateDevice(composed.gateway.context.db, id, { scopes });
    const c = await desktopClient(composed.gateway, key, id);
    cleanups.push(() => c.close());
    return c;
  }

  it("walks not-set-up → found → connected → signed in → disconnected, with the token only in the 0600 vault file", async () => {
    const cli = fakeCli();
    const { home, admin } = await bootAdmin(cli);
    const status = () => admin.call<LinkSetupStatus>("payments.link.status", {});
    const authFile = join(home, "vault", "link-auth.json");

    // Nothing is set up, and Link's payment data says so.
    const first = await status();
    expect(first.state).toBe("cli_found");
    expect(first.candidates).toEqual([{ path: statRealpath(cli) }]);
    const early = await admin.request("vault.payments.methods", {});
    expect(early.error).toMatchObject({ details: { reason: "payments_not_configured" } });

    // A raw setting write cannot point payments at another program.
    const raw = await admin.request("settings.set", {
      key: "_payments.linkCli",
      value: { path: "/bin/sh" },
    });
    expect(raw.ok).toBe(false);

    // Connect refuses an unsafe path, then saves a safe one, with no restart.
    chmodSync(cli, 0o666);
    const unsafe = await admin.request("payments.link.connect", { path: cli }, "k-connect-unsafe");
    expect(unsafe.error).toMatchObject({ code: "invalid_params", details: { reason: "writable" } });
    chmodSync(cli, 0o644);
    const connected = await admin.call<LinkSetupStatus>(
      "payments.link.connect",
      { path: cli },
      "k-connect",
    );
    expect(connected.state).toBe("signed_out");
    expect(connected.cli).toEqual({ path: statRealpath(cli), source: "saved" });

    // Sign-in returns Link's own page; the owner approves there; the Gateway notices. The fake
    // prints the array real link-cli prints, and the sign-in start asks for payments scopes only.
    const signing = await admin.call<LinkSetupStatus>("payments.link.signIn", {}, "k-signin");
    expect(signing.state).toBe("signing_in");
    expect(signing.signIn).toMatchObject({
      verificationUrl: "https://login.link.com/device?c=1",
      phrase: "blue-otter-moon",
    });
    writeFileSync(`${authFile}.approve`, "");
    await waitFor(async () => (await status()).state === "connected");

    // The token file sits in the vault folder at 0600 (the CLI wrote 0644), and is the only copy.
    expect(statSync(authFile).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "vault")).mode & 0o077).toBe(0);
    const methods = await admin.call<{ methods: { last4: string }[] }>(
      "vault.payments.methods",
      {},
    );
    expect(methods.methods[0]?.last4).toBe("1881");
    for (const res of [first, connected, signing, await status(), methods]) {
      expect(JSON.stringify(res)).not.toContain(TOKEN);
      expect(JSON.stringify(res)).not.toContain(DEVICE_CODE);
    }
    expect(readFileSync(authFile, "utf8")).toContain(TOKEN);

    // Disconnect removes the token file and the saved path, and payments switch off at once.
    const gone = await admin.call<LinkSetupStatus>("payments.link.disconnect", {}, "k-disconnect");
    expect(gone.state).toBe("cli_found");
    expect(gone.cli).toBeUndefined();
    expect(existsSync(authFile)).toBe(false);
    const late = await admin.request("vault.payments.methods", {});
    expect(late.error).toMatchObject({ details: { reason: "payments_not_configured" } });
  });

  it("runs a `.mjs` CLI with node, which the wallet alone would start as a program", async () => {
    const cli = fakeCli("mjs");
    const { admin } = await bootAdmin(cli);
    await admin.call("payments.link.connect", { path: cli }, "k-connect-mjs");
    const methods = await admin.call<{ methods: { last4: string }[] }>(
      "vault.payments.methods",
      {},
    );
    expect(methods.methods[0]?.last4).toBe("1881");
  });

  it("refuses to connect a planted script inside Psyche's folder", async () => {
    const cli = fakeCli();
    const { home, admin } = await bootAdmin(cli);
    const planted = fakeCli("js", join(home, "workspace", "x"));
    const res = await admin.request("payments.link.connect", { path: planted }, "k-planted");
    expect(res.error).toMatchObject({
      code: "invalid_params",
      details: { reason: "in_psyche_home" },
    });
    expect((await admin.call<LinkSetupStatus>("payments.link.status", {})).cli).toBeUndefined();
  });

  it("does not run a program that changed after it was connected", async () => {
    const cli = fakeCli();
    const { admin } = await bootAdmin(cli);
    await admin.call("payments.link.connect", { path: cli }, "k-connect-2");
    chmodSync(cli, 0o666);
    const res = await admin.request("vault.payments.methods", {});
    expect(res.ok).toBe(false);
    const st = await admin.call<LinkSetupStatus>("payments.link.status", {});
    expect(st.problem).toEqual({ path: statRealpath(cli), reason: "writable" });
    expect(st.cli).toBeUndefined();
  });

  describe("how often the CLI is run", () => {
    const counting =
      (calls: string[], delayMs = 0): RunLink =>
      async (file, args, env, timeout) => {
        const verb = args.filter((a) => !a.startsWith("-") && !a.endsWith(".js")).join(" ");
        calls.push(verb);
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        return runFile(file, args, env, timeout);
      };

    it("answers status from a short cache instead of running the CLI each time", async () => {
      const calls: string[] = [];
      const cli = fakeCli();
      const { admin } = await bootAdmin(cli, { run: counting(calls), pollMs: 60_000 });
      await admin.call("payments.link.connect", { path: cli }, "k-c");
      const before = calls.filter((c) => c.startsWith("auth status")).length;
      await Promise.all(
        Array.from({ length: 6 }, () => admin.call<LinkSetupStatus>("payments.link.status", {})),
      );
      await admin.call<LinkSetupStatus>("payments.link.status", {});
      expect(calls.filter((c) => c.startsWith("auth status")).length).toBe(before);
      expect(before).toBeLessThanOrEqual(1);
    });

    it("lets concurrent callers share one run when nothing is cached", async () => {
      const calls: string[] = [];
      const cli = fakeCli();
      const { admin } = await bootAdmin(cli, {
        run: counting(calls, 150),
        statusTtlMs: 0,
        pollMs: 60_000,
      });
      await admin.call("payments.link.connect", { path: cli }, "k-c");
      calls.length = 0;
      await Promise.all(
        Array.from({ length: 5 }, () => admin.call<LinkSetupStatus>("payments.link.status", {})),
      );
      expect(calls.filter((c) => c.startsWith("auth status")).length).toBe(1);
    });

    it("never runs the CLI for status while a sign-in is waiting (the poll is the only caller)", async () => {
      const calls: string[] = [];
      const cli = fakeCli();
      const { admin } = await bootAdmin(cli, { run: counting(calls), pollMs: 60_000 });
      await admin.call("payments.link.connect", { path: cli }, "k-c");
      await admin.call("payments.link.signIn", {}, "k-s");
      calls.length = 0;
      for (let i = 0; i < 4; i++) {
        expect((await admin.call<LinkSetupStatus>("payments.link.status", {})).state).toBe(
          "signing_in",
        );
      }
      expect(calls).toEqual([]);
    });
  });

  describe("disconnecting with a payment open", () => {
    it("is refused with `conflict` while a spend is not finished, and keeps everything", async () => {
      const cli = fakeCli();
      const { admin, home } = await bootAdmin(cli, {
        spends: [["lsrq_open1", "pending_approval", 1_000]],
      });
      await admin.call("payments.link.connect", { path: cli }, "k-c");
      const res = await admin.request("payments.link.disconnect", {}, "k-d");
      expect(res.error).toMatchObject({
        code: "conflict",
        details: { reason: "payment_in_progress" },
      });
      const st = await admin.call<LinkSetupStatus>("payments.link.status", {});
      expect(st.cli).toEqual({ path: statRealpath(cli), source: "saved" });
      expect(existsSync(join(home, "vault", "payments", "lsrq_open1.json"))).toBe(true);
    });

    it("goes through when the spends are finished or stale", async () => {
      const cli = fakeCli();
      const { admin } = await bootAdmin(cli, {
        spends: [
          ["lsrq_done1", "succeeded", 1_000],
          ["lsrq_old1", "pending_approval", 5 * 3_600_000],
        ],
      });
      await admin.call("payments.link.connect", { path: cli }, "k-c");
      const gone = await admin.call<LinkSetupStatus>("payments.link.disconnect", {}, "k-d");
      expect(gone.cli).toBeUndefined();
    });
  });

  describe("the audit log", () => {
    it("names the device that connected, started the sign-in and disconnected, and notes a skipped logout", async () => {
      const cli = fakeCli();
      const { composed } = await boot(cli);
      const device = await pairDevice(composed, "admin-audit", [
        "operator.read",
        "operator.write",
        "operator.approvals",
        "operator.admin",
      ]);
      await device.call("payments.link.connect", { path: cli }, "k-c");
      await device.call("payments.link.signIn", {}, "k-s");
      // The program changes, so the CLI can't be asked to sign out.
      chmodSync(cli, 0o666);
      await device.call("payments.link.disconnect", {}, "k-d");
      const actor = { type: "device", deviceId: "admin-audit" };
      for (const kind of [
        "payments.link_cli_connected",
        "payments.link_signin_started",
        "payments.link_disconnected",
        "payments.link_logout_skipped",
      ]) {
        await waitFor(async () => (await composed.audit.query({ kind })).length > 0);
        expect((await composed.audit.query({ kind }))[0]?.actor, kind).toMatchObject(actor);
      }
      const skipped = (await composed.audit.query({ kind: "payments.link_logout_skipped" }))[0];
      expect(skipped?.data).toMatchObject({ reason: "cli_unavailable" });
    });
  });

  describe("who may connect", () => {
    const touchId: PresenceVerifier = {
      verify: async (assertion, challenge) => assertion.signature === `signed:${challenge}`,
    };
    const ADMIN: Scope[] = [
      "operator.read",
      "operator.write",
      "operator.approvals",
      "operator.admin",
    ];

    async function tap(c: TestClient, approvalId: string): Promise<void> {
      const got = await c.call<{ answerToken?: string }>("approvals.get", { approvalId });
      await new Promise((r) => setTimeout(r, 450)); // past the arm delay
      expect(
        await c.request(
          "approvals.answer",
          { approvalId, answerToken: got.answerToken ?? "", decision: "approve" },
          ik(),
        ),
      ).toMatchObject({ ok: true });
    }

    it("asks for a card bound to the path and the device, and spends it once", async () => {
      const cli = fakeCli();
      const { composed } = await boot(cli, { presence: touchId });
      const a = await pairDevice(composed, "admin-a", ADMIN);
      const b = await pairDevice(composed, "admin-b", ADMIN);

      const first = await a.request("payments.link.connect", { path: cli }, ik());
      expect(first).toMatchObject({ ok: false, error: { code: "approval_required" } });
      const approvalId = (first as { error: { details: { approvalId: string } } }).error.details
        .approvalId;
      const card = await a.call<{ approval: { kind: string; details: Record<string, unknown> } }>(
        "approvals.get",
        { approvalId },
      );
      expect(card.approval).toMatchObject({
        kind: "policy_change",
        details: { method: "payments.link.connect", path: statRealpath(cli) },
      });
      await tap(a, approvalId);

      // Another device cannot present the card that was approved for this one.
      expect(
        await b.request("payments.link.connect", { path: cli, approvalId }, ik()),
      ).toMatchObject({ ok: false, error: { code: "binding_mismatch" } });
      expect((await a.call<LinkSetupStatus>("payments.link.status", {})).cli).toBeUndefined();

      // The device that asked can, once.
      const ok = await a.call<LinkSetupStatus>(
        "payments.link.connect",
        { path: cli, approvalId },
        ik(),
      );
      expect(ok.cli?.source).toBe("saved");
    });

    it("refuses a device without the admin scope", async () => {
      const cli = fakeCli();
      const { composed } = await boot(cli, { presence: touchId });
      const reader = await pairDevice(composed, "reader-1", ["operator.read", "operator.write"]);
      for (const [method, params] of [
        ["payments.link.connect", { path: cli }],
        ["payments.link.signIn", {}],
        ["payments.link.disconnect", {}],
      ] as const) {
        const res = await reader.request(method, params, ik());
        expect(res, method).toMatchObject({ ok: false });
        expect((res.error as { code?: string } | undefined)?.code, method).toBe("forbidden");
      }
      // Reading the state is allowed, and shows nothing was connected.
      expect((await reader.call<LinkSetupStatus>("payments.link.status", {})).cli).toBeUndefined();
    });
  });
});

async function waitFor(fn: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("timed out");
}
