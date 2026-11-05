import { execFileSync } from "node:child_process";
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkForVerifiedUpdate } from "../../src/main/update-flow.ts";
import {
  keyIdOf,
  ManifestError,
  planUpdate,
  type ReleaseKey,
  verifyManifest,
} from "../../src/main/update-manifest.ts";

/**
 * Linux entries of the signed manifest: `platforms["linux-<arch>"]` holds an AppImage, a deb and an
 * rpm, and a copy takes the one that matches how it was installed. The macOS and Windows
 * behaviour is covered in update-manifest.test.ts, which this file does not touch.
 */

const SCRIPT = resolve(import.meta.dirname, "../../../../deploy/scripts/update-manifest.mjs");
const PINNED = "https://github.com/devmello/psyche/releases/download/";
const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "psyche-linux-update-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixtureKey(): { pem: string; key: ReleaseKey; priv: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(String(publicKey.export({ format: "jwk" }).x), "base64url");
  return {
    pem: String(privateKey.export({ format: "pem", type: "pkcs8" })),
    key: { keyId: keyIdOf(raw), publicKey: raw.toString("base64") },
    priv: privateKey,
  };
}

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return err instanceof ManifestError ? err.code : String(err);
  }
  return "no error";
};

/** A release dir built and signed by the real release script. */
function linuxRelease(
  version: string,
  pem: string,
  opts: { mac?: boolean; archs?: string[] } = {},
) {
  const dir = temp();
  const files: string[] = [];
  for (const arch of opts.archs ?? ["x64", "arm64"]) {
    for (const ext of ["AppImage", "deb", "rpm"]) {
      const f = join(dir, `Psyche-${version}-linux-${arch}.${ext}`);
      writeFileSync(f, Buffer.from(`${ext} ${arch} ${version}`.repeat(50)));
      files.push(f);
    }
  }
  if (opts.mac) {
    const zip = join(dir, `Psyche-${version}-darwin-arm64.zip`);
    writeFileSync(zip, Buffer.from(`zip ${version}`.repeat(50)));
    files.push(zip);
  }
  const manifest = execFileSync(
    process.execPath,
    [SCRIPT, "build", "--release", version, "--base", `${PINNED}v${version}/`, ...files],
    { encoding: "utf8" },
  );
  const file = join(dir, "update-manifest.json");
  writeFileSync(file, manifest);
  execFileSync(process.execPath, [SCRIPT, "sign", file], {
    env: { ...process.env, PSYCHE_RELEASE_SIGNING_KEY: pem },
  });
  return { dir, manifestBytes: readFileSync(file), sig: readFileSync(`${file}.sig`, "utf8"), file };
}

describe("the release script's Linux entries", () => {
  it("lists AppImage, deb and rpm per arch under platforms and leaves artifacts macOS-only", () => {
    const k = fixtureKey();
    const r = linuxRelease("1.2.0", k.pem, { mac: true });
    const m = JSON.parse(r.manifestBytes.toString("utf8"));
    expect(m.artifacts.map((a: { name: string }) => a.name)).toEqual([
      "Psyche-1.2.0-darwin-arm64.zip",
    ]);
    expect(Object.keys(m.platforms).sort()).toEqual(["darwin-arm64", "linux-arm64", "linux-x64"]);
    expect(m.platforms["linux-x64"].map((a: { kind: string }) => a.kind).sort()).toEqual([
      "appimage",
      "deb",
      "rpm",
    ]);
    expect(m.platforms["linux-x64"][0]).not.toHaveProperty("platform");
    const verified = verifyManifest(r.manifestBytes, r.sig, [k.key]);
    expect(verified.platforms?.["linux-arm64"]).toHaveLength(3);
  });

  it("builds a Linux-only manifest (no macOS zip) and still refuses a release with no update", () => {
    const k = fixtureKey();
    const r = linuxRelease("1.2.0", k.pem, { archs: ["x64"] });
    expect(JSON.parse(r.manifestBytes.toString("utf8")).artifacts).toEqual([]);
    expect(() =>
      execFileSync(
        process.execPath,
        [SCRIPT, "build", "--release", "1.2.0", "--base", `${PINNED}v1/`],
        {
          stdio: "pipe",
        },
      ),
    ).toThrow();
  });

  it("keeps a macOS-only manifest exactly as before (no platforms key)", () => {
    const dir = temp();
    const zip = join(dir, "Psyche-1.2.0-darwin-arm64.zip");
    writeFileSync(zip, "zip");
    const out = JSON.parse(
      execFileSync(
        process.execPath,
        [SCRIPT, "build", "--release", "1.2.0", "--base", `${PINNED}v1.2.0/`, zip],
        { encoding: "utf8" },
      ),
    );
    expect(out).not.toHaveProperty("platforms");
  });
});

