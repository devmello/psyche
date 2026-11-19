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
import { readGuardOf, setReadGuard, updateDevice } from "@psyche/db";
import type { PresenceVerifier } from "@psyche/permissions";
import type { LinkSetupStatus } from "@psyche/protocol";

type Scope = "operator.read" | "operator.write" | "operator.approvals" | "operator.admin";

import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { composeBrowser } from "../src/compose/browser.ts";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import {
  checkLinkCliPath,
  detectLinkClis,
  isLinkUrl,
  openSpendsOf,
  parseLogin,
  type RunLink,
  runFile,
  unwrapJson,
} from "../src/compose/link-setup.ts";
import type { ComposeServices } from "../src/compose/services.ts";
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
  out(fs.existsSync(file + ".nophrase")
    ? { verification_url: "https://login.link.com/device?c=1", device_code: "${DEVICE_CODE}" }
    : { verification_url: "https://login.link.com/device?c=1", phrase: "blue-otter-moon", device_code: "${DEVICE_CODE}" });
} else if (a[0] === "auth" && a[1] === "status") {
  if (fs.existsSync(file + ".exit1")) { out({ authenticated: false, error: "token expired" }); process.exit(1); }
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

  it("finds Psyche's folder under another spelling: by identity, not by string", () => {
    // A firmlink or case-insensitive spelling is another path to the same folder, one a string
    // comparison does not recognise: model it by making the package's folder report the identity
    // of `$PSYCHE_HOME`, while the path itself shares no prefix with it.
    const home = tmp("psyche-home-");
    const script = fakeCli();
    const packageRoot = statRealpath(join(script, "..", ".."));
    const homeId = statSync(home, { bigint: true });
    const statDir = (p: string) =>
      p === packageRoot ? { dev: homeId.dev, ino: homeId.ino } : statSync(p, { bigint: true });
    expect(checkLinkCliPath(script, { psycheHome: home })).toMatchObject({ ok: true });
    expect(checkLinkCliPath(script, { psycheHome: home, statDir })).toEqual({
      ok: false,
      reason: "in_psyche_home",
    });
  });

  it("refuses an upper-cased spelling of Psyche's folder where the disk ignores case", () => {
    const home = tmp("psyche-home-");
    const planted = fakeCli("js", join(home, "workspace", "x"));
    const shouty = statRealpath(planted).toUpperCase();
    // Only a case-insensitive filesystem (APFS by default) resolves the other spelling.
    if (!existsSync(shouty)) return;
    expect(checkLinkCliPath(shouty, { psycheHome: home })).toEqual({
      ok: false,
      reason: "in_psyche_home",
    });
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
    // A native program is not the Link CLI, whatever its execute bit says: `sh auth status` or
    // `env auth status` would run another program named `auth`.
    const bin = join(tmp("psyche-exe-"), "link-cli");
    writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
    expect(checkLinkCliPath(bin)).toEqual({ ok: false, reason: "not_link_cli" });
  });

  it.each(["/bin/sh", "/usr/bin/env"])("refuses %s as the Link CLI", (path) => {
    if (!existsSync(path)) return;
    expect(checkLinkCliPath(path)).toEqual({ ok: false, reason: "not_link_cli" });
  });

  describe("a pnpm or npm shim", () => {
    const shim = (target: string) =>
      `#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e 's,\\,/,g')")\nif [ -x "$basedir/node" ]; then\n  exec "$basedir/node"  "$basedir/${target}" "$@"\nelse\n  exec node  "$basedir/${target}" "$@"\nfi\n`;

    it("passes when its target is a script of the package, and returns the script", () => {
      const pnpm = tmp("psyche-pnpm-");
      const script = fakeCli(
        "js",
        join(pnpm, "global", "5", "node_modules", "@stripe", "link-cli"),
      );
      writeFileSync(
        join(pnpm, "link-cli"),
        shim("global/5/node_modules/@stripe/link-cli/dist/cli.js"),
        { mode: 0o755 },
      );
      expect(checkLinkCliPath(join(pnpm, "link-cli"))).toEqual({
        ok: true,
        real: statRealpath(script),
      });
    });

    it("is refused when its target is not such a script", () => {
      const pnpm = tmp("psyche-pnpm-");
      writeFileSync(join(pnpm, "other.js"), "1", { mode: 0o644 });
      for (const target of ["other.js", "../../../bin/sh", "missing.js"]) {
        writeFileSync(join(pnpm, "link-cli"), shim(target), { mode: 0o755 });
        const r = checkLinkCliPath(join(pnpm, "link-cli"));
        expect(r.ok, target).toBe(false);
      }
      // An ordinary shell script is not a shim.
      writeFileSync(join(pnpm, "link-cli"), '#!/bin/sh\nexec /bin/sh "$@"\n', { mode: 0o755 });
      expect(checkLinkCliPath(join(pnpm, "link-cli"))).toEqual({
        ok: false,
        reason: "not_link_cli",
      });
    });
  });

  it("refuses Volta's shim, which runs whichever tool its own name says", () => {
    const dir = tmp("psyche-volta-");
    writeFileSync(join(dir, "volta-shim"), "#!/bin/sh\n", { mode: 0o755 });
    symlinkSync(join(dir, "volta-shim"), join(dir, "link-cli"));
    expect(checkLinkCliPath(join(dir, "link-cli"))).toEqual({ ok: false, reason: "volta_shim" });
  });
});

