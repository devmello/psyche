import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type OrtRuntimeSpec, ortRuntimeState } from "@psyche/search";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureOrtRuntime, ortRuntimeDownloadBytes } from "../src/compose/ort-runtime.ts";

/**
 * The on-device search runtime downloads on first enable (docs/design/app-size-2026.md phase 2):
 * a fake release archive, a fake `fetch`, no network and no real onnxruntime.
 */

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

function fakeRelease(root: string): { bytes: Buffer; spec: OrtRuntimeSpec } {
  const member = "ort-1.30.0/lib/libonnxruntime.1.30.0.dylib";
  const lib = "fake-onnxruntime-dylib".repeat(100);
  mkdirSync(join(root, "rel/ort-1.30.0/lib"), { recursive: true });
  writeFileSync(join(root, "rel", member), lib);
  const archive = join(root, "ort.tgz");
  execFileSync("tar", ["-czf", archive, "-C", join(root, "rel"), "ort-1.30.0"]);
  const bytes = readFileSync(archive);
  return {
    bytes,
    spec: {
      version: "1.30.0",
      platform: "darwin-arm64",
      url: "https://example.test/ort.tgz",
      sha256: sha(bytes),
      sizeBytes: bytes.length,
      member,
      libSha256: sha(lib),
      libSizeBytes: lib.length,
      license: "MIT",
    },
  };
}

function fakePackage(root: string): string {
  const pkg = join(root, "node_modules/onnxruntime-node");
  mkdirSync(join(pkg, "dist"), { recursive: true });
  mkdirSync(join(pkg, "bin/napi-v6/darwin/arm64"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), '{"name":"onnxruntime-node"}');
  writeFileSync(join(pkg, "dist/index.js"), "");
  writeFileSync(join(pkg, "bin/napi-v6/darwin/arm64/onnxruntime_binding.node"), "binding");
  mkdirSync(join(root, "node_modules/onnxruntime-common"), { recursive: true });
  writeFileSync(
    join(root, "node_modules/onnxruntime-common/package.json"),
    '{"name":"onnxruntime-common","exports":{".":"./index.js"}}',
  );
  return pkg;
}

/** A `fetch` that serves `bytes` in 3 chunks (stopping with an AbortError once aborted) and counts its calls. */
function serving(bytes: Buffer) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(String(url));
    const third = Math.ceil(bytes.length / 3);
    const chunks = [
      bytes.subarray(0, third),
      bytes.subarray(third, 2 * third),
      bytes.subarray(2 * third),
    ];
    return new Response(
      new ReadableStream({
        pull(c) {
          if (init?.signal?.aborted) return c.error(new DOMException("aborted", "AbortError"));
          const next = chunks.shift();
          if (next === undefined) return c.close();
          c.enqueue(new Uint8Array(next));
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("ensureOrtRuntime", () => {
  let root: string;
  let home: string;
  let packageDir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "psyche-ort-gw-"));
    home = join(root, "home");
    packageDir = fakePackage(join(root, "app"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("downloads the pinned archive with progress, installs the library and deletes the archive", async () => {
    const { bytes, spec } = fakeRelease(root);
    const { calls, fetchImpl } = serving(bytes);
    const progress: [number, number][] = [];
    expect(ortRuntimeDownloadBytes({ home, spec, packageDir })).toBe(spec.sizeBytes);
    await ensureOrtRuntime({
      home,
      spec,
      packageDir,
      fetch: fetchImpl,
      onProgress: (r, t) => progress.push([r, t]),
    });
    expect(calls).toEqual([spec.url]);
    expect(progress.length).toBeGreaterThanOrEqual(3);
    expect(progress.at(-1)).toEqual([spec.sizeBytes, spec.sizeBytes]);
    expect(progress.map((p) => p[0])).toEqual([...progress.map((p) => p[0])].sort((a, b) => a - b));
    expect(ortRuntimeState({ home, spec, packageDir })).toBe("installed");
    expect(ortRuntimeDownloadBytes({ home, spec, packageDir })).toBe(0);
    expect(existsSync(join(home, "models/runtimes/onnxruntime-1.30.0-darwin-arm64.tgz"))).toBe(
      false,
    );
    expect(readdirSync(join(home, "runtimes"))).toEqual(["onnxruntime-1.30.0-darwin-arm64"]);
  });

  it("downloads nothing a second time", async () => {
    const { bytes, spec } = fakeRelease(root);
    const { calls, fetchImpl } = serving(bytes);
    await ensureOrtRuntime({ home, spec, packageDir, fetch: fetchImpl });
    await ensureOrtRuntime({ home, spec, packageDir, fetch: fetchImpl });
    expect(calls).toHaveLength(1);
  });

  it("downloads nothing where the build has no download for the platform", async () => {
    const { bytes } = fakeRelease(root);
    const { calls, fetchImpl } = serving(bytes);
    await ensureOrtRuntime({ home, spec: undefined, packageDir, fetch: fetchImpl });
    expect(calls).toEqual([]);
    expect(ortRuntimeDownloadBytes({ home, spec: undefined, packageDir })).toBe(0);
  });

  it("rejects an archive that does not match its pinned checksum and installs nothing", async () => {
    const { bytes, spec } = fakeRelease(root);
    const tampered = Buffer.from(bytes);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] as number) ^ 0xff;
    const { fetchImpl } = serving(tampered);
    await expect(ensureOrtRuntime({ home, spec, packageDir, fetch: fetchImpl })).rejects.toThrow(
      /checksum mismatch/,
    );
    expect(ortRuntimeState({ home, spec, packageDir })).toBe("missing");
    expect(existsSync(join(home, "runtimes"))).toBe(false);
    expect(existsSync(join(home, "models/runtimes/onnxruntime-1.30.0-darwin-arm64.tgz.part"))).toBe(
      false,
    );
  });

  it("fails retryably offline and leaves the runtime missing", async () => {
    const { spec } = fakeRelease(root);
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(
      ensureOrtRuntime({ home, spec, packageDir, fetch: offline }),
    ).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(ortRuntimeState({ home, spec, packageDir })).toBe("missing");
  });

  it("stops when the download is cancelled", async () => {
    const { bytes, spec } = fakeRelease(root);
    const { fetchImpl } = serving(bytes);
    const abort = new AbortController();
    await expect(
      ensureOrtRuntime({
        home,
        spec,
        packageDir,
        fetch: fetchImpl,
        signal: abort.signal,
        onProgress: () => abort.abort(),
      }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(ortRuntimeState({ home, spec, packageDir })).toBe("missing");
  });
});
