import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { chmod, cp, mkdir, readFile, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * The on-device search runtime as a download (docs/design/app-size-2026.md, phase 2).
 *
 * `onnxruntime-node` is two parts: ~0.5 MB of JS and a napi binding, and the 44 MB native library
 * `libonnxruntime`. Psyche.app for Apple silicon ships the first and not the second; turning on
 * Settings → Search → Semantic (on-device) downloads Microsoft's pinned release of the library,
 * checks its SHA-256, and lays the package out under `$PSYCHE_HOME/runtimes/` where the binding finds
 * the library next to itself. Lexical search never loads any of this.
 *
 * The runtime comes from, in order: the installed package when its library is present (Docker,
 * Linux, a dev checkout, the Intel app), then the downloaded copy.
 */

export interface OrtRuntimeSpec {
  /** onnxruntime-node's version: the C library must match the binding's. */
  version: string;
  /** `darwin-arm64`: the one platform that downloads. */
  platform: string;
  /** Microsoft's release archive, pinned. */
  url: string;
  sha256: string;
  sizeBytes: number;
  /** The library inside the archive, and what it must hash to once extracted. */
  member: string;
  libSha256: string;
  libSizeBytes: number;
  license: string;
}

export const ORT_RUNTIME_DARWIN_ARM64: OrtRuntimeSpec = {
  version: "1.30.0",
  platform: "darwin-arm64",
  url: "https://github.com/microsoft/onnxruntime/releases/download/v1.30.0/onnxruntime-osx-arm64-1.30.0.tgz",
  sha256: "6ebb5062a934537c352937821f9fe9718e7de1a2db1122a93dd363ffd53a7012",
  sizeBytes: 42_373_116,
  member: "onnxruntime-osx-arm64-1.30.0/lib/libonnxruntime.1.30.0.dylib",
  libSha256: "bcc9110f9d638a119de2db7afb3ba9a1da8085f0cb3401e1c48ae1caf450b6fa",
  libSizeBytes: 43_879_424,
  license: "MIT",
};

/** The download for this machine, or undefined where the library ships inside the package. */
export function ortRuntimeSpec(
  platform: string = process.platform,
  arch: string = process.arch,
): OrtRuntimeSpec | undefined {
  return platform === "darwin" && arch === "arm64" ? ORT_RUNTIME_DARWIN_ARM64 : undefined;
}

/** `bundled`: the package carries its library. `installed`: downloaded earlier. `missing`: download it. */
export type OrtRuntimeState = "bundled" | "installed" | "missing";

export interface OrtRuntimeOptions {
  /** `$PSYCHE_HOME`; defaults to the env var, then `~/.psyche`. */
  home?: string;
  spec?: OrtRuntimeSpec | undefined;
  /** Directory of the installed `onnxruntime-node` package (tests point this at a fixture). */
  packageDir?: string;
}

const LIB = /^(lib)?onnxruntime(\.|$)/;
const LIB_NAME = "libonnxruntime.1.dylib";

function home(options: OrtRuntimeOptions): string {
  const h = options.home ?? process.env.PSYCHE_HOME;
  return h !== undefined && h !== "" ? h : join(homedir(), ".psyche");
}

/** Where the downloaded runtime lives: a package tree the loader imports from. */
export function ortRuntimeDir(spec: OrtRuntimeSpec, options: OrtRuntimeOptions = {}): string {
  return join(home(options), "runtimes", `onnxruntime-${spec.version}-${spec.platform}`);
}

function installedPackageDir(options: OrtRuntimeOptions): string | undefined {
  if (options.packageDir !== undefined) return options.packageDir;
  try {
    const here = createRequire(import.meta.url);
    return dirname(here.resolve("onnxruntime-node/package.json"));
  } catch {
    return undefined;
  }
}

/** The native directory of an `onnxruntime-node` package for this process's platform. */
function nativeDir(pkgDir: string, platform: string, arch: string): string {
  return join(pkgDir, "bin", "napi-v6", platform, arch);
}

function hasLibrary(dir: string): boolean {
  try {
    return readdirSync(dir).some((f) => LIB.test(f));
  } catch {
    return false;
  }
}

export function ortRuntimeState(options: OrtRuntimeOptions = {}): OrtRuntimeState {
  const pkg = installedPackageDir(options);
  if (pkg !== undefined && hasLibrary(nativeDir(pkg, process.platform, process.arch))) {
    return "bundled";
  }
  const spec = "spec" in options ? options.spec : ortRuntimeSpec();
  if (spec === undefined) return "bundled"; // nothing to download: let the import report what is wrong
  const lib = join(
    ortRuntimeDir(spec, options),
    "node_modules/onnxruntime-node/bin/napi-v6",
    spec.platform.replace("-", "/"),
    LIB_NAME,
  );
  try {
    return statSync(lib).size === spec.libSizeBytes ? "installed" : "missing";
  } catch {
    return "missing";
  }
}

/** A package installed next to `pkg` (pnpm links it beside) or in a parent `node_modules`. Its `exports` may hide package.json, so no resolve(). */
function siblingPackage(pkg: string, name: string): string | undefined {
  for (let dir = dirname(realpathSync(pkg)); ; dir = dirname(dir)) {
    const candidate =
      basename(dir) === "node_modules" ? join(dir, name) : join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    if (dirname(dir) === dir) return undefined;
  }
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

/**
 * Lays the runtime out from the verified release archive: extracts the one library (named, never
 * a wildcard), checks its hash, copies the package's JS and binding next to it, and renames the
 * finished tree into place, so a crash leaves nothing half-installed. Returns the runtime dir.
 */
export async function installOrtRuntime(
  archive: string,
  options: OrtRuntimeOptions & { spec: OrtRuntimeSpec },
): Promise<string> {
  const { spec } = options;
  const dest = ortRuntimeDir(spec, options);
  const pkg = installedPackageDir(options);
  if (pkg === undefined) throw new Error("onnxruntime-node is not installed");
  const common = siblingPackage(pkg, "onnxruntime-common");
  if (common === undefined) throw new Error("onnxruntime-common is not installed");
  if (ortRuntimeState(options) === "installed") return dest;

  const stage = `${dest}.part-${process.pid}`;
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true, mode: 0o700 });
  try {
    const out = join(stage, "extract");
    await mkdir(out);
    await run("tar", ["-xzf", archive, "-C", out, spec.member]);
    const extracted = join(out, ...spec.member.split("/"));
    if (!existsSync(extracted)) throw new Error(`${basename(archive)} has no ${spec.member}`);
    if ((await sha256File(extracted)) !== spec.libSha256) {
      throw new Error(`checksum mismatch for the ${spec.version} runtime library`);
    }
    const [os, arch] = spec.platform.split("-") as [string, string];
    const tree = join(stage, "node_modules");
    // Everything of the package but the other platforms' native folders (a dev checkout has them).
    const only = (src: string) => {
      const m = /[\\/]bin[\\/]napi-v6[\\/]([^\\/]+)(?:[\\/]([^\\/]+))?/.exec(src);
      if (m === null) return true;
      return m[1] === os && (m[2] === undefined || m[2] === arch);
    };
    await cp(pkg, join(tree, "onnxruntime-node"), {
      recursive: true,
      dereference: true,
      filter: only,
    });
    await cp(common, join(tree, "onnxruntime-common"), { recursive: true, dereference: true });
    const native = nativeDir(join(tree, "onnxruntime-node"), os, arch);
    await mkdir(native, { recursive: true });
    await rm(join(native, LIB_NAME), { force: true });
    await rename(extracted, join(native, LIB_NAME));
    await chmod(join(native, LIB_NAME), 0o755);
    await rm(out, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
    await rename(stage, dest);
    return dest;
  } catch (err) {
    await rm(stage, { recursive: true, force: true });
    throw err;
  }
}

export type OrtModule = typeof import("onnxruntime-node");

/** Imports onnxruntime-node from wherever its library is; throws `OrtRuntimeMissingError` before a download. */
export async function loadOrt(options: OrtRuntimeOptions = {}): Promise<OrtModule> {
  const state = ortRuntimeState(options);
  if (state === "bundled") return await import("onnxruntime-node");
  const spec = "spec" in options ? options.spec : ortRuntimeSpec();
  if (state === "missing" || spec === undefined) throw new OrtRuntimeMissingError();
  const entry = join(ortRuntimeDir(spec, options), "node_modules/onnxruntime-node/dist/index.js");
  try {
    return (await import(pathToFileURL(entry).href)) as OrtModule;
  } catch (err) {
    // A hardened-runtime process refuses a library signed by someone else (library validation).
    if (/code signature|library load disallowed|not valid for use in process/i.test(String(err))) {
      throw new OrtRuntimeBlockedError({ cause: err });
    }
    throw err;
  }
}

export class OrtRuntimeBlockedError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      "macOS refused to load the downloaded on-device search runtime (library validation): this build's Node runtime is not allowed to load libraries signed by others",
      options,
    );
    this.name = "OrtRuntimeBlockedError";
  }
}

export class OrtRuntimeMissingError extends Error {
  constructor() {
    super("the on-device search runtime is not downloaded yet");
    this.name = "OrtRuntimeMissingError";
  }
}
