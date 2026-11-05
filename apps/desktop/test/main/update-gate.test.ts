import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bundleOfExecutable,
  evaluateUpdaterGate,
  type GateDeps,
  inspectQuarantine,
  parsePinnedRequirement,
  readBundledPinned,
  satisfiesRequirement,
} from "../../src/main/update-gate.ts";

/**
 * When the updater may run: only a packaged macOS app whose own signature satisfies the pinned
 * designated requirement (Psyche's self-signed release certificate), with a release key embedded.
 * Ad-hoc, dev and re-signed copies never update themselves.
 */

const HASH = "70ae89ae6be8c7e90b31e81e38ae892402b33f04";
const DESKTOP = `identifier "com.psyche.desktop" and certificate leaf = H"${HASH}"`;
const PINNED = [
  "# comment",
  `desktop\t${DESKTOP}`,
  `helper\tidentifier "com.psyche.helper" and certificate leaf = H"${HASH}"`,
  "",
].join("\n");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("parsePinnedRequirement", () => {
  it("reads a named line and ignores comments", () => {
    expect(parsePinnedRequirement(PINNED)).toBe(DESKTOP);
    expect(parsePinnedRequirement(PINNED, "helper")).toContain("com.psyche.helper");
    expect(parsePinnedRequirement(PINNED, "nope")).toBeUndefined();
  });

  it("treats the unfilled template as no requirement", () => {
    const template =
      'desktop\tidentifier "com.psyche.desktop" and certificate leaf = H"SHA1_OF_PSYCHE_RELEASE_CERT"';
    expect(parsePinnedRequirement(template)).toBeUndefined();
    expect(parsePinnedRequirement("desktop\t")).toBeUndefined();
    expect(parsePinnedRequirement("")).toBeUndefined();
  });
});

describe("evaluateUpdaterGate", () => {
  const base = (over: Partial<GateDeps> = {}): GateDeps => ({
    platform: "darwin",
    isPackaged: true,
    keyCount: 1,
    bundlePath: "/Applications/Psyche.app",
    readPinned: () => PINNED,
    satisfies: async () => true,
    ...over,
  });

  it("runs when the running app satisfies the pinned requirement and a key is embedded", async () => {
    const asked: string[] = [];
    const out = await evaluateUpdaterGate(
      base({
        satisfies: async (bundle, req) => {
          asked.push(bundle, req);
          return true;
        },
      }),
    );
    expect(out).toEqual({ run: true, requirement: DESKTOP });
    expect(asked).toEqual(["/Applications/Psyche.app", DESKTOP]);
  });

  it("never runs for an ad-hoc, development or re-signed copy", async () => {
    const out = await evaluateUpdaterGate(base({ satisfies: async () => false }));
    expect(out).toMatchObject({ run: false, state: "disabled" });
  });

  it("never runs when the build has no pinned requirement yet", async () => {
    for (const readPinned of [() => undefined, () => 'desktop\tx H"SHA1_OF_PSYCHE_RELEASE_CERT"']) {
      let asked = false;
      const out = await evaluateUpdaterGate(
        base({
          readPinned,
          satisfies: async () => {
            asked = true;
            return true;
          },
        }),
      );
      expect(out).toMatchObject({ run: false, state: "disabled" });
      expect(asked).toBe(false);
    }
  });

  it("never runs unpackaged or off macOS, and without asking codesign", async () => {
    let asked = false;
    const satisfies = async () => {
      asked = true;
      return true;
    };
    expect(await evaluateUpdaterGate(base({ isPackaged: false, satisfies }))).toMatchObject({
      run: false,
      state: "disabled",
    });
    expect(await evaluateUpdaterGate(base({ platform: "linux", satisfies }))).toMatchObject({
      run: false,
      state: "disabled",
    });
    expect(asked).toBe(false);
  });

  it("stays off with no release key, reported as no_keys for a correctly signed build", async () => {
    expect(await evaluateUpdaterGate(base({ keyCount: 0 }))).toMatchObject({
      run: false,
      state: "no_keys",
    });
    expect(
      await evaluateUpdaterGate(base({ keyCount: 0, satisfies: async () => false })),
    ).toMatchObject({ run: false, state: "disabled" });
  });
});

describe("satisfiesRequirement", () => {
  it("asks codesign to verify the bundle against the literal requirement", async () => {
    const calls: [string, string[]][] = [];
    const ok = await satisfiesRequirement("/x/Psyche.app", DESKTOP, async (file, args) => {
      calls.push([file, args]);
    });
    expect(ok).toBe(true);
    expect(calls).toEqual([
      ["/usr/bin/codesign", ["--verify", "--strict", "-R", `=${DESKTOP}`, "/x/Psyche.app"]],
    ]);
  });

  it("is false when codesign fails for any reason", async () => {
    expect(
      await satisfiesRequirement("/x", DESKTOP, async () => {
        throw new Error("code failed to satisfy specified code requirement(s)");
      }),
    ).toBe(false);
  });
});

describe("bundle paths", () => {
  // macOS bundle paths (POSIX separators); the gate never runs these on Windows.
  it.skipIf(process.platform === "win32")(
    "finds the bundle from the executable and reads the pinned file from Resources",
    () => {
      expect(bundleOfExecutable("/Applications/Psyche.app/Contents/MacOS/Psyche")).toBe(
        "/Applications/Psyche.app",
      );
      const dir = mkdtempSync(join(tmpdir(), "psyche-gate-"));
      dirs.push(dir);
      expect(readBundledPinned(dir)).toBeUndefined();
      writeFileSync(join(dir, "designated-requirements.txt"), PINNED);
      expect(readBundledPinned(dir)).toBe(PINNED);
    },
  );
});

describe("inspectQuarantine", () => {
  it("reports absent when the attribute is not there, and removed when it is", async () => {
    const calls: string[][] = [];
    const missing = Object.assign(new Error("exit 1"), {
      stderr: "xattr: No such xattr: com.apple.quarantine",
    });
    expect(
      await inspectQuarantine("/x.zip", async (_f, args) => {
        calls.push(args);
        throw missing;
      }),
    ).toBe("absent");
    expect(calls).toEqual([["-p", "com.apple.quarantine", "/x.zip"]]);

    const seen: string[][] = [];
    expect(
      await inspectQuarantine("/x.zip", async (_f, args) => {
        seen.push(args);
      }),
    ).toBe("removed");
    expect(seen.map((a) => a[0])).toEqual(["-p", "-d"]);
  });

  it("says unknown when xattr itself fails", async () => {
    expect(
      await inspectQuarantine("/x.zip", async () => {
        throw new Error("spawn failed");
      }),
    ).toBe("unknown");
  });

  it.runIf(process.platform === "darwin")(
    "on a real file: a file written by Node has no quarantine flag, and a flagged one is cleaned",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "psyche-quarantine-"));
      dirs.push(dir);
      const file = join(dir, "update.zip");
      writeFileSync(file, "zip");
      expect(await inspectQuarantine(file)).toBe("absent");

      execFileSync("/usr/bin/xattr", ["-w", "com.apple.quarantine", "0081;00000000;Test;", file]);
      expect(await inspectQuarantine(file)).toBe("removed");
      expect(await inspectQuarantine(file)).toBe("absent");
    },
  );
});
