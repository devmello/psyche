import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The helper-only packages in the signed manifest (H7; linux-helper-only design section 9):
 * `psyche-helper update` unpacks `psyche-helper-<release>-linux-<arch>/bin/psyche-helper` from the
 * `helper-tar-zst` entry, so a file of another version, or a half set, must not be signed.
 */

const SCRIPT = resolve(import.meta.dirname, "../../../../deploy/scripts/update-manifest.mjs");
const BASE = "https://github.com/devmello/psyche/releases/download/v1.4.0/";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function build(names: string[], extra: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "psyche-helper-manifest-"));
  dirs.push(dir);
  const files = names.map((n) => {
    const f = join(dir, n);
    writeFileSync(f, `${n} bytes`);
    return f;
  });
  return spawnSync(
    process.execPath,
    [SCRIPT, "build", "--release", "1.4.0", "--base", BASE, "--linux-only", ...extra, ...files],
    { encoding: "utf8" },
  );
}

const set = (arch: string) =>
  ["tar.zst", "deb", "rpm"].map((e) => `psyche-helper-1.4.0-linux-${arch}.${e}`);

describe("helper-only artifacts in the update manifest", () => {
  it("lists a complete set per architecture with the kinds the helper looks for", () => {
    const r = build([...set("x64"), ...set("arm64")], ["--helper-complete"]);
    expect(r.status, r.stderr).toBe(0);
    const m = JSON.parse(r.stdout);
    expect(m.artifacts).toEqual([]);
    for (const arch of ["x64", "arm64"]) {
      expect(m.platforms[`linux-${arch}`].map((a: { kind: string }) => a.kind)).toEqual([
        "helper-tar-zst",
        "helper-deb",
        "helper-rpm",
      ]);
    }
  });

  it("refuses a helper file whose version is not the release's", () => {
    for (const name of [
      "psyche-helper-1.3.9-linux-x64.tar.zst",
      "psyche-helper-1.4.0-rc.1-linux-x64.deb",
    ]) {
      const r = build([name]);
      expect(r.status, name).not.toBe(0);
      expect(r.stderr, name).toMatch(/the release is 1\.4\.0/);
    }
  });

  it("--helper-complete refuses a half set, in either architecture", () => {
    for (const drop of ["tar.zst", "deb", "rpm"]) {
      const names = [...set("x64"), ...set("arm64")].filter((n) => !n.endsWith(`arm64.${drop}`));
      const r = build(names, ["--helper-complete"]);
      expect(r.status, drop).not.toBe(0);
      expect(r.stderr, drop).toMatch(new RegExp(`arm64 lack the ${drop.replace(".", "\\.")}`));
    }
    // Without the flag a half set is still accepted (the older callers and tests).
    expect(build(["psyche-helper-1.4.0-linux-x64.deb"]).status).toBe(0);
  });

  it("a look-alike name is not a helper package", () => {
    const r = build(["psyche-helper-1.4.0-linux-x64.tar.gz"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/cannot classify/);
  });
});
