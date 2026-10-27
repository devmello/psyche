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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  installOrtRuntime,
  loadOrt,
  OrtRuntimeMissingError,
  type OrtRuntimeSpec,
  ortRuntimeDir,
  ortRuntimeSpec,
  ortRuntimeState,
} from "../src/ort-runtime.ts";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** A fake release archive with the member the spec names, and a spec that pins it. */
function fakeRelease(
  root: string,
  lib = "fake-onnxruntime-dylib",
): { archive: string; spec: OrtRuntimeSpec } {
  const member = "ort-1.30.0/lib/libonnxruntime.1.30.0.dylib";
  mkdirSync(join(root, "rel/ort-1.30.0/lib"), { recursive: true });
  writeFileSync(join(root, "rel", member), lib);
  writeFileSync(join(root, "rel/ort-1.30.0/LICENSE"), "MIT");
  const archive = join(root, "ort.tgz");
  execFileSync("tar", ["-czf", archive, "-C", join(root, "rel"), "ort-1.30.0"]);
  const bytes = readFileSync(archive);
  return {
    archive,
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

/** A fake npm install: `onnxruntime-node` (JS, a binding, other platforms' folders) and `onnxruntime-common`. */
function fakePackage(root: string, withLibrary = false): string {
  const pkg = join(root, "node_modules/onnxruntime-node");
  const mk = (p: string, text: string) => {
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, text);
  };
  mk(join(pkg, "package.json"), '{"name":"onnxruntime-node","version":"1.30.0"}');
  mk(
    join(pkg, "dist/index.js"),
    "exports.InferenceSession = class {}; exports.marker = 'from-runtime-dir';",
  );
  for (const p of ["darwin/arm64", "darwin/x64", "linux/x64", "win32/x64"])
    mk(join(pkg, "bin/napi-v6", p, "onnxruntime_binding.node"), `binding-${p}`);
  if (withLibrary) mk(join(pkg, "bin/napi-v6/darwin/arm64/libonnxruntime.1.dylib"), "lib");
  mk(join(root, "node_modules/onnxruntime-common/package.json"), '{"name":"onnxruntime-common"}');
  return pkg;
}

describe("on-device search runtime (onnxruntime library as a download)", () => {
  let root: string;
  let home: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "psyche-ort-"));
    home = join(root, "home");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("downloads only on Apple silicon", () => {
    expect(ortRuntimeSpec("darwin", "arm64")?.version).toBe("1.30.0");
    expect(ortRuntimeSpec("darwin", "x64")).toBeUndefined();
    expect(ortRuntimeSpec("linux", "x64")).toBeUndefined();
    expect(ortRuntimeSpec("win32", "x64")).toBeUndefined();
  });

  it("pins an HTTPS release and two SHA-256 digests", () => {
    const spec = ortRuntimeSpec("darwin", "arm64") as OrtRuntimeSpec;
    expect(spec.url).toMatch(
      /^https:\/\/github\.com\/microsoft\/onnxruntime\/releases\/download\//,
    );
    expect(spec.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(spec.libSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is bundled when the package carries its library, missing when not, installed after the install", async () => {
    const { archive, spec } = fakeRelease(root);
    const bare = fakePackage(join(root, "bare"));
    const full = fakePackage(join(root, "full"), true);
    expect(ortRuntimeState({ home, spec, packageDir: full })).toBe("bundled");
    // process.platform/arch decide what "carries its library" means; off Apple silicon the
    // fixture's darwin-arm64 folder is not looked at, so only assert the missing/installed path there.
    if (process.platform !== "darwin" || process.arch !== "arm64") return;
    expect(ortRuntimeState({ home, spec, packageDir: bare })).toBe("missing");
    await installOrtRuntime(archive, { home, spec, packageDir: bare });
    expect(ortRuntimeState({ home, spec, packageDir: bare })).toBe("installed");
  });

  it("lays out the package with the downloaded library next to the binding", async () => {
    const { archive, spec } = fakeRelease(root);
    const pkg = fakePackage(join(root, "app"));
    const dir = await installOrtRuntime(archive, { home, spec, packageDir: pkg });
    expect(dir).toBe(ortRuntimeDir(spec, { home }));
    const native = join(dir, "node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64");
    expect(readdirSync(native).sort()).toEqual([
      "libonnxruntime.1.dylib",
      "onnxruntime_binding.node",
    ]);
    expect(readFileSync(join(native, "libonnxruntime.1.dylib"), "utf8")).toBe(
      "fake-onnxruntime-dylib",
    );
    expect(readFileSync(join(native, "onnxruntime_binding.node"), "utf8")).toBe(
      "binding-darwin/arm64",
    );
    // Other platforms' folders stay out, and the common package comes along.
    expect(readdirSync(join(dir, "node_modules/onnxruntime-node/bin/napi-v6"))).toEqual(["darwin"]);
    expect(existsSync(join(dir, "node_modules/onnxruntime-common/package.json"))).toBe(true);
    expect(readdirSync(join(home, "runtimes"))).toEqual([`onnxruntime-1.30.0-darwin-arm64`]);
  });

  it("refuses a library that does not match its pinned hash and leaves nothing behind", async () => {
    const { archive, spec } = fakeRelease(root);
    const pkg = fakePackage(join(root, "app"));
    await expect(
      installOrtRuntime(archive, {
        home,
        spec: { ...spec, libSha256: sha("something else") },
        packageDir: pkg,
      }),
    ).rejects.toThrow(/checksum mismatch/);
    expect(existsSync(join(home, "runtimes")) ? readdirSync(join(home, "runtimes")) : []).toEqual(
      [],
    );
  });

  it("loads the downloaded copy, and says so when there is none", async () => {
    const { archive, spec } = fakeRelease(root);
    const pkg = fakePackage(join(root, "app"));
    await expect(loadOrt({ home, spec, packageDir: pkg })).rejects.toBeInstanceOf(
      OrtRuntimeMissingError,
    );
    await installOrtRuntime(archive, { home, spec, packageDir: pkg });
    const ort = (await loadOrt({ home, spec, packageDir: pkg })) as unknown as { marker: string };
    expect(ort.marker).toBe("from-runtime-dir");
  });
});
