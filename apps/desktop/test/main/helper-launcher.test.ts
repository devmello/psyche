import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  askHelperNotificationsIfUndetermined,
  HelperLauncher,
  type HelperRunState,
  helperCanHoldKeychain,
  openHelperArgs,
  readHelperIdentity,
} from "../../src/main/helper-launcher.ts";
import type { Runner } from "../../src/main/supervisor.ts";

const dir = mkdtempSync(join(tmpdir(), "psy-helper-"));
const appPath = join(dir, "PsycheHelper.app");
mkdirSync(appPath);

function fake(opts: { pairsAfterOpen?: boolean; openCode?: number } = {}) {
  const calls: string[][] = [];
  let opened = false;
  let t = 0;
  const run: Runner = async (file, args) => {
    calls.push([file, ...args]);
    opened = true;
    return { code: opts.openCode ?? 0, stdout: "", stderr: opts.openCode ? "LSOpen failed" : "" };
  };
  const states: HelperRunState[] = [];
  const launcher = new HelperLauncher({
    appPath,
    psycheHome: join(dir, "home"),
    run,
    isPaired: async () => opened && (opts.pairsAfterOpen ?? true),
    onState: (s) => states.push(s),
    pairTimeoutMs: 3_000,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  });
  return { calls, states, launcher, advance: (ms: number) => (t += ms) };
}

describe("HelperLauncher", () => {
  it("opens the bundled helper through LaunchServices, passing a non-default home", () => {
    expect(openHelperArgs("/A/PsycheHelper.app", "/Users/me/.psyche", "/Users/me")).toEqual([
      "-g",
      "-j",
      "/A/PsycheHelper.app",
    ]);
    expect(openHelperArgs("/A/PsycheHelper.app", "/tmp/h", "/Users/me")).toEqual([
      "-g",
      "-j",
      "--env",
      "PSYCHE_HOME=/tmp/h",
      "/A/PsycheHelper.app",
    ]);
  });

  it("restart quits only a process that is a psyche-helper, then launches again", async () => {
    const killed: number[] = [];
    const calls: string[][] = [];
    let clock = 0;
    let paired = true;
    const make = (comm: string) =>
      new HelperLauncher({
        appPath,
        psycheHome: join(dir, "home"),
        run: async (file, args) => {
          calls.push([file, ...args]);
          if (file === "/usr/bin/open") paired = true;
          return { code: 0, stdout: file === "/bin/ps" ? comm : "", stderr: "" };
        },
        isPaired: async () => paired,
        readPid: () => 4242,
        kill: (pid) => {
          killed.push(pid);
          paired = false;
        },
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        pairTimeoutMs: 3_000,
      });
    await make("/x/psyche-helper\n").restart();
    expect(killed).toEqual([4242]);
    expect(calls.some((c) => c[0] === "/usr/bin/open")).toBe(true);
    // Some other program's pid in the lock file is never signalled.
    killed.length = 0;
    paired = true;
    await make("/usr/bin/some-other\n").restart();
    expect(killed).toEqual([]);
  });

  it("launches once, waits for it to pair, and does not relaunch while paired", async () => {
    const f = fake();
    await Promise.all([f.launcher.launch(), f.launcher.launch()]);
    expect(f.calls).toEqual([
      ["/usr/bin/open", "-g", "-j", "--env", `PSYCHE_HOME=${join(dir, "home")}`, appPath],
    ]);
    expect(f.states.map((s) => s.kind)).toEqual(["starting", "paired"]);
    await f.launcher.onPresence(true);
    expect(f.calls).toHaveLength(1);
  });

  it("reports a helper that never pairs, and relaunches it when it went away (throttled)", async () => {
    const f = fake({ pairsAfterOpen: false });
    await f.launcher.launch();
    expect(f.launcher.getState()).toEqual({
      kind: "offline",
      reason: "it did not connect to the Gateway",
    });
    await f.launcher.onPresence(false);
    expect(f.calls).toHaveLength(1);
    f.advance(61_000);
    await f.launcher.onPresence(false);
    expect(f.calls).toHaveLength(2);
  });

  it("surfaces an open failure and does nothing without a bundled helper", async () => {
    const f = fake({ openCode: 1 });
    await f.launcher.launch();
    expect(f.launcher.getState()).toEqual({ kind: "offline", reason: "LSOpen failed" });
    const none = new HelperLauncher({
      appPath: undefined,
      psycheHome: dir,
      run: async () => {
        throw new Error("must not run");
      },
      isPaired: async () => false,
    });
    await none.launch();
    await none.onPresence(false);
    expect(none.getState()).toEqual({ kind: "unbundled" });
  });

  it("gives the vault the Keychain slot only for a team-signed helper with a provisioning profile", async () => {
    const signed =
      (team: string, adhoc = false): Runner =>
      async () => ({
        code: 0,
        stdout: "",
        stderr: `Identifier=com.psyche.helper\n${adhoc ? "Signature=adhoc\n" : ""}TeamIdentifier=${team}\n`,
      });
    const app = join(dir, "Signed.app");
    mkdirSync(join(app, "Contents"), { recursive: true });
    expect(await helperCanHoldKeychain(app, signed("ABCDE12345"))).toBe(false); // no profile
    writeFileSync(join(app, "Contents", "embedded.provisionprofile"), "profile");
    expect(await helperCanHoldKeychain(app, signed("ABCDE12345"))).toBe(true);
    expect(await helperCanHoldKeychain(app, signed("not set", true))).toBe(false);
    expect(await helperCanHoldKeychain(undefined, signed("ABCDE12345"))).toBe(false);
  });
});

