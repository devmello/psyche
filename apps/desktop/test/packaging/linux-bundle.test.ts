import {
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
import { afterEach, describe, expect, it } from "vitest";
import {
  bundleSourcesLinux,
  copyBundleResourcesLinux,
  findLinks,
  linuxArtifactName,
  linuxIconSet,
  renameLinuxArtifacts,
  renderGatewayUnit,
} from "../../src/packaging/linux-bundle.ts";

const REPO = join(import.meta.dirname, "..", "..", "..", "..");
const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "psyche-linux-bundle-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A psyched folder shaped like build-psyched.mjs --platform linux output. */
function fakePsyched() {
  const d = join(temp(), "psyched");
  mkdirSync(join(d, "runtime"), { recursive: true });
  mkdirSync(join(d, "app", "skills"), { recursive: true });
  writeFileSync(join(d, "psyched"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(d, "runtime", "node"), "node", { mode: 0o755 });
  writeFileSync(join(d, "app", "skills", "README.md"), "skills");
  writeFileSync(join(d, "build-info.json"), JSON.stringify({ build: "0123456789abcdef" }));
  return d;
}

function sources(over: Partial<ReturnType<typeof bundleSourcesLinux>> = {}) {
  return { ...bundleSourcesLinux({}, REPO, "x64"), psychedDir: fakePsyched(), ...over };
}

describe("renderGatewayUnit", () => {
  const tpl = readFileSync(
    join(REPO, "deploy/linux/root/usr/lib/systemd/user/psyche-gateway.service.in"),
    "utf8",
  );
  it("fills in the installed psyched path and the build", () => {
    const out = renderGatewayUnit(tpl, {
      psyched: "/usr/lib/psyche/resources/psyched/psyched",
      build: "0123456789abcdef",
    });
    expect(out).toContain("ExecStart=/usr/lib/psyche/resources/psyched/psyched\n");
    expect(out).toContain("Environment=PSYCHE_BUILD=0123456789abcdef");
    expect(out).not.toMatch(/@[A-Z_]+@/);
    expect(out).toContain("NoNewPrivileges=yes");
  });
  it("refuses a path with whitespace, a bad build id and an unfilled placeholder", () => {
    expect(() =>
      renderGatewayUnit(tpl, { psyched: "/a b/psyched", build: "0123456789abcdef" }),
    ).toThrow();
    expect(() => renderGatewayUnit(tpl, { psyched: "/x/psyched", build: "not a build" })).toThrow();
    expect(() =>
      renderGatewayUnit("ExecStart=@OTHER@", { psyched: "/x", build: "0123456789abcdef" }),
    ).toThrow(/placeholder/);
  });
});

describe("copyBundleResourcesLinux", () => {
  it("lays out psyched, the installer, its payload and psyche-apprun in the packaged folder", () => {
    const out = join(temp(), "Psyche-linux-x64");
    mkdirSync(join(out, "resources"), { recursive: true });
    const warnings: string[] = [];
    const res = copyBundleResourcesLinux(sources(), out, {
      allowPartial: false,
      warn: (m) => warnings.push(m),
    });
    const r = (p: string) => join(out, "resources", p);
    expect(existsSync(r("psyched/psyched"))).toBe(true);
    expect(existsSync(r("psyched/runtime/node"))).toBe(true);
    expect(statSync(r("psyche-system-setup")).mode & 0o111).not.toBe(0);
    expect(statSync(join(out, "psyche-apprun")).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(out, "psyche-apprun"), "utf8")).toBe(
      readFileSync(join(REPO, "deploy/linux/AppRun"), "utf8"),
    );
    const unit = readFileSync(r("system/usr/lib/systemd/user/psyche-gateway.service"), "utf8");
    expect(unit).toContain("ExecStart=/usr/lib/psyche/resources/psyched/psyched");
    expect(unit).toContain("PSYCHE_BUILD=0123456789abcdef");
    expect(existsSync(r("system/etc/apparmor.d/psyche"))).toBe(true);
    // Nothing else from deploy/linux/root rides along (desktop file and icons are the makers' job).
    expect(existsSync(r("system/usr/share/applications"))).toBe(false);
    expect(existsSync(r("system/usr/share/icons"))).toBe(false);
    // The helper (L3) and the polkit policy (L4) are optional: the build warns and goes on.
    expect(res.missing).toEqual([]);
    expect(res.skipped).toContain("psyche-helper");
    expect(warnings.join("\n")).toContain("psyche-helper");
  });

  it("copies the polkit policy and the helper when they exist", () => {
    const out = join(temp(), "Psyche-linux-x64");
    const root = join(temp(), "root");
    cpSyncRoot(root);
    const policyDir = join(root, "usr/share/polkit-1/actions");
    mkdirSync(policyDir, { recursive: true });
    writeFileSync(join(policyDir, "com.psyche.presence.policy"), "<policyconfig/>");
    const helper = join(temp(), "psyche-helper");
    writeFileSync(helper, "elf");
    const res = copyBundleResourcesLinux(sources({ rootDir: root, helperBin: helper }), out, {
      allowPartial: false,
    });
    expect(res.skipped).toEqual([]);
    expect(
      existsSync(
        join(out, "resources/system/usr/share/polkit-1/actions/com.psyche.presence.policy"),
      ),
    ).toBe(true);
    expect(statSync(join(out, "resources/psyche-helper")).mode & 0o111).not.toBe(0);
  });

  it("refuses a link in the polkit folder: the folder is installed as root", () => {
    const root = join(temp(), "root");
    cpSyncRoot(root);
    const dir = join(root, "usr/share/polkit-1/actions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "real"), "x");
    symlinkSync("/etc/passwd", join(dir, "evil"));
    expect(findLinks(join(root, "usr/share/polkit-1"))).toEqual([join("actions", "evil")]);
    expect(() =>
      copyBundleResourcesLinux(sources({ rootDir: root }), join(temp(), "out"), {
        allowPartial: false,
      }),
    ).toThrow(/links in/);
  });

  it("fails when psyched is missing, unless partial packages are allowed", () => {
    const missing = sources({ psychedDir: join(temp(), "nope") });
    expect(() =>
      copyBundleResourcesLinux(missing, join(temp(), "out"), { allowPartial: false }),
    ).toThrow(/build-psyched.mjs --platform linux/);
    const out = join(temp(), "out");
    const res = copyBundleResourcesLinux(missing, out, { allowPartial: true, warn: () => {} });
    expect(res.missing.join("\n")).toContain("psyched");
    expect(existsSync(join(out, "resources/psyched"))).toBe(false);
    expect(existsSync(join(out, "psyche-apprun"))).toBe(true);
  });
});

/** deploy/linux/root minus the polkit folder, as a stand-in tree the test can add to. */
function cpSyncRoot(dest: string) {
  const src = join(REPO, "deploy/linux/root");
  mkdirSync(join(dest, "usr/lib/systemd/user"), { recursive: true });
  mkdirSync(join(dest, "etc/apparmor.d"), { recursive: true });
  writeFileSync(
    join(dest, "usr/lib/systemd/user/psyche-gateway.service.in"),
    readFileSync(join(src, "usr/lib/systemd/user/psyche-gateway.service.in")),
  );
  writeFileSync(
    join(dest, "etc/apparmor.d/psyche"),
    readFileSync(join(src, "etc/apparmor.d/psyche")),
  );
}

describe("icons and artifact names", () => {
  it("finds the hicolor sizes that ship", () => {
    const set = linuxIconSet(join(REPO, "deploy/linux/root/usr/share/icons/hicolor"));
    expect(Object.keys(set)).toEqual([
      "16x16",
      "24x24",
      "32x32",
      "48x48",
      "64x64",
      "128x128",
      "256x256",
      "512x512",
    ]);
    for (const f of Object.values(set)) expect(existsSync(f)).toBe(true);
  });

  it("names artifacts the way update-manifest.mjs classifies them", () => {
    expect(linuxArtifactName("1.2.3", "x64", "AppImage")).toBe("Psyche-1.2.3-linux-x64.AppImage");
    expect(linuxArtifactName("1.2.3-beta.1", "arm64", "deb")).toBe(
      "Psyche-1.2.3-beta.1-linux-arm64.deb",
    );
  });

  it("renames the makers' files in place and leaves the zip alone", () => {
    const moves: [string, string][] = [];
    const results = [
      { arch: "x64", artifacts: ["/o/make/Psyche-linux-x64-1.0.0.zip"] },
      { arch: "x64", artifacts: ["/o/make/deb/x64/psyche_1.0.0~alpha.0_amd64.deb"] },
      { arch: "x64", artifacts: ["/o/make/rpm/x64/psyche-1.0.0_alpha.0-1.x86_64.rpm"] },
      { arch: "arm64", artifacts: ["/o/make/AppImage/arm64/Psyche-1.0.0-alpha.0-arm64.AppImage"] },
    ];
    renameLinuxArtifacts(
      results,
      "1.0.0-alpha.0",
      () => {},
      (a, b) => void moves.push([a, b]),
    );
    expect(results.map((r) => r.artifacts[0])).toEqual([
      "/o/make/Psyche-linux-x64-1.0.0.zip",
      "/o/make/deb/x64/Psyche-1.0.0-alpha.0-linux-x64.deb",
      "/o/make/rpm/x64/Psyche-1.0.0-alpha.0-linux-x64.rpm",
      "/o/make/AppImage/arm64/Psyche-1.0.0-alpha.0-linux-arm64.AppImage",
    ]);
    expect(moves).toHaveLength(3);
  });

  it("refuses two files of one kind in one result", () => {
    expect(() =>
      renameLinuxArtifacts(
        [{ arch: "x64", artifacts: ["/a/one.deb", "/a/two.deb"] }],
        "1.0.0",
        () => {},
        () => {},
      ),
    ).toThrow(/two \.deb/);
  });
});
