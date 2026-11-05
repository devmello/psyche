import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkForVerifiedUpdate,
  parseSquirrelReleases,
  serveVerifiedUpdate,
  squirrelReleasesFor,
  switchToFullPackage,
  writeUpdaterState,
} from "../../src/main/update-flow.ts";
import {
  artifactsFor,
  compareVersions,
  keyIdOf,
  ManifestError,
  planUpdate,
  type ReleaseKey,
  verifyArtifact,
  verifyManifest,
} from "../../src/main/update-manifest.ts";

/**
 * Signed update manifests (security §11) with a fixture release key generated per run (a committed
 * private key would trip the secret scanners). The release script signs; the desktop verifies.
 */

const SCRIPT = resolve(import.meta.dirname, "../../../../deploy/scripts/update-manifest.mjs");
const PINNED = "https://github.com/devmello/psyche/releases/download/";
const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "psyche-update-"));
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

/** A release dir signed by the real release script: manifest, .sig and a zip. */
function release(version: string, pem: string, opts: { minimum?: string; base?: string } = {}) {
  const dir = temp();
  const zip = join(dir, `Psyche-${version}-darwin-arm64.zip`);
  writeFileSync(zip, Buffer.from(`zip bytes of ${version}`.repeat(100)));
  const base = opts.base ?? `${PINNED}v${version}/`;
  const manifest = execFileSync(
    process.execPath,
    [
      SCRIPT,
      "build",
      "--release",
      version,
      "--base",
      base,
      ...(opts.minimum ? ["--minimum", opts.minimum] : []),
      zip,
    ],
    { encoding: "utf8" },
  );
  const file = join(dir, "update-manifest.json");
  writeFileSync(file, manifest);
  execFileSync(process.execPath, [SCRIPT, "sign", file], {
    env: { ...process.env, PSYCHE_RELEASE_SIGNING_KEY: pem },
  });
  return { dir, zip, manifestBytes: readFileSync(file), sig: readFileSync(`${file}.sig`, "utf8") };
}

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return err instanceof ManifestError ? err.code : String(err);
  }
  return "no error";
};

describe("verifyManifest", () => {
  it("accepts the release script's signature with the embedded key", () => {
    const k = fixtureKey();
    const r = release("1.2.3", k.pem);
    const m = verifyManifest(r.manifestBytes, r.sig, [k.key]);
    expect(m).toMatchObject({
      release: "1.2.3",
      minimumVersion: "0.0.0",
      baseUrl: `${PINNED}v1.2.3/`,
    });
    expect(m.artifacts).toEqual([
      expect.objectContaining({
        name: "Psyche-1.2.3-darwin-arm64.zip",
        arch: "arm64",
        kind: "zip",
      }),
    ]);
  });

  it("refuses unsigned, unknown-key, tampered and malformed manifests", () => {
    const k = fixtureKey();
    const r = release("1.2.3", k.pem);
    expect(code(() => verifyManifest(r.manifestBytes, null, [k.key]))).toBe("unsigned");
    expect(code(() => verifyManifest(r.manifestBytes, "not json", [k.key]))).toBe("unsigned");
    expect(code(() => verifyManifest(r.manifestBytes, r.sig, [fixtureKey().key]))).toBe(
      "unknown_key",
    );
    const tampered = Buffer.from(r.manifestBytes.toString("utf8").replace('"1.2.3"', '"9.9.9"'));
    expect(code(() => verifyManifest(tampered, r.sig, [k.key]))).toBe("bad_signature");
    // A key id that matches but a signature from another key.
    const other = fixtureKey();
    const forged = JSON.stringify({
      alg: "ed25519",
      keyId: k.key.keyId,
      signature: sign(null, r.manifestBytes, other.priv).toString("base64"),
    });
    expect(code(() => verifyManifest(r.manifestBytes, forged, [k.key]))).toBe("bad_signature");
    // Correctly signed garbage is still refused.
    const junk = Buffer.from(JSON.stringify({ format: "psyche-update-manifest", version: 1 }));
    const junkSig = JSON.stringify({
      alg: "ed25519",
      keyId: k.key.keyId,
      signature: sign(null, junk, k.priv).toString("base64"),
    });
    expect(code(() => verifyManifest(junk, junkSig, [k.key]))).toBe("malformed");
    // No key embedded: nothing verifies.
    expect(code(() => verifyManifest(r.manifestBytes, r.sig, []))).toBe("unknown_key");
  });
});