describe("planUpdate on Linux", () => {
  const input = { currentVersion: "1.0.0", pinnedBase: PINNED, platform: "linux" as const };
  const manifest = () => {
    const k = fixtureKey();
    const r = linuxRelease("1.2.0", k.pem);
    return verifyManifest(r.manifestBytes, r.sig, [k.key]);
  };

  it("picks the artifact by arch and install kind, and nothing else", () => {
    const m = manifest();
    for (const arch of ["x64", "arm64"]) {
      for (const kind of ["appimage", "deb", "rpm"] as const) {
        const plan = planUpdate(m, { ...input, arch, installKind: kind });
        if (plan.action !== "update") throw new Error("expected an update");
        expect(plan.artifact).toMatchObject({ kind, arch, platform: "linux" });
        expect(plan.artifact.name).toBe(
          `Psyche-1.2.0-linux-${arch}.${kind === "appimage" ? "AppImage" : kind}`,
        );
        expect(plan.url).toBe(`${PINNED}v1.2.0/${plan.artifact.name}`);
        expect(plan.files).toHaveLength(1);
      }
    }
  });

  it("offers nothing without an install kind, or for an arch the release lacks", () => {
    const m = manifest();
    expect(code(() => planUpdate(m, { ...input, arch: "x64" }))).toBe("no_artifact");
    const k = fixtureKey();
    const r = linuxRelease("1.2.0", k.pem, { archs: ["x64"] });
    const onlyX64 = verifyManifest(r.manifestBytes, r.sig, [k.key]);
    expect(code(() => planUpdate(onlyX64, { ...input, arch: "arm64", installKind: "deb" }))).toBe(
      "no_artifact",
    );
  });

  it("refuses the same version and a downgrade, and an untrusted host", () => {
    const m = manifest();
    const at = { ...input, arch: "x64", installKind: "deb" as const };
    expect(planUpdate(m, { ...at, currentVersion: "1.2.0" })).toMatchObject({ action: "none" });
    expect(planUpdate(m, { ...at, currentVersion: "2.0.0" })).toMatchObject({ action: "none" });
    expect(code(() => planUpdate(m, { ...at, pinnedBase: "https://example.com/" }))).toBe(
      "untrusted_host",
    );
  });

  it("does not hand a Mac or a Windows machine the Linux files", () => {
    const k = fixtureKey();
    const r = linuxRelease("1.2.0", k.pem);
    const m = verifyManifest(r.manifestBytes, r.sig, [k.key]);
    const rest = {
      currentVersion: "1.0.0",
      pinnedBase: PINNED,
      arch: "x64",
      installKind: "deb" as const,
    };
    expect(code(() => planUpdate(m, { ...rest, platform: "darwin" }))).toBe("no_artifact");
    expect(code(() => planUpdate(m, { ...rest, platform: "win32" }))).toBe("no_artifact");
  });

  it("drops a mislabelled kind under a Linux key instead of refusing the manifest", () => {
    const k = fixtureKey();
    const bytes = Buffer.from(
      JSON.stringify({
        format: "psyche-update-manifest",
        version: 1,
        release: "2.0.0",
        minimumVersion: "0.0.0",
        publishedAt: "2026-11-05T00:00:00.000Z",
        baseUrl: `${PINNED}v2.0.0/`,
        artifacts: [],
        platforms: {
          "linux-x64": [
            { name: "a.zip", kind: "zip", sha256: "a".repeat(64), bytes: 1 },
            { name: "a.snap", kind: "snap", sha256: "a".repeat(64), bytes: 1 },
            { name: "a.deb", kind: "deb", sha256: "a".repeat(64), bytes: 1 },
          ],
        },
      }),
    );
    const env = JSON.stringify({
      alg: "ed25519",
      keyId: k.key.keyId,
      signature: sign(null, bytes, k.priv).toString("base64"),
    });
    const m = verifyManifest(bytes, env, [k.key]);
    expect(m.platforms?.["linux-x64"]?.map((a) => a.kind)).toEqual(["deb"]);
    const bad = Buffer.from(bytes.toString().replace('"a.deb"', '"../a.deb"'));
    const badEnv = JSON.stringify({
      alg: "ed25519",
      keyId: k.key.keyId,
      signature: sign(null, bad, k.priv).toString("base64"),
    });
    expect(code(() => verifyManifest(bad, badEnv, [k.key]))).toBe("malformed");
  });
});

