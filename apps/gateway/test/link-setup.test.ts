import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LinkSetupStatus } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import {
  checkLinkCliPath,
  detectLinkClis,
  isLinkUrl,
  parseLogin,
} from "../src/compose/link-setup.ts";
import { adminClient } from "./helpers.ts";

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

const TOKEN = "SECRET-TOKEN-do-not-leak-123";

/** A stand-in for link-cli: state lives in LINK_AUTH_FILE; `<file>.approve` plays the owner signing in on Link's page. */
const FAKE_CLI = `
const fs = require("node:fs");
const file = process.env.LINK_AUTH_FILE;
const a = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o));
if (a[0] === "auth" && a[1] === "login") out({ verification_url: "https://login.link.com/device?c=1", phrase: "blue-otter-moon" });
else if (a[0] === "auth" && a[1] === "status") {
  if (fs.existsSync(file + ".approve") && !fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ access_token: "${TOKEN}" }), { mode: 0o644 });
  out({ authenticated: fs.existsSync(file) });
} else if (a[0] === "auth" && a[1] === "logout") { try { fs.unlinkSync(file); } catch {} out({ ok: true }); }
else if (a[0] === "payment-methods") out([{ id: "csmrpd_1", type: "card", card: { brand: "visa", last4: "1881" }, is_default: true }]);
else { process.stderr.write("${TOKEN}"); process.exit(2); }
`;

function fakeCli(): string {
  const dir = tmp("psyche-link-cli-");
  const file = join(dir, "link-cli.js");
  writeFileSync(file, FAKE_CLI, { mode: 0o644 });
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
});

function statRealpath(p: string): string {
  return require("node:fs").realpathSync(p);
}

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
});

describe("guided setup in the composed Gateway", () => {
  async function boot(cli: string, extra: { pollMs?: number } = {}) {
    const home = tmp("psyche-gw-link-");
    const keyFile = join(home, "vault.key");
    writeFileSync(keyFile, Buffer.alloc(32, 7), { mode: 0o600 });
    const bin = tmp("psyche-link-path-");
    symlinkSync(cli, join(bin, "link-cli"));
    const composed: ComposedGateway = await composeGateway({
      env: {},
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
      vault: { keyFile, argon2: { memory: 64, passes: 1, parallelism: 1 } },
      payments: {
        link: {
          detect: { env: { PATH: bin }, home: tmp("psyche-h-") },
          pollMs: extra.pollMs ?? 20,
        },
      },
    });
    cleanups.push(() => composed.stop("test"));
    const admin = await adminClient(composed.gateway);
    cleanups.push(() => admin.close());
    return { home, admin };
  }

  it("walks not-set-up → found → connected → signed in → disconnected, with the token only in the 0600 vault file", async () => {
    const cli = fakeCli();
    const { home, admin } = await boot(cli);
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
    const connected = await admin.call<LinkSetupStatus>("payments.link.connect", { path: cli }, "k-connect");
    expect(connected.state).toBe("signed_out");
    expect(connected.cli).toEqual({ path: statRealpath(cli), source: "saved" });

    // Sign-in returns Link's own page; the owner approves there; the Gateway notices.
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

  it("does not run a program that changed after it was connected", async () => {
    const cli = fakeCli();
    const { admin } = await boot(cli);
    await admin.call("payments.link.connect", { path: cli }, "k-connect-2");
    chmodSync(cli, 0o666);
    const res = await admin.request("vault.payments.methods", {});
    expect(res.ok).toBe(false);
    const st = await admin.call<LinkSetupStatus>("payments.link.status", {});
    expect(st.problem).toEqual({ path: statRealpath(cli), reason: "writable" });
    expect(st.cli).toBeUndefined();
  });
});

async function waitFor(fn: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("timed out");
}
