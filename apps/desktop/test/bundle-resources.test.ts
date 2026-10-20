import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUNDLED_PLIST,
  bundleSources,
  copyBundleResources,
  HELPER_APP_NAME,
  isMachO,
  signNestedHelper,
  skipOuterSigning,
} from "../src/packaging/bundle-resources.ts";

function fakeBuilds(dir: string, opts: { helper?: boolean; psyched?: boolean } = {}) {
  const psychedDir = join(dir, "gateway", "psyched");
  const helperApp = join(dir, "helper", HELPER_APP_NAME);
  if (opts.psyched !== false) {
    mkdirSync(join(psychedDir, "runtime"), { recursive: true });
    writeFileSync(join(psychedDir, "psyched"), "#!/bin/sh\n");
    chmodSync(join(psychedDir, "psyched"), 0o755);
    writeFileSync(join(psychedDir, "runtime", "node"), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0]));
    writeFileSync(
      join(psychedDir, "com.psyche.gateway.plist.template"),
      "<plist>{{PSYCHED}}</plist>",
    );
  }
  if (opts.helper !== false) {
    mkdirSync(join(helperApp, "Contents", "MacOS"), { recursive: true });
    writeFileSync(join(helperApp, "Contents", "MacOS", "psyche-helper"), "bin");
  }
  return { psychedDir, helperApp };
}

describe("bundle resources", () => {
  it("defaults to the S22 and S14 build outputs, overridable from env", () => {
    expect(bundleSources({}, "/repo", "arm64")).toEqual({
      psychedDir: "/repo/apps/gateway/dist-bin/darwin-arm64/psyched",
      helperApp: `/repo/apps/mac-helper/.build/${HELPER_APP_NAME}`,
    });
    expect(
      bundleSources({ PSYCHE_PSYCHED_DIR: "/b/psyched", PSYCHE_HELPER_APP: "/h.app" }, "/r", "x64"),
    ).toEqual({ psychedDir: "/b/psyched", helperApp: "/h.app" });
  });

  it("copies psyched, the plist template and the helper into Resources", () => {
    const dir = mkdtempSync(join(tmpdir(), "psyche-bundle-"));
    const res = join(dir, "Resources");
    const missing = copyBundleResources(fakeBuilds(dir), res, "arm64", { allowPartial: false });
    expect(missing).toEqual([]);
    expect(existsSync(join(res, "psyched", "psyched"))).toBe(true);
    expect(existsSync(join(res, "psyched", "runtime", "node"))).toBe(true);
    expect(readFileSync(join(res, BUNDLED_PLIST), "utf8")).toContain("{{PSYCHED}}");
    expect(existsSync(join(res, HELPER_APP_NAME, "Contents", "MacOS", "psyche-helper"))).toBe(true);
  });

  it("fails with what is missing and how to build it, unless partial packages are allowed", () => {
    const dir = mkdtempSync(join(tmpdir(), "psyche-bundle-"));
    const sources = fakeBuilds(dir, { helper: false });
    const res = join(dir, "Resources");
    expect(() => copyBundleResources(sources, res, "arm64", { allowPartial: false })).toThrow(
      /Psyche Helper\.app: not found .*build-app\.sh[\s\S]*PSYCHE_PACKAGE_ALLOW_PARTIAL=1/,
    );
    const warnings: string[] = [];
    const missing = copyBundleResources(sources, res, "arm64", {
      allowPartial: true,
      warn: (m) => warnings.push(m),
    });
    expect(missing.map((p) => p.name)).toEqual([HELPER_APP_NAME]);
    expect(warnings[0]).toContain("continuing");
    expect(existsSync(join(res, "psyched", "psyched"))).toBe(true);
  });

  it("lets osx-sign sign only Mach-O files in psyched/ and never the helper", () => {
    const dir = mkdtempSync(join(tmpdir(), "psyche-bundle-"));
    const res = join(dir, "Psyche.app", "Contents", "Resources");
    copyBundleResources(fakeBuilds(dir), res, "arm64", { allowPartial: false });
    expect(isMachO(join(res, "psyched", "runtime", "node"))).toBe(true);
    expect(skipOuterSigning(join(res, "psyched", "runtime", "node"))).toBe(false);
    expect(skipOuterSigning(join(res, "psyched", "psyched"))).toBe(true);
    expect(skipOuterSigning(join(res, HELPER_APP_NAME))).toBe(true);
    expect(skipOuterSigning(join(res, HELPER_APP_NAME, "Contents", "MacOS", "psyche-helper"))).toBe(
      true,
    );
    expect(skipOuterSigning(join(dir, "Psyche.app", "Contents", "MacOS", "Psyche"))).toBe(false);
  });

  it("signs the helper ad-hoc or with the Developer ID, keeping its entitlements", () => {
    const dir = mkdtempSync(join(tmpdir(), "psyche-bundle-"));
    const { helperApp } = fakeBuilds(dir);
    const calls: string[][] = [];
    signNestedHelper(helperApp, undefined, (a) => calls.push(a));
    signNestedHelper(helperApp, "Developer ID Application: X (T)", (a) => calls.push(a));
    signNestedHelper(join(dir, "nope.app"), undefined, (a) => calls.push(a));
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(
      expect.arrayContaining(["--sign", "-", "--timestamp=none", helperApp]),
    );
    expect(calls[0]?.join(" ")).toContain("--preserve-metadata=entitlements");
    expect(calls[1]).toEqual(expect.arrayContaining(["--options", "runtime", "--timestamp"]));
  });
});
