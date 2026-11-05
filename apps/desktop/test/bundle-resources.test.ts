import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUNDLED_PLIST,
  bundleSources,
  bundleSourcesWin32,
  copyBundleResources,
  copyBundleResourcesWin32,
  HELPER_APP_NAME,
  isMachO,
  skipOuterSigning,
  TRAY_ICON,
  verifyNestedHelper,
  WIN_HELPER_DIR,
  WIN_HELPER_EXE,
} from "../src/packaging/bundle-resources.ts";

function fakeBuilds(dir: string, opts: { helper?: boolean; psyched?: boolean } = {}) {
  const psychedDir = join(dir, "gateway", "psyched");
  const helperApp = join(dir, "helper", HELPER_APP_NAME);
  if (opts.psyched !== false) {
    mkdirSync(join(psychedDir, "runtime"), { recursive: true });
    writeFileSync(join(psychedDir, "psyched"), "#!/bin/sh\n");
    chmodSync(join(psychedDir, "psyched"), 0o755);
    writeFileSync(join(psychedDir, "runtime", "node"), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0]));
    mkdirSync(join(psychedDir, "app", "skills"), { recursive: true });
    writeFileSync(join(psychedDir, "app", "skills", "README.md"), "# Bundled skills\n");
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
      psychedDir: join("/repo", "apps/gateway/dist-bin/darwin-arm64/psyched"),
      helperApp: join("/repo", "apps/mac-helper/dist", HELPER_APP_NAME),
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
      /PsycheHelper\.app: not found .*build-helper\.sh --arch arm64[\s\S]*PSYCHE_PACKAGE_ALLOW_PARTIAL=1/,
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

  it("refuses a psyched build without its bundled skills (#506)", () => {
    const dir = mkdtempSync(join(tmpdir(), "psyche-bundle-"));
    const sources = fakeBuilds(dir);
    rmSync(join(sources.psychedDir, "app", "skills"), { recursive: true });
    expect(() =>
      copyBundleResources(sources, join(dir, "Resources"), "arm64", { allowPartial: false }),
    ).toThrow(/psyched \(the Gateway\): not found at .*app[\\/]skills[\\/]README\.md/);
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

  it("checks the helper's own signature instead of re-signing it", () => {
    const dir = mkdtempSync(join(tmpdir(), "psyche-bundle-"));
    const { helperApp } = fakeBuilds(dir);
    const adhoc = (args: string[]) => (args[0] === "-dv" ? "Signature=adhoc\n" : "");
    expect(() => verifyNestedHelper(helperApp, undefined, adhoc)).not.toThrow();
    expect(() => verifyNestedHelper(helperApp, "Developer ID Application: X (T)", adhoc)).toThrow(
      /signed ad-hoc .*build-helper\.sh with the same PSYCHE_SIGN_IDENTITY/,
    );
    const broken = () => {
      throw new Error("invalid signature");
    };
    expect(() => verifyNestedHelper(helperApp, undefined, broken)).toThrow(/no valid signature/);
    expect(() => verifyNestedHelper(join(dir, "nope.app"), undefined, broken)).not.toThrow();
  });
});

describe("bundle resources (Windows)", () => {
  function fakeWinBuilds(dir: string, opts: { helper?: boolean } = {}) {
    const psychedDir = join(dir, "gateway", "psyched");
    mkdirSync(join(psychedDir, "runtime"), { recursive: true });
    mkdirSync(join(psychedDir, "app", "skills"), { recursive: true });
    for (const f of [
      "psyched.cmd",
      "runtime/node.exe",
      "app/skills/README.md",
      "service-host.mjs",
      "psyche-gateway.task.xml.template",
    ])
      writeFileSync(join(psychedDir, f), "x");
    const helperExe = join(dir, "helper", WIN_HELPER_EXE);
    if (opts.helper !== false) {
      mkdirSync(join(dir, "helper"), { recursive: true });
      writeFileSync(helperExe, "MZ");
    }
    const trayIcon = join(dir, TRAY_ICON);
    writeFileSync(trayIcon, "ico");
    return { psychedDir, helperExe, trayIcon };
  }

  it("defaults to the win32 psyched build, the cargo release helper and the tray icon", () => {
    expect(bundleSourcesWin32({}, "/repo", "x64")).toEqual({
      psychedDir: join("/repo", "apps/gateway/dist-bin/win32-x64/psyched"),
      helperExe: join("/repo", "apps/win-helper/target/release", WIN_HELPER_EXE),
      trayIcon: join("/repo", "apps/desktop/assets", TRAY_ICON),
    });
    expect(
      bundleSourcesWin32(
        { PSYCHE_WIN_HELPER_EXE: "C:/h.exe", PSYCHE_PSYCHED_DIR: "C:/p" },
        "/r",
        "x64",
      ),
    ).toMatchObject({ psychedDir: "C:/p", helperExe: "C:/h.exe" });
  });

  it("copies psyched, the helper and the tray icon into resources, and nothing from macOS", () => {
    const dir = mkdtempSync(join(tmpdir(), "psyche-win-bundle-"));
    const res = join(dir, "resources");
    expect(
      copyBundleResourcesWin32(fakeWinBuilds(dir), res, "x64", { allowPartial: false }),
    ).toEqual([]);
    expect(existsSync(join(res, "psyched", "psyched.cmd"))).toBe(true);
    expect(existsSync(join(res, "psyched", "runtime", "node.exe"))).toBe(true);
    expect(existsSync(join(res, WIN_HELPER_DIR, WIN_HELPER_EXE))).toBe(true);
    expect(existsSync(join(res, TRAY_ICON))).toBe(true);
    expect(existsSync(join(res, BUNDLED_PLIST))).toBe(false);
    expect(existsSync(join(res, HELPER_APP_NAME))).toBe(false);
  });

  it("names the cargo command when the helper is missing, unless partial packages are allowed", () => {
    const dir = mkdtempSync(join(tmpdir(), "psyche-win-bundle-"));
    const sources = fakeWinBuilds(dir, { helper: false });
    expect(() =>
      copyBundleResourcesWin32(sources, join(dir, "resources"), "x64", { allowPartial: false }),
    ).toThrow(
      /The Windows package would not be self-contained[\s\S]*psyche-helper\.exe: not found .*cargo build --release --manifest-path apps\/win-helper\/Cargo\.toml[\s\S]*PSYCHE_WIN_HELPER_EXE/,
    );
    const missing = copyBundleResourcesWin32(sources, join(dir, "resources"), "x64", {
      allowPartial: true,
    });
    expect(missing.map((p) => p.name)).toEqual([WIN_HELPER_EXE]);
  });

  it("refuses a psyched without node.exe or the scheduled-task template", () => {
    const dir = mkdtempSync(join(tmpdir(), "psyche-win-bundle-"));
    const sources = fakeWinBuilds(dir);
    rmSync(join(sources.psychedDir, "psyche-gateway.task.xml.template"));
    expect(() =>
      copyBundleResourcesWin32(sources, join(dir, "resources"), "x64", { allowPartial: false }),
    ).toThrow(/psyche-gateway\.task\.xml\.template/);
  });
});