describe("checkLinkCliPath on Windows", () => {
  const win = { platform: "win32" as const };

  it("accepts the Link CLI's own script and nothing that is not a script or a shim of one", () => {
    const script = fakeCli("js");
    expect(checkLinkCliPath(script, win)).toEqual({ ok: true, real: statRealpath(script) });
    const cjs = fakeCli("cjs");
    expect(checkLinkCliPath(cjs, win)).toMatchObject({ ok: true });
    // A script of some other package is not the Link CLI.
    const lone = join(tmp("psyche-win-lone-"), "x.js");
    writeFileSync(lone, "1");
    expect(checkLinkCliPath(lone, win)).toEqual({ ok: false, reason: "not_link_cli" });
  });

  it.each(["powershell.exe", "cmd.exe", "node.exe", "link-cli.exe"])(
    "refuses %s as the Link CLI",
    (name) => {
      const fake = join(tmp("psyche-win-exe-"), name);
      writeFileSync(fake, "MZ", { mode: 0o755 });
      expect(checkLinkCliPath(fake, win)).toEqual({ ok: false, reason: "not_link_cli" });
    },
  );

  it("refuses a `.cmd` shim outside Psyche's folder whose script is inside it", () => {
    const home = tmp("psyche-home-");
    // The agent can write under workspace/: a planted copy of the package, started by a tidy shim.
    const planted = fakeCli("js", join(home, "workspace", "x"));
    const npm = tmp("psyche-win-npm-");
    const cmd = (target: string) => `@ECHO off\r\nnode  "${target}" %*\r\n`;
    writeFileSync(join(npm, "link-cli.cmd"), cmd(planted));
    expect(checkLinkCliPath(join(npm, "link-cli.cmd"), { ...win, psycheHome: home })).toEqual({
      ok: false,
      reason: "in_psyche_home",
    });
    // The same shim pointing at the package outside the folder passes, and returns the script.
    const outside = fakeCli();
    writeFileSync(join(npm, "link-cli.cmd"), cmd(outside));
    expect(checkLinkCliPath(join(npm, "link-cli.cmd"), { ...win, psycheHome: home })).toEqual({
      ok: true,
      real: statRealpath(outside),
    });
  });

  it("refuses a `.cmd` file that is not an npm or pnpm shim of a Link CLI script", () => {
    const dir = tmp("psyche-win-cmd-");
    for (const body of ["@echo off\r\npowershell -Command %*\r\n", "", "calc.exe %*"]) {
      writeFileSync(join(dir, "link-cli.cmd"), body);
      expect(checkLinkCliPath(join(dir, "link-cli.cmd"), win)).toEqual({
        ok: false,
        reason: "not_link_cli",
      });
    }
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
    // Keys that merely contain "code" are not phrases, and without a phrase there is nothing to
    // compare on Link's page: the sign-in is not started.
    for (const key of ["device_code", "verification_code", "code", "deviceCode"]) {
      expect(parseLogin(JSON.stringify({ ...url, [key]: DEVICE_CODE }))).toBeUndefined();
    }
    expect(parseLogin(JSON.stringify({ ...url, phrase: "" }))).toBeUndefined();
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
  const spend = (status: string, state: string, msAgo: number) => ({
    spendRequestId: "lsrq_x",
    merchantName: "Shop",
    merchantHost: "shop.example",
    status,
    payment: { state },
    createdAt: now - msAgo,
  });
  it.each([
    ["waiting for approval", spend("pending_approval", "none", 60_000), 1],
    ["approved, card out, nothing settled", spend("approved", "none", 60_000), 1],
    ["a hold", spend("succeeded", "held", 60_000), 1],
    ["a hold that was cancelled", spend("canceled", "held", 60_000), 0],
    ["a hold older than a week", spend("succeeded", "held", 8 * 86_400_000), 0],
    ["finished", spend("succeeded", "captured", 60_000), 0],
    ["failed", spend("failed", "none", 60_000), 0],
    ["a stale waiting record", spend("pending_approval", "none", 3 * 3_600_000), 0],
  ])("%s", (_n, p, open) => {
    expect(openSpendsOf([p], now)).toHaveLength(open);
  });

  it("ignores what a forced disconnect gave up", () => {
    expect(openSpendsOf([spend("pending_approval", "none", 60_000)], now, now)).toHaveLength(0);
    expect(
      openSpendsOf([spend("pending_approval", "none", 60_000)], now, now - 120_000),
    ).toHaveLength(1);
  });
});

describe("guided setup in the composed Gateway", () => {
  interface BootOptions {
    pollMs?: number;
    statusTtlMs?: number;
    presence?: PresenceVerifier;
    run?: RunLink;
    /** Receives the compose services (the tool registry, among others). */
    onServices?: (services: ComposeServices) => void;
    /** Spend records on disk before the Gateway starts: [id, status, age in ms]. */
    spends?: [string, string, number, string?][];
    /** Start on an existing `$PSYCHE_HOME` (a restart). */
    home?: string;
    statusRetryMs?: number;
  }

  async function boot(cli: string, extra: BootOptions = {}) {
    const home = extra.home ?? tmp("psyche-gw-link-");
    const keyFile = join(home, "vault.key");
    writeFileSync(keyFile, Buffer.alloc(32, 7), { mode: 0o600 });
    const bin = tmp("psyche-link-path-");
    symlinkSync(cli, join(bin, "link-cli"));
    if (extra.spends) {
      const dir = join(home, "vault", "payments");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      for (const [id, status, age, state] of extra.spends)
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
            payment: { state: state ?? "none", held: 0, captured: 0, refunded: 0, refs: {} },
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
      ...(extra.onServices === undefined
        ? {}
        : {
            parts: [
              (s: ComposeServices) => {
                extra.onServices?.(s);
                return {};
              },
              // The purchase tool also needs a browser to pay in.
              (s: ComposeServices) => composeBrowser(s, { socketPath: false }),
            ],
          }),
      payments: {
        link: {
          detect: { env: { PATH: bin }, home: tmp("psyche-h-") },
          pollMs: extra.pollMs ?? 20,
          ...(extra.statusTtlMs === undefined ? {} : { statusTtlMs: extra.statusTtlMs }),
          ...(extra.statusRetryMs === undefined ? {} : { statusRetryMs: extra.statusRetryMs }),
          ...(extra.run === undefined ? {} : { run: extra.run }),
        },
      },
    });
    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      await composed.stop("test");
    };
    cleanups.push(stop);
    return { home, composed, stop };
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

  it("does not start a sign-in without a phrase to compare", async () => {
    const cli = fakeCli();
    const { home, admin } = await bootAdmin(cli);
    await admin.call("payments.link.connect", { path: cli }, "k-c");
    writeFileSync(join(home, "vault", "link-auth.json.nophrase"), "");
    const res = await admin.request("payments.link.signIn", {}, "k-s");
    expect(res.error).toMatchObject({
      code: "unavailable",
      details: { reason: "link_signin_unreadable" },
    });
    expect((await admin.call<LinkSetupStatus>("payments.link.status", {})).state).toBe(
      "signed_out",
    );
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

  it("offers the purchase tool only while Link is connected and signed in", async () => {
    const cli = fakeCli();
    let services: ComposeServices | undefined;
    const { home, admin, composed } = await bootAdmin(cli, { onServices: (s) => (services = s) });
    const tool = () => services?.tools.get("checkout.pay_with_link");
    const authFile = join(home, "vault", "link-auth.json");
    // Nothing is set up: the tool is not there, so no Pay card can be raised for it.
    expect(tool()).toBeUndefined();
    // A saved CLI path alone is not enough: before sign-in Link cannot pay (#1323 N7).
    await admin.call("payments.link.connect", { path: cli }, "k-c");
    expect(tool()).toBeUndefined();
    await admin.call("payments.link.signIn", {}, "k-s");
    writeFileSync(`${authFile}.approve`, "");
    await waitFor(async () => tool() !== undefined);
    expect(tool()?.spec.sideEffect).toBe("financial");
    rmSync(`${authFile}.approve`);
    // A reference held from before the disconnect (the loop's tool list for this step) raises no
    // Pay card and pays nothing (#1323 N6).
    const held = tool();
    // A Stripe Link Pay card still open at disconnect is withdrawn; a vault-card checkout card
    // at a shop has nothing to do with Link and stays (#1332 N4).
    const card = (hash: string, details: Record<string, unknown>) =>
      composed.gateway.context.broker.requestApproval({
        kind: "purchase",
        summary: "Pay $5 to shop.example",
        details,
        bindingHash: hash.repeat(64),
        grantKey: "purchase|https://shop.example",
        requestedBy: { runId: null, taskId: null, threadId: null },
        sideEffect: "financial",
        surfaces: ["desktop"],
        scopesOffered: ["once"],
        taint: false,
      });
    const issued = await card("c", { paymentSource: "Stripe Link (one-time card)" });
    // The fallback card for a tab with no origin names the tool but no payment source (#1332 N2).
    const generic = await card("e", { tool: "checkout.pay_with_link" });
    const other = await card("d", { paymentSource: "Saved card", tool: "browser.click" });
    await admin.call("payments.link.disconnect", {}, "k-d");
    expect(tool()).toBeUndefined();
    await waitFor(
      async () =>
        (await composed.gateway.context.broker.get(issued.approval.id))?.status === "invalidated",
    );
    await waitFor(
      async () =>
        (await composed.gateway.context.broker.get(generic.approval.id))?.status === "invalidated",
    );
    expect((await composed.gateway.context.broker.get(other.approval.id))?.status).toBe("pending");
    expect(() => held?.describeCall?.({ tabId: "t1" })).toThrow(/not connected and signed in/);
    await expect(
      held?.execute(
        "call-1",
        { tabId: "t1" },
        new AbortController().signal,
        () => {},
      ) as Promise<unknown>,
    ).rejects.toMatchObject({ code: "unavailable", details: { reason: "payments_not_ready" } });
    // And it comes back once connected and signed in again (the token file is gone: sign in anew).
    await admin.call("payments.link.connect", { path: cli }, "k-c2");
    expect(tool()).toBeUndefined();
    await admin.call("payments.link.signIn", {}, "k-s2");
    writeFileSync(`${authFile}.approve`, "");
    await waitFor(async () => tool() !== undefined);
  });

  it("offers the purchase tool at start when the saved CLI is already signed in", async () => {
    const cli = fakeCli();
    let services: ComposeServices | undefined;
    const first = await bootAdmin(cli);
    await first.admin.call("payments.link.connect", { path: cli }, "k-c");
    await first.admin.call("payments.link.signIn", {}, "k-s");
    writeFileSync(join(first.home, "vault", "link-auth.json.approve"), "");
    await waitFor(
      async () =>
        (await first.admin.call<LinkSetupStatus>("payments.link.status", {})).state === "connected",
    );
    // A restart: the next Gateway finds the saved CLI and Link's token file on disk.
    first.admin.close();
    await first.stop();
    await bootAdmin(cli, { home: first.home, onServices: (s) => (services = s) });
    await waitFor(async () => services?.tools.get("checkout.pay_with_link") !== undefined);
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

  /** A Link CLI whose `auth status` gives no answer (a timeout) while `failing()` says so. */
  const flaky =
    (failing: () => boolean, calls: string[] = []): RunLink =>
    async (file, args, env, timeout) => {
      const verb = args.filter((a) => !a.startsWith("-") && !a.endsWith(".js")).join(" ");
      calls.push(verb);
      if (verb.startsWith("auth status") && failing()) throw new Error("timed out");
      return runFile(file, args, env, timeout);
    };

  it("keeps the last answer when `auth status` gives none (#1332 N4)", async () => {
    const cli = fakeCli();
    let services: ComposeServices | undefined;
    let fail = false;
    let failed = 0;
    const { home, admin } = await bootAdmin(cli, {
      onServices: (s) => (services = s),
      run: flaky(() => fail && ++failed > 0),
      statusTtlMs: 0,
    });
    const tool = () => services?.tools.get("checkout.pay_with_link");
    const status = () => admin.call<LinkSetupStatus>("payments.link.status", {});
    await admin.call("payments.link.connect", { path: cli }, "k-c");
    await admin.call("payments.link.signIn", {}, "k-s");
    writeFileSync(join(home, "vault", "link-auth.json.approve"), "");
    await waitFor(async () => tool() !== undefined && (await status()).state === "connected");
    // The CLI times out: the tool stays, and Settings still says connected.
    fail = true;
    expect((await status()).state).toBe("connected");
    expect(failed).toBeGreaterThan(0);
    expect(tool()).toBeDefined();
  });

  it("treats a CLI that exits non-zero as signed out, not unknown (#1332 N3)", async () => {
    const cli = fakeCli();
    let services: ComposeServices | undefined;
    const { home, admin } = await bootAdmin(cli, {
      onServices: (s) => (services = s),
      statusTtlMs: 0,
    });
    const tool = () => services?.tools.get("checkout.pay_with_link");
    const status = () => admin.call<LinkSetupStatus>("payments.link.status", {});
    await admin.call("payments.link.connect", { path: cli }, "k-c");
    await admin.call("payments.link.signIn", {}, "k-s");
    writeFileSync(join(home, "vault", "link-auth.json.approve"), "");
    // Positive control: exit 0 with signed-in output stays ready.
    await waitFor(async () => tool() !== undefined && (await status()).state === "connected");
    expect((await status()).state).toBe("connected");
    expect(tool()).toBeDefined();
    // The CLI now exits non-zero (expired token): not connected, tool hidden.
    writeFileSync(join(home, "vault", "link-auth.json.exit1"), "");
    expect((await status()).state).toBe("signed_out");
    expect(tool()).toBeUndefined();
    // And it recovers when the CLI answers again.
    rmSync(join(home, "vault", "link-auth.json.exit1"));
    await waitFor(async () => (await status()).state === "connected");
    expect(tool()).toBeDefined();
  });

  it("retries `auth status` with back-off after a later connect fails transiently (#1332 N4)", async () => {
    const cli = fakeCli();
    let services: ComposeServices | undefined;
    const calls: string[] = [];
    let failures = 0;
    const { home, admin } = await bootAdmin(cli, {
      onServices: (s) => (services = s),
      run: flaky(() => failures-- > 0, calls),
      statusRetryMs: 20,
      statusTtlMs: 0,
    });
    // Signed in at Link already, with the saved path not yet connected here.
    writeFileSync(join(home, "vault", "link-auth.json"), JSON.stringify({ access_token: "x" }), {
      mode: 0o600,
    });
    failures = 2;
    await admin.call("payments.link.connect", { path: cli }, "k-c");
    await waitFor(async () => services?.tools.get("checkout.pay_with_link") !== undefined);
    expect(calls.filter((c) => c.startsWith("auth status")).length).toBeGreaterThanOrEqual(3);
  });

  /** A first sign-in, then a restart on the same home: the saved CLI is signed in. */
  async function signedInHome(cli: string): Promise<string> {
    const first = await bootAdmin(cli);
    await first.admin.call("payments.link.connect", { path: cli }, "k-c");
    await first.admin.call("payments.link.signIn", {}, "k-s");
    writeFileSync(join(first.home, "vault", "link-auth.json.approve"), "");
    await waitFor(
      async () =>
        (await first.admin.call<LinkSetupStatus>("payments.link.status", {})).state === "connected",
    );
    first.admin.close();
    await first.stop();
    return first.home;
  }

  /** `auth status` waits `delayMs` and then fails, as a slow offline CLI does. */
  const slowFailing =
    (calls: string[], delayMs: number): RunLink =>
    async (file, args, env, timeout) => {
      const verb = args.filter((a) => !a.startsWith("-") && !a.endsWith(".js")).join(" ");
      calls.push(verb);
      if (verb.startsWith("auth status")) {
        await new Promise((r) => setTimeout(r, delayMs));
        throw new Error("timed out");
      }
      return runFile(file, args, env, timeout);
    };

  it("ends the retry chain at stop(): no timer, no database read after (#1342 N1)", async () => {
    const cli = fakeCli();
    const home = await signedInHome(cli);
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => rejections.push(e);
    process.on("unhandledRejection", onRejection);
    try {
      const calls: string[] = [];
      const b = await boot(cli, { home, run: slowFailing(calls, 150), statusRetryMs: 10 });
      await waitFor(async () => calls.some((c) => c.startsWith("auth status")));
      // stop() while the first check is still running.
      await b.stop();
      const seen = calls.length;
      await new Promise((r) => setTimeout(r, 400));
      expect(calls.length).toBe(seen);
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  }, 20_000);

  it("keeps one retry chain when connect is called twice, and stop() ends it (#1342 N1)", async () => {
    const cli = fakeCli();
    const calls: string[] = [];
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => rejections.push(e);
    process.on("unhandledRejection", onRejection);
    // The retry timers: created, and not yet fired or cleared.
    const pending = new Set<unknown>();
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    const setSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: (...a: unknown[]) => void,
      ms?: number,
      ...rest: unknown[]
    ) => {
      if (!String(fn).includes("attempt()")) return realSet(fn, ms, ...rest);
      const h: unknown = realSet(
        (...a: unknown[]) => {
          pending.delete(h);
          fn(...a);
        },
        ms,
        ...rest,
      );
      pending.add(h);
      return h;
    }) as typeof setTimeout);
    const clearSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation(((h: never) => {
      pending.delete(h);
      realClear(h);
    }) as typeof clearTimeout);
    try {
      const b = await bootAdmin(cli, { run: slowFailing(calls, 60), statusRetryMs: 10 });
      // The second connect starts while the first one's check is still running.
      const first = b.admin.call("payments.link.connect", { path: cli }, "k-c1");
      await waitFor(async () => calls.some((c) => c.startsWith("auth status")));
      const second = b.admin.call("payments.link.connect", { path: cli }, "k-c2");
      await Promise.all([first, second]);
      await b.stop();
      // No retry timer is left behind, not even one from the overlapped chain.
      expect(pending.size).toBe(0);
      await new Promise((r) => setTimeout(r, 100));
      const seen = calls.length;
      await new Promise((r) => setTimeout(r, 400));
      expect(calls.length).toBe(seen);
      expect(rejections).toEqual([]);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
      process.off("unhandledRejection", onRejection);
    }
  }, 20_000);

  it("goes on with the back-off when the status check itself throws (#1345)", async () => {
    const cli = fakeCli();
    const home = await signedInHome(cli);
    let services: ComposeServices | undefined;
    let armed = false;
    let thrown = 0;
    // The first CLI answer is lost. Then the next read of the saved CLI path throws, which comes
    // from `#runnable()` before the CLI is run, outside the run's own error handling.
    const lost: RunLink = async (file, args, env, timeout) => {
      const verb = args.filter((a) => !a.startsWith("-") && !a.endsWith(".js")).join(" ");
      if (verb.startsWith("auth status") && !armed && thrown === 0) {
        armed = true;
        throw new Error("timed out");
      }
      return runFile(file, args, env, timeout);
    };
    await boot(cli, {
      home,
      run: lost,
      statusRetryMs: 60,
      onServices: (s) => {
        services = s;
        const prev = readGuardOf(s.db);
        setReadGuard(s.db, {
          ...prev,
          check() {
            if (armed && new Error().stack?.includes("runnable")) {
              armed = false;
              thrown++;
              throw new Error("settings unreadable");
            }
            prev?.check();
          },
        });
      },
    });
    await waitFor(async () => services?.tools.get("checkout.pay_with_link") !== undefined);
    expect(thrown).toBe(1);
  }, 20_000);

  it("never joins a status run from before the last connect (#1342 N2)", async () => {
    const cli = fakeCli();
    const home = await signedInHome(cli);
    let services: ComposeServices | undefined;
    let slow = true;
    const slowOnce: RunLink = async (file, args, env, timeout) => {
      const out = await runFile(file, args, env, timeout);
      if (slow && args.includes("status")) {
        slow = false;
        await new Promise((r) => setTimeout(r, 400));
      }
      return out;
    };
    const b = await boot(cli, { home, run: slowOnce, onServices: (s) => (services = s) });
    const admin = await adminClient(b.composed.gateway);
    cleanups.push(() => admin.close());
    // The start check is running slowly; connect lands in the middle of it.
    await new Promise((r) => setTimeout(r, 100));
    await admin.call("payments.link.connect", { path: cli }, "k-again");
    await waitFor(async () => services?.tools.get("checkout.pay_with_link") !== undefined);
  });

  it("asks `auth status` again with back-off after a failed start check (#1332 N5)", async () => {
    const cli = fakeCli();
    const first = await bootAdmin(cli);
    await first.admin.call("payments.link.connect", { path: cli }, "k-c");
    await first.admin.call("payments.link.signIn", {}, "k-s");
    writeFileSync(join(first.home, "vault", "link-auth.json.approve"), "");
    await waitFor(
      async () =>
        (await first.admin.call<LinkSetupStatus>("payments.link.status", {})).state === "connected",
    );
    first.admin.close();
    await first.stop();
    // After the restart the first two checks time out; the third answers.
    let services: ComposeServices | undefined;
    const calls: string[] = [];
    let failures = 2;
    await boot(cli, {
      home: first.home,
      onServices: (s) => (services = s),
      run: flaky(() => failures-- > 0, calls),
      statusRetryMs: 20,
    });
    await waitFor(async () => services?.tools.get("checkout.pay_with_link") !== undefined);
    expect(calls.filter((c) => c.startsWith("auth status")).length).toBe(3);
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
    }, 20_000);
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

    it("sees a hold that is older than the 200 newest records", async () => {
      const cli = fakeCli();
      const newer: [string, string, number][] = Array.from({ length: 205 }, (_, i) => [
        `lsrq_done${i}`,
        "succeeded",
        1_000 + i,
      ]);
      const { admin } = await bootAdmin(cli, {
        spends: [["lsrq_hold1", "succeeded", 3 * 86_400_000, "held"], ...newer],
      });
      await admin.call("payments.link.connect", { path: cli }, "k-c");
      const res = await admin.request("payments.link.disconnect", {}, "k-d");
      expect(res.error).toMatchObject({
        code: "conflict",
        details: { reason: "payment_in_progress" },
      });
    }, 20_000);

    it("names the open payment in the refusal", async () => {
      const cli = fakeCli();
      const { admin } = await bootAdmin(cli, {
        spends: [["lsrq_open2", "pending_approval", 1_000]],
      });
      await admin.call("payments.link.connect", { path: cli }, "k-c");
      const res = await admin.request("payments.link.disconnect", {}, "k-d");
      expect(res.error).toMatchObject({
        details: { open: 1, payments: [{ merchantName: "Shop", merchantHost: "shop.example" }] },
      });
    });

    it("`force` gives the open payments up, audits it, and they no longer block", async () => {
      const cli = fakeCli();
      const { composed } = await boot(cli, {
        spends: [["lsrq_hold2", "succeeded", 60_000, "held"]],
      });
      const device = await pairDevice(composed, "admin-force", [
        "operator.read",
        "operator.write",
        "operator.approvals",
        "operator.admin",
      ]);
      await device.call("payments.link.connect", { path: cli }, "k-c");
      expect(await device.request("payments.link.disconnect", {}, "k-d1")).toMatchObject({
        ok: false,
        error: { code: "conflict" },
      });
      const gone = await device.call<LinkSetupStatus>(
        "payments.link.disconnect",
        { force: true },
        "k-d2",
      );
      expect(gone.cli).toBeUndefined();
      await waitFor(
        async () =>
          (await composed.audit.query({ kind: "payments.link_disconnect_forced" })).length > 0,
      );
      const entry = (await composed.audit.query({ kind: "payments.link_disconnect_forced" }))[0];
      expect(entry?.actor).toMatchObject({ type: "device", deviceId: "admin-force" });
      expect(entry?.data).toMatchObject({ open: "1", spends: "lsrq_hold2" });
      // Connected again, the given-up hold is not an open payment.
      await device.call("payments.link.connect", { path: cli }, "k-c2");
      expect(await device.request("payments.link.disconnect", {}, "k-d3")).toMatchObject({
        ok: true,
      });
    });

    it("`force` is for admins only", async () => {
      const cli = fakeCli();
      const { composed } = await boot(cli, { spends: [["lsrq_open3", "pending_approval", 1_000]] });
      const admin = await pairDevice(composed, "admin-x", [
        "operator.read",
        "operator.write",
        "operator.approvals",
        "operator.admin",
      ]);
      await admin.call("payments.link.connect", { path: cli }, "k-c");
      const reader = await pairDevice(composed, "reader-x", ["operator.read", "operator.write"]);
      const res = await reader.request("payments.link.disconnect", { force: true }, ik());
      expect((res.error as { code?: string } | undefined)?.code).toBe("forbidden");
      expect((await admin.call<LinkSetupStatus>("payments.link.status", {})).cli).toBeDefined();
      expect(await composed.audit.query({ kind: "payments.link_disconnect_forced" })).toHaveLength(
        0,
      );
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
