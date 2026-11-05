import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bundleFingerprint,
  checkBundleIntegrity,
  claimedRequirement,
  INTEGRITY_MAX_AGE_MS,
  integrityText,
  type Run,
} from "../../src/main/bundle-integrity.ts";
import { HelperLauncher } from "../../src/main/helper-launcher.ts";

const REQ =
  'identifier "com.psyche.desktop" and certificate leaf = H"70ae89ae6be8c7e90b31e81e38ae892402b33f04"';
const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "psyche-integrity-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fake codesign: `claim` is what `-d -r-` prints, `verifies` what `--verify` answers. */
function fakeRun(state: { claim: string; verifies: boolean; calls: string[][] }): Run {
  return async (_file, args) => {
    state.calls.push(args);
    if (args[0] === "-d")
      return { stdout: state.claim ? `designated => ${state.claim}\n` : "", stderr: "" };
    if (state.verifies) return { stdout: "", stderr: "" };
    throw new Error("a sealed resource is missing or invalid");
  };
}

const base = (dir: string, over: Partial<Parameters<typeof checkBundleIntegrity>[0]> = {}) => ({
  bundle: "/Applications/Psyche.app",
  requirement: REQ,
  cacheFile: join(dir, "bundle-integrity.json"),
  appVersion: "1.0.0",
  fingerprint: "100:1",
  ...over,
});

describe("checkBundleIntegrity", () => {
  it("verifies deeply and caches the answer for a day", async () => {
    const dir = temp();
    const st = { claim: REQ, verifies: true, calls: [] as string[][] };
    let t = 1_000_000;
    const deps = base(dir, { run: fakeRun(st), now: () => t });
    expect(await checkBundleIntegrity(deps)).toEqual({ state: "ok", cached: false });
    const verifies = () => st.calls.filter((a) => a[0] === "--verify");
    expect(verifies()).toHaveLength(1);
    expect(verifies()[0]).toEqual([
      "--verify",
      "--deep",
      "--strict",
      "-R",
      `=${REQ}`,
      "/Applications/Psyche.app",
    ]);

    // A launch an hour later reads the cache: no second deep verify.
    t += 3600_000;
    expect(await checkBundleIntegrity(deps)).toEqual({ state: "ok", cached: true });
    expect(verifies()).toHaveLength(1);

    // After a day it verifies again.
    t += INTEGRITY_MAX_AGE_MS;
    expect((await checkBundleIntegrity(deps)).cached).toBe(false);
    expect(verifies()).toHaveLength(2);
  });

  it("blocks a bundle that claims the release identity but does not verify", async () => {
    const st = { claim: REQ, verifies: false, calls: [] as string[][] };
    expect(await checkBundleIntegrity(base(temp(), { run: fakeRun(st) }))).toEqual({
      state: "blocked",
      cached: false,
    });
  });

  it("verifies again when the bundle was replaced or the app updated", async () => {
    const dir = temp();
    const st = { claim: REQ, verifies: false, calls: [] as string[][] };
    const run = fakeRun(st);
    expect((await checkBundleIntegrity(base(dir, { run }))).state).toBe("blocked");
    // The owner reinstalls: a new seal file (fingerprint), and now it verifies.
    st.verifies = true;
    expect(await checkBundleIntegrity(base(dir, { run, fingerprint: "200:2" }))).toEqual({
      state: "ok",
      cached: false,
    });
    expect((await checkBundleIntegrity(base(dir, { run, appVersion: "1.0.1" }))).cached).toBe(
      false,
    );
  });

  it("does not enforce for an ad-hoc, development or re-signed copy", async () => {
    for (const claim of ["", 'cdhash H"abc"', REQ.replace("70ae89ae", "00000000")]) {
      const st = { claim, verifies: false, calls: [] as string[][] };
      expect(await checkBundleIntegrity(base(temp(), { run: fakeRun(st) }))).toEqual({
        state: "not_release",
        cached: false,
      });
      expect(st.calls.filter((a) => a[0] === "--verify")).toHaveLength(0);
    }
  });

  it("ignores a corrupt cache file", async () => {
    const dir = temp();
    writeFileSync(join(dir, "bundle-integrity.json"), "{nope");
    const st = { claim: REQ, verifies: true, calls: [] as string[][] };
    expect((await checkBundleIntegrity(base(dir, { run: fakeRun(st) }))).state).toBe("ok");
  });
});

describe("helpers", () => {
  it("claimedRequirement reads the designated line, and is empty when codesign fails", async () => {
    expect(
      await claimedRequirement("/x", async () => ({
        stdout: `Executable=/x\ndesignated => ${REQ}\n`,
        stderr: "",
      })),
    ).toBe(REQ);
    expect(
      await claimedRequirement("/x", async () => {
        throw new Error("no");
      }),
    ).toBe("");
  });

  it("bundleFingerprint changes with the seal file", () => {
    const dir = temp();
    expect(bundleFingerprint(dir)).toBe("none");
    mkdirSync(join(dir, "Contents", "_CodeSignature"), { recursive: true });
    writeFileSync(join(dir, "Contents", "_CodeSignature", "CodeResources"), "a");
    const a = bundleFingerprint(dir);
    writeFileSync(join(dir, "Contents", "_CodeSignature", "CodeResources"), "ab");
    expect(bundleFingerprint(dir)).not.toBe(a);
  });

  it("has the warning in English and in a translated language", async () => {
    const en = await integrityText("en-US");
    expect(en.title).toMatch(/changed/);
    expect(en.detail).toMatch(/microphone, screen, Apple Events, Contacts and Calendar/);
    const de = await integrityText("de-DE");
    expect(de.title).not.toBe(en.title);
    expect(de.ok).toBe("OK");
    const ja = await integrityText("ja-JP");
    expect(ja.detail).not.toBe(en.detail);
  });
});

describe("the helper stays off while the signature fails", () => {
  it("does not launch or relaunch the Mac helper", async () => {
    const dir = temp();
    const app = join(dir, "PsycheHelper.app");
    mkdirSync(app);
    const opened: string[][] = [];
    const states: string[] = [];
    let blocked = true;
    const launcher = new HelperLauncher({
      appPath: app,
      psycheHome: dir,
      run: async (file, args) => {
        opened.push([file, ...args]);
        return { code: 0, stdout: "", stderr: "" };
      },
      isPaired: async () => false,
      blocked: () => blocked,
      onState: (s) => states.push(s.kind),
      sleep: async () => {},
      pairTimeoutMs: 0,
    });
    await launcher.launch();
    await launcher.onPresence(false);
    expect(opened).toEqual([]);
    expect(launcher.getState()).toMatchObject({ kind: "offline" });
    blocked = false;
    await launcher.launch();
    expect(opened.length).toBe(1);
  });
});
