import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkForVerifiedUpdate, serveVerifiedUpdate } from "../../src/main/update-flow.ts";
import {
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