describe("askHelperNotificationsIfUndetermined", () => {
  it("asks only when the helper was never asked (notify.show refuses every card until then)", async () => {
    const calls: string[] = [];
    const invoke = (status: string) => async (capability: string) => {
      calls.push(capability);
      return capability === "notify.authorization_status" ? { status } : { granted: true };
    };
    expect(await askHelperNotificationsIfUndetermined(invoke("notDetermined"))).toBe(true);
    expect(calls).toEqual(["notify.authorization_status", "notify.request_authorization"]);
    calls.length = 0;
    for (const status of ["authorized", "denied", "provisional"]) {
      expect(await askHelperNotificationsIfUndetermined(invoke(status))).toBe(false);
    }
    expect(calls).not.toContain("notify.request_authorization");
  });
});

describe("readHelperIdentity (security review, finding 1)", () => {
  const app = () => {
    const dir = mkdtempSync(join(tmpdir(), "psy-helper-id-"));
    const appPath = join(dir, "PsycheHelper.app");
    mkdirSync(join(appPath, "Contents", "MacOS"), { recursive: true });
    return appPath;
  };
  const out =
    (o: unknown, code = 0) =>
    async () => ({ code, stdout: JSON.stringify(o) });

  it("runs the bundled executable with --print-identity and this PSYCHE_HOME", async () => {
    const appPath = app();
    const calls: { file: string; args: string[]; home?: string }[] = [];
    const id = await readHelperIdentity(appPath, "/tmp/home", async (file, args, env) => {
      calls.push({ file, args, home: env.PSYCHE_HOME });
      return {
        code: 0,
        stdout: JSON.stringify({
          deviceId: "dev_abcdefghijklmnopqrstuv",
          presenceKeyId: "a".repeat(64),
          presenceKeyKind: "enclave_file",
        }),
      };
    });
    expect(calls).toEqual([
      {
        file: join(appPath, "Contents", "MacOS", "psyche-helper"),
        args: ["--print-identity"],
        home: "/tmp/home",
      },
    ]);
    expect(id).toEqual({
      deviceId: "dev_abcdefghijklmnopqrstuv",
      keyId: "a".repeat(64),
      kind: "enclave_file",
    });
  });

  it("trusts nothing malformed: no bundle, a failed run, a bad device id or key id", async () => {
    expect(await readHelperIdentity(undefined, "/h", out({}))).toBeUndefined();
    const appPath = app();
    expect(await readHelperIdentity(appPath, "/h", out({ deviceId: "x" }))).toBeUndefined();
    expect(
      await readHelperIdentity(appPath, "/h", out({ deviceId: "dev_abcdefghijklmnopqrstuv" }, 1)),
    ).toBeUndefined();
    expect(
      await readHelperIdentity(
        appPath,
        "/h",
        out({
          deviceId: "dev_abcdefghijklmnopqrstuv",
          presenceKeyId: "nothex",
          presenceError: "missing_entitlement",
        }),
      ),
    ).toEqual({ deviceId: "dev_abcdefghijklmnopqrstuv", error: "missing_entitlement" });
  });
});