describe("checkForVerifiedUpdate on Linux", () => {
  const base = { arch: "x64", currentVersion: "1.0.0", platform: "linux" as const, log: () => {} };

  function host(
    r: { dir: string; manifestBytes: Buffer; sig: string },
    swap?: Buffer,
  ): typeof fetch {
    return (async (input: string | URL) => {
      const url = String(input);
      const name = url.split("/").pop() ?? "";
      if (name === "update-manifest.json") return new Response(new Uint8Array(r.manifestBytes));
      if (name === "update-manifest.json.sig") return new Response(r.sig);
      if (/\.(AppImage|deb|rpm)$/.test(name)) {
        return new Response(new Uint8Array(swap ?? readFileSync(join(r.dir, name))));
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
  }

  it("downloads only the artifact for the install kind into a private folder", async () => {
    const k = fixtureKey();
    const r = linuxRelease("1.3.0", k.pem);
    const dir = join(temp(), "updates");
    const out = await checkForVerifiedUpdate({
      ...base,
      installKind: "deb",
      fetch: host(r),
      keys: [k.key],
      dir,
    });
    if (out.state !== "ready") throw new Error(`expected ready, got ${JSON.stringify(out)}`);
    expect(out.file).toBe(join(dir, "Psyche-1.3.0-linux-x64.deb"));
    expect(out.artifact).toMatchObject({ kind: "deb", arch: "x64" });
    expect(readFileSync(out.file)).toEqual(readFileSync(join(r.dir, "Psyche-1.3.0-linux-x64.deb")));
    if (process.platform !== "win32") {
      const { statSync } = await import("node:fs");
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
  });

  it("refuses a swapped download and leaves no file behind", async () => {
    const k = fixtureKey();
    const r = linuxRelease("1.3.0", k.pem);
    const dir = join(temp(), "updates");
    const out = await checkForVerifiedUpdate({
      ...base,
      installKind: "appimage",
      fetch: host(r, Buffer.from("not the release")),
      keys: [k.key],
      dir,
    });
    expect(out).toMatchObject({ state: "refused", code: "hash_mismatch" });
  });

  it("is a refusal, not a download, for an unknown install kind", async () => {
    const k = fixtureKey();
    const r = linuxRelease("1.3.0", k.pem);
    const out = await checkForVerifiedUpdate({
      ...base,
      fetch: host(r),
      keys: [k.key],
      dir: join(temp(), "updates"),
    });
    expect(out).toMatchObject({ state: "refused", code: "no_artifact" });
  });
});