describe("planUpdate", () => {
  const k = fixtureKey();
  const m = (v: string, o: { minimum?: string; base?: string } = {}) => {
    const r = release(v, k.pem, o);
    return verifyManifest(r.manifestBytes, r.sig, [k.key]);
  };

  it("updates only to a newer version, from the pinned host, for this arch", () => {
    const plan = planUpdate(m("1.2.3"), {
      currentVersion: "1.2.0",
      arch: "arm64",
      pinnedBase: PINNED,
    });
    expect(plan).toMatchObject({ action: "update", release: "1.2.3", mandatory: false });
    expect(plan.action === "update" && plan.url).toBe(
      `${PINNED}v1.2.3/Psyche-1.2.3-darwin-arm64.zip`,
    );
    expect(
      planUpdate(m("1.2.3"), { currentVersion: "1.2.3", arch: "arm64", pinnedBase: PINNED }),
    ).toMatchObject({ action: "none" });
    expect(
      planUpdate(m("1.2.3"), { currentVersion: "2.0.0", arch: "arm64", pinnedBase: PINNED }),
    ).toMatchObject({ action: "none" });
    expect(
      code(() =>
        planUpdate(m("1.2.3"), { currentVersion: "1.0.0", arch: "x64", pinnedBase: PINNED }),
      ),
    ).toBe("no_artifact");
    expect(
      code(() =>
        planUpdate(m("1.2.3", { base: "https://evil.example/v1.2.3/" }), {
          currentVersion: "1.0.0",
          arch: "arm64",
          pinnedBase: PINNED,
        }),
      ),
    ).toBe("untrusted_host");
  });

  it("marks an update mandatory below the minimum version", () => {
    expect(
      planUpdate(m("1.3.0", { minimum: "1.2.0" }), {
        currentVersion: "1.1.9",
        arch: "arm64",
        pinnedBase: PINNED,
      }),
    ).toMatchObject({
      action: "update",
      mandatory: true,
    });
  });

  it("orders versions by semver, prereleases below releases", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.0.0-rc.2", "1.0.0-rc.10")).toBe(-1);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });
});

describe("verifyArtifact", () => {
  it("refuses a zip whose bytes or size differ from the manifest", () => {
    const bytes = Buffer.from("zip");
    const a = {
      name: "Psyche-1.0.0-darwin-arm64.zip",
      platform: "darwin" as const,
      arch: "arm64" as const,
      kind: "zip" as const,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: 3,
    };
    expect(() => verifyArtifact(bytes, a)).not.toThrow();
    expect(code(() => verifyArtifact(Buffer.from("zap"), a))).toBe("hash_mismatch");
    expect(code(() => verifyArtifact(Buffer.from("zips"), a))).toBe("hash_mismatch");
  });
});

describe("checkForVerifiedUpdate and the loopback feed", () => {
  /** A fake release host: maps URLs to files, optionally swapping the zip. */
  function host(
    r: { dir: string; zip: string; manifestBytes: Buffer; sig: string },
    swapZip?: Buffer,
  ): typeof fetch {
    return (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/update-manifest.json"))
        return new Response(new Uint8Array(r.manifestBytes));
      if (url.endsWith("/update-manifest.json.sig")) return new Response(r.sig);
      if (url.endsWith(".zip")) return new Response(new Uint8Array(swapZip ?? readFileSync(r.zip)));
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
  }
  const base = { arch: "arm64", currentVersion: "1.0.0", log: () => {} };

  it("downloads and verifies, then serves exactly that file to Squirrel", async () => {
    const k = fixtureKey();
    const r = release("1.2.3", k.pem);
    const out = await checkForVerifiedUpdate({
      ...base,
      fetch: host(r),
      keys: [k.key],
      dir: temp(),
    });
    expect(out).toMatchObject({ state: "ready", release: "1.2.3", mandatory: false });
    if (out.state !== "ready") return;
    expect(readFileSync(out.file)).toEqual(readFileSync(r.zip));

    const served = await serveVerifiedUpdate(out.file, out.release);
    try {
      const feed = (await (await fetch(served.feedUrl)).json()) as { url: string; name: string };
      expect(feed.name).toBe("1.2.3");
      expect(feed.url.startsWith("http://127.0.0.1:")).toBe(true);
      expect(Buffer.from(await (await fetch(feed.url)).arrayBuffer())).toEqual(readFileSync(r.zip));
      const guess = new URL(served.feedUrl);
      expect((await fetch(`${guess.origin}/feed`)).status).toBe(404);
    } finally {
      await served.close();
    }
  });

  it("refuses a swapped download and leaves nothing behind", async () => {
    const k = fixtureKey();
    const r = release("1.2.3", k.pem);
    const dir = temp();
    const evil = Buffer.alloc(readFileSync(r.zip).length, 0x41);
    const out = await checkForVerifiedUpdate({ ...base, fetch: host(r, evil), keys: [k.key], dir });
    expect(out).toMatchObject({ state: "refused", code: "hash_mismatch" });
    expect(existsSync(join(dir, "Psyche-1.2.3-darwin-arm64.zip"))).toBe(false);
  });

  it("refuses an unsigned or foreign-signed manifest, a feed off the pinned host, and stays off without keys", async () => {
    const k = fixtureKey();
    const r = release("1.2.3", k.pem);
    expect(
      await checkForVerifiedUpdate({
        ...base,
        fetch: host({ ...r, sig: "" }),
        keys: [k.key],
        dir: temp(),
      }),
    ).toMatchObject({
      state: "refused",
      code: "unsigned",
    });
    expect(
      await checkForVerifiedUpdate({
        ...base,
        fetch: host(r),
        keys: [fixtureKey().key],
        dir: temp(),
      }),
    ).toMatchObject({
      state: "refused",
      code: "unknown_key",
    });
    expect(
      await checkForVerifiedUpdate({
        ...base,
        fetch: host(r),
        keys: [k.key],
        dir: temp(),
        feed: "https://evil.example/releases/",
      }),
    ).toMatchObject({ state: "refused", code: "untrusted_host" });
    expect(
      await checkForVerifiedUpdate({ ...base, fetch: host(r), keys: [], dir: temp() }),
    ).toEqual({ state: "no_keys" });
  });

  it("looks at the download for a quarantine flag and reports what it found", async () => {
    const k = fixtureKey();
    const r = release("1.2.3", k.pem);
    const seen: string[] = [];
    const logs: string[] = [];
    const out = await checkForVerifiedUpdate({
      ...base,
      log: (m) => logs.push(m),
      fetch: host(r),
      keys: [k.key],
      dir: temp(),
      inspectDownload: async (file) => {
        seen.push(file);
        return "removed";
      },
    });
    expect(out).toMatchObject({ state: "ready", quarantine: "removed" });
    if (out.state === "ready") expect(seen).toEqual([out.file]);
    expect(logs.join("\n")).toMatch(/com\.apple\.quarantine/);
  });

  it("does nothing when already on the latest version", async () => {
    const k = fixtureKey();
    const r = release("1.2.3", k.pem);
    expect(
      await checkForVerifiedUpdate({
        ...base,
        currentVersion: "1.2.3",
        fetch: host(r),
        keys: [k.key],
        dir: temp(),
      }),
    ).toMatchObject({ state: "none" });
  });
});

describe("updater state file (read by psyche security audit)", () => {
  it("writes the result to $PSYCHE_HOME/run/updater.json, 0600, without keys or secrets", () => {
    const file = join(temp(), "run", "updater.json");
    writeUpdaterState(file, {
      state: "refused",
      appVersion: "1.0.0",
      keys: 1,
      checkedAt: "2026-10-20T00:00:00.000Z",
      code: "bad_signature",
      reason: "manifest signature does not match",
    });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      version: 1,
      state: "refused",
      appVersion: "1.0.0",
      keys: 1,
      checkedAt: "2026-10-20T00:00:00.000Z",
      code: "bad_signature",
      reason: "manifest signature does not match",
    });
    // Windows keeps the file private through the profile folder ACLs (no POSIX modes).
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

/**
 * Windows: a release with the macOS zip and the Squirrel.Windows files, built and signed by the
 * real release script. RELEASES is what electron-winstaller writes (BOM, SHA-1, name, size).
 */
function winRelease(
  version: string,
  pem: string,
  opts: { deltaBase?: string; tamperReleases?: boolean; macZip?: boolean } = {},
) {
  const dir = temp();
  const nuget = version.replace(
    /^(\d+\.\d+\.\d+)-(.*)$/,
    (_m, v, pre) => `${v}-${pre.replace(/\./g, "")}`,
  );
  const full = join(dir, `Psyche-${nuget}-full.nupkg`);
  const delta = join(dir, `Psyche-${nuget}-delta.nupkg`);
  writeFileSync(full, Buffer.from(`full nupkg ${version}`.repeat(200)));
  writeFileSync(delta, Buffer.from(`delta nupkg ${version}`.repeat(20)));
  const line = (file: string) => {
    const b = readFileSync(file);
    const sha1 = createHash("sha1").update(b).digest("hex").toUpperCase();
    return `${opts.tamperReleases ? "0".repeat(40) : sha1} ${file.split(/[\\/]/).pop()} ${b.length}`;
  };
  const releases = join(dir, "RELEASES");
  writeFileSync(releases, `\uFEFF${line(full)}\r\n${line(delta)}`);
  const setup = join(dir, `Psyche-${version}-Setup.exe`);
  writeFileSync(setup, "MZ setup");
  const files = [releases, full, delta, setup];
  if (opts.macZip !== false) {
    const zip = join(dir, `Psyche-${version}-darwin-arm64.zip`);
    writeFileSync(zip, Buffer.from(`zip bytes of ${version}`.repeat(100)));
    files.push(zip);
  }
  const manifest = execFileSync(
    process.execPath,
    [
      SCRIPT,
      "build",
      "--release",
      version,
      "--base",
      `${PINNED}v${version}/`,
      ...(opts.deltaBase ? ["--delta-base", opts.deltaBase] : []),
      ...files,
    ],
    { encoding: "utf8" },
  );
  const file = join(dir, "update-manifest.json");
  writeFileSync(file, manifest);
  execFileSync(process.execPath, [SCRIPT, "sign", file], {
    env: { ...process.env, PSYCHE_RELEASE_SIGNING_KEY: pem },
  });
  return {
    dir,
    full,
    delta,
    releases,
    manifestBytes: readFileSync(file),
    sig: readFileSync(`${file}.sig`, "utf8"),
  };
}

describe("per-platform manifests (Windows)", () => {
  it("keeps macOS-only artifacts where released Mac builds look, and lists every platform", () => {
    const k = fixtureKey();
    const r = winRelease("1.3.0", k.pem, { deltaBase: "1.2.0" });
    const raw = JSON.parse(r.manifestBytes.toString("utf8"));
    // What a Mac build from before Windows support accepts: every `artifacts` entry is darwin.
    expect(
      raw.artifacts.map((a: { platform: string; kind: string }) => [a.platform, a.kind]),
    ).toEqual([["darwin", "zip"]]);
    expect(Object.keys(raw.platforms).sort()).toEqual(["darwin-arm64", "win32-x64"]);
    expect(raw.platforms["win32-x64"].map((a: { kind: string }) => a.kind)).toEqual([
      "squirrel-releases",
      "nupkg-full",
      "nupkg-delta",
      "setup",
    ]);
    expect(raw.platforms["win32-x64"][2].baseVersion).toBe("1.2.0");
    const m = verifyManifest(r.manifestBytes, r.sig, [k.key]);
    expect(artifactsFor(m, "darwin", "arm64").map((a) => a.kind)).toEqual(["zip"]);
    expect(
      planUpdate(m, { currentVersion: "1.2.0", arch: "arm64", pinnedBase: PINNED }),
    ).toMatchObject({ action: "update", url: `${PINNED}v1.3.0/Psyche-1.3.0-darwin-arm64.zip` });
  });

  it("a darwin-only build is unchanged: no platforms key, the legacy list still plans", () => {
    const k = fixtureKey();
    const r = release("1.2.3", k.pem);
    expect(JSON.parse(r.manifestBytes.toString("utf8")).platforms).toBeUndefined();
    const m = verifyManifest(r.manifestBytes, r.sig, [k.key]);
    expect(
      code(() =>
        planUpdate(m, {
          currentVersion: "1.0.0",
          arch: "x64",
          platform: "win32",
          pinnedBase: PINNED,
        }),
      ),
    ).toBe("no_artifact");
  });

  it("plans RELEASES + the full nupkg on Windows, or the delta for the version it was made from", () => {
    const k = fixtureKey();
    const r = winRelease("1.3.0-beta.1", k.pem, { deltaBase: "1.2.0" });
    const m = verifyManifest(r.manifestBytes, r.sig, [k.key]);
    const win = { arch: "x64", platform: "win32" as const, pinnedBase: PINNED };
    const fromOld = planUpdate(m, { ...win, currentVersion: "1.1.0" });
    if (fromOld.action !== "update") throw new Error("expected an update");
    expect(fromOld.files.map((f) => f.artifact.name)).toEqual([
      "RELEASES",
      "Psyche-1.3.0-beta1-full.nupkg",
    ]);
    expect(fromOld.full).toBeUndefined();
    const fromBase = planUpdate(m, { ...win, currentVersion: "1.2.0" });
    if (fromBase.action !== "update") throw new Error("expected an update");
    expect(fromBase.artifact.kind).toBe("nupkg-delta");
    expect(fromBase.full?.artifact.kind).toBe("nupkg-full");
    expect(planUpdate(m, { ...win, currentVersion: "1.3.0" })).toMatchObject({ action: "none" });
    expect(code(() => planUpdate(m, { ...win, arch: "arm64", currentVersion: "1.0.0" }))).toBe(
      "no_artifact",
    );
  });

  it("skips unknown platforms and kinds, refuses a malformed entry under a known one", () => {
    const k = fixtureKey();
    const signed = (body: object) => {
      const bytes = Buffer.from(JSON.stringify(body));
      const env = JSON.stringify({
        alg: "ed25519",
        keyId: k.key.keyId,
        signature: sign(null, bytes, k.priv).toString("base64"),
      });
      return () => verifyManifest(bytes, env, [k.key]);
    };
    const base = {
      format: "psyche-update-manifest",
      version: 1,
      release: "2.0.0",
      minimumVersion: "0.0.0",
      publishedAt: "2026-11-05T00:00:00.000Z",
      baseUrl: `${PINNED}v2.0.0/`,
      artifacts: [],
    };
    const art = { name: "RELEASES", kind: "squirrel-releases", sha256: "a".repeat(64), bytes: 1 };
    const m = signed({
      ...base,
      platforms: {
        "freebsd-x64": [{ anything: true }],
        "win32-x64": [art, { ...art, name: "x.msix", kind: "msix" }],
      },
    })();
    expect(m.platforms).toEqual({ "win32-x64": [art] });
    expect(
      code(signed({ ...base, platforms: { "win32-x64": [{ ...art, name: "../evil" }] } })),
    ).toBe("malformed");
    expect(
      code(signed({ ...base, platforms: { "win32-x64": [{ ...art, sha256: "nope" }] } })),
    ).toBe("malformed");
    expect(code(signed({ ...base, platforms: [] }))).toBe("malformed");
  });

  /** A fake release host for the Windows files. */
  function winHost(r: ReturnType<typeof winRelease>, swap?: Record<string, Buffer>): typeof fetch {
    return (async (input: string | URL) => {
      const url = String(input);
      const name = url.split("/").pop() ?? "";
      if (name === "update-manifest.json") return new Response(new Uint8Array(r.manifestBytes));
      if (name === "update-manifest.json.sig") return new Response(r.sig);
      const file = join(r.dir, name);
      if (swap?.[name]) return new Response(new Uint8Array(swap[name]));
      if (existsSync(file)) return new Response(new Uint8Array(readFileSync(file)));
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
  }
  const win = { arch: "x64", platform: "win32" as const, log: () => {} };

  it("hands Squirrel.Windows a local feed: verified nupkg and RELEASES cut to its line", async () => {
    const k = fixtureKey();
    const r = winRelease("1.3.0", k.pem, { macZip: false });
    const out = await checkForVerifiedUpdate({
      ...win,
      currentVersion: "1.2.0",
      fetch: winHost(r),
      keys: [k.key],
      dir: temp(),
    });
    expect(out).toMatchObject({ state: "ready", release: "1.3.0" });
    if (out.state !== "ready" || !out.feedDir) throw new Error("expected a feed");
    expect(readFileSync(out.file)).toEqual(readFileSync(r.full));
    const lines = parseSquirrelReleases(readFileSync(join(out.feedDir, "RELEASES"), "utf8"));
    expect(lines.map((l) => l.name)).toEqual(["Psyche-1.3.0-full.nupkg"]);
    expect(lines[0]?.bytes).toBe(readFileSync(r.full).length);
  });

  it("refuses a nupkg or a RELEASES that does not match, and leaves no feed behind", async () => {
    const k = fixtureKey();
    const r = winRelease("1.3.0", k.pem, { macZip: false });
    const dir = temp();
    const evil = Buffer.alloc(readFileSync(r.full).length, 0x41);
    expect(
      await checkForVerifiedUpdate({
        ...win,
        currentVersion: "1.2.0",
        fetch: winHost(r, { "Psyche-1.3.0-full.nupkg": evil }),
        keys: [k.key],
        dir,
      }),
    ).toMatchObject({ state: "refused", code: "hash_mismatch" });
    expect(existsSync(join(dir, "feed-1.3.0"))).toBe(false);
    // RELEASES itself is in the signed manifest, so a RELEASES that names other bytes was signed
    // that way: still refused, because Update.exe would refuse the package.
    const bad = winRelease("1.3.0", k.pem, { macZip: false, tamperReleases: true });
    expect(
      await checkForVerifiedUpdate({
        ...win,
        currentVersion: "1.2.0",
        fetch: winHost(bad),
        keys: [k.key],
        dir: temp(),
      }),
    ).toMatchObject({ state: "refused", code: "hash_mismatch" });
  });

  it("takes the delta for its base version and falls back to the verified full package", async () => {
    const k = fixtureKey();
    const r = winRelease("1.3.0", k.pem, { deltaBase: "1.2.0", macZip: false });
    const out = await checkForVerifiedUpdate({
      ...win,
      currentVersion: "1.2.0",
      fetch: winHost(r),
      keys: [k.key],
      dir: temp(),
    });
    if (out.state !== "ready" || !out.feedDir || !out.full) throw new Error("expected a delta");
    expect(readFileSync(out.file)).toEqual(readFileSync(r.delta));
    // Squirrel needs the full package's line even when it applies the delta.
    expect(
      parseSquirrelReleases(readFileSync(join(out.feedDir, "RELEASES"), "utf8")).map((l) => l.name),
    ).toEqual(["Psyche-1.3.0-delta.nupkg", "Psyche-1.3.0-full.nupkg"]);
    const feed = await switchToFullPackage(
      { fetch: winHost(r), log: () => {} },
      { feedDir: out.feedDir, full: out.full },
    );
    expect(readFileSync(join(feed, "Psyche-1.3.0-full.nupkg"))).toEqual(readFileSync(r.full));
    expect(
      parseSquirrelReleases(readFileSync(join(feed, "RELEASES"), "utf8")).map((l) => l.name),
    ).toEqual(["Psyche-1.3.0-full.nupkg"]);
  });

  it("parses RELEASES strictly", () => {
    expect(() => parseSquirrelReleases("not a line")).toThrow(/malformed/);
    expect(() => squirrelReleasesFor("", ["Psyche-1.0.0-full.nupkg"], [])).toThrow(/does not list/);
  });
});
