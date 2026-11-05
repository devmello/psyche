import { execFile } from "node:child_process";
import { mkdtemp, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { PsycheError } from "@psyche/protocol";
import { type DownloadProgress, ModelManager, type ModelSpec, sha256File } from "./models.ts";

/**
 * The whisper.cpp runtime on Windows (`whisper-server.exe` and its DLLs), provisioned from the
 * official whisper.cpp release like a model: nothing downloads until the owner asks (Settings →
 * Voice & dictation, onboarding), the release zip is pinned to an HTTPS URL, a size and the
 * SHA-256 GitHub publishes for the asset, and only the files the server needs are extracted, each
 * checked against its own pinned size and SHA-256 before the directory is renamed into place.
 * Layout: `$PSYCHE_HOME/speech/bin/<dir>/` (the zip is deleted after extraction).
 *
 * Pinned: release `b5454` (whisper.cpp v1.9.5, 2026-10-06), the CPU builds. `x64` loads the best
 * of its `ggml-cpu-*` variants at run time (SSE4.2 … AVX-512). The CUDA builds are 285–685 MB
 * and the release has no Vulkan build for Windows, so GPU is not offered. The DLLs need the
 * Visual C++ 2015–2022 runtime (MSVCP140, VCRUNTIME140(_1), VCOMP140), present on most PCs; a
 * missing one makes the server exit with STATUS_DLL_NOT_FOUND, reported as `vcredist_missing`.
 */
export interface RuntimeMember {
  name: string;
  sizeBytes: number;
  sha256: string;
}

export interface WhisperRuntimeSpec extends ModelSpec {
  platform: NodeJS.Platform;
  arch: string;
  /** whisper.cpp release tag. */
  release: string;
  /** Directory under `speech/bin` the members are extracted into. */
  dir: string;
  /** Path prefix of the members inside the zip. */
  prefix: string;
  members: readonly RuntimeMember[];
  /** The server binary among the members. */
  server: string;
}

const RELEASE = "b5454";
const BASE = `https://github.com/ggml-org/whisper.cpp/releases/download/${RELEASE}`;

const m = (name: string, sizeBytes: number, sha256: string): RuntimeMember => ({
  name,
  sizeBytes,
  sha256,
});

export const WHISPER_RUNTIME_CATALOG: readonly WhisperRuntimeSpec[] = [
  {
    id: `whisper-runtime-${RELEASE}-win-x64`,
    engine: "whisper-runtime",
    file: `whisper-bin-${RELEASE}-x64.zip`,
    url: `${BASE}/whisper-bin-x64.zip`,
    sha256: "6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb",
    sizeBytes: 8_928_640,
    license: "MIT",
    description: "whisper.cpp v1.9.5 (b5454) Windows x64 CPU build",
    platform: "win32",
    arch: "x64",
    release: RELEASE,
    dir: `whisper-${RELEASE}-win-x64`,
    prefix: "Release/",
    server: "whisper-server.exe",
    members: [
      m(
        "whisper-server.exe",
        726_016,
        "a97456e747f28e7bb09c1dac35f40d94404c5ecffa74aaaaa7a3753ea6543121",
      ),
      m(
        "whisper.dll",
        1_370_112,
        "034396d75bb5720c1851674ff64a96192b58f6927b68d334ebd254ce6cad9674",
      ),
      m("ggml.dll", 62_464, "31fe18616d872af9b6134b47a6dff8072ae4ecbe5df0273f4f8dc36766c9db8e"),
      m(
        "ggml-base.dll",
        693_248,
        "bede0d6b2d387236ecd2b5dd676d51c8984b5b6e0ae461a12174e9c01345c5f0",
      ),
      m(
        "ggml-cpu-alderlake.dll",
        1_009_664,
        "d8f5c56ea490394eeae8b271650f2647aecd039a542d6df9e0140726e62a4603",
      ),
      m(
        "ggml-cpu-cannonlake.dll",
        1_049_600,
        "74127b40abd4f595d9db6af0fa313a02e18ff42fc228bfa05281e7c788dd4507",
      ),
      m(
        "ggml-cpu-cascadelake.dll",
        1_061_376,
        "4b11c427b844eeac87529af9a8d94b35aad2024666beb2a35e59fe3077e4b81e",
      ),
      m(
        "ggml-cpu-haswell.dll",
        1_010_688,
        "1306b1014c8118d27234d8ddc0e66ced1f8c8476bf85071595fd182ea9b7263b",
      ),
      m(
        "ggml-cpu-icelake.dll",
        1_061_376,
        "2b4dc4c66e7d8fe2807283816e9cf3b7f7d0556f59df34069871e37eab8aed40",
      ),
      m(
        "ggml-cpu-sandybridge.dll",
        1_026_560,
        "04edbdebc01a1d421062a960881a4f34d520d99693999518243f332406444c6e",
      ),
      m(
        "ggml-cpu-skylakex.dll",
        1_049_600,
        "1774714cf93621406ff35344b54715619a83242ae3e331e44d98a3b35ce801be",
      ),
      m(
        "ggml-cpu-sse42.dll",
        862_720,
        "f060318772c4c2dbac312bbfff6ea700b85dbc502bb38585a7186d06d549301a",
      ),
      m(
        "ggml-cpu-x64.dll",
        866_816,
        "4b4b05caba40d4309b5d710ef74c59ba190516b8489f27bdb1ba11ae33c6e9d3",
      ),
    ],
  },
  {
    id: `whisper-runtime-${RELEASE}-win-arm64`,
    engine: "whisper-runtime",
    file: `whisper-bin-${RELEASE}-win-cpu-arm64.zip`,
    url: `${BASE}/whisper-bin-win-cpu-arm64.zip`,
    sha256: "28c37e7b598c3d9bbfef94f3bd67f2ee6f12b7c86f3da5edcf5e4308d615ff6d",
    sizeBytes: 4_371_193,
    license: "MIT",
    description: "whisper.cpp v1.9.5 (b5454) Windows arm64 CPU build",
    platform: "win32",
    arch: "arm64",
    release: RELEASE,
    dir: `whisper-${RELEASE}-win-arm64`,
    prefix: "Release/",
    server: "whisper-server.exe",
    members: [
      m(
        "whisper-server.exe",
        1_001_472,
        "c5b3d51a2f327f0e8d793f02cbbb05f656b11b9e365976e84e88965d9de72f7c",
      ),
      m("whisper.dll", 450_560, "48214430bbfce6cd656125c06d1c368286412681dab0242061c5cafa57913419"),
      m("ggml.dll", 61_440, "bd4a483fd315a95a66f43283c710f77d42cc13315829cb0a3ecffc30b843ac9f"),
      m(
        "ggml-base.dll",
        683_520,
        "7c8698821411149cfdebf587a26263bcb43e7ab396759e24eb641f665b10b45e",
      ),
      m(
        "ggml-cpu.dll",
        772_608,
        "139a72c067da8862aea7d19246668884852c444af343761c1535dc32bed2ad81",
      ),
    ],
  },
];

/** The pinned runtime for this host, if whisper.cpp publishes one Psyche provisions. */
export function whisperRuntimeFor(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): WhisperRuntimeSpec | undefined {
  return WHISPER_RUNTIME_CATALOG.find((s) => s.platform === platform && s.arch === arch);
}

/** Extracts `members` (zip paths) of `zip` into `dest`, which exists and is empty. */
export type ZipExtractor = (zip: string, dest: string, members: string[]) => Promise<void>;

/**
 * Windows' own bsdtar (`%SystemRoot%\System32\tar.exe`, Windows 10 1803+) reads zip; only the
 * named members are written, so nothing else in the archive lands on disk.
 */
export const tarExtract: ZipExtractor = (zip, dest, members) => {
  const tar =
    process.platform === "win32"
      ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
      : "bsdtar";
  return new Promise((resolve, reject) => {
    execFile(
      tar,
      ["-x", "-f", zip, "-C", dest, ...members],
      { windowsHide: true, timeout: 120_000 },
      (err, _stdout, stderr) => {
        if (err === null) resolve();
        else
          reject(
            new PsycheError("internal", `extracting the whisper.cpp runtime failed: ${stderr}`, {
              cause: err,
            }),
          );
      },
    );
  });
};

export interface WhisperRuntimeOptions {
  /** `$PSYCHE_HOME`. */
  home: string;
  spec: WhisperRuntimeSpec;
  fetch?: typeof fetch;
  extract?: ZipExtractor;
}

export class WhisperRuntime {
  readonly spec: WhisperRuntimeSpec;
  /** `$PSYCHE_HOME/speech/bin`. */
  readonly binDir: string;
  readonly #zips: ModelManager;
  readonly #extract: ZipExtractor;
  #inflight: Promise<string> | undefined;

  constructor(options: WhisperRuntimeOptions) {
    this.spec = options.spec;
    this.binDir = join(options.home, "speech", "bin");
    this.#zips = new ModelManager({
      dir: this.binDir,
      catalog: [options.spec],
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    this.#extract = options.extract ?? tarExtract;
    for (const mem of options.spec.members) {
      if (!/^[\w.-]+$/.test(mem.name) || !/^[0-9a-f]{64}$/.test(mem.sha256)) {
        throw new PsycheError("invalid_params", `runtime member ${mem.name} is not pinned`);
      }
    }
  }

  get dir(): string {
    return join(this.binDir, this.spec.dir);
  }

  get serverPath(): string {
    return join(this.dir, this.spec.server);
  }

  /** Bytes a download fetches now: the zip, or 0 when the runtime is installed. */
  async downloadBytes(): Promise<number> {
    return (await this.has()) ? 0 : this.spec.sizeBytes;
  }

  /** Installed means every member is present with its pinned size (hashed on install). */
  async has(): Promise<boolean> {
    for (const mem of this.spec.members) {
      try {
        const st = await stat(join(this.dir, mem.name));
        if (!st.isFile() || st.size !== mem.sizeBytes) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  /** Re-hashes every member (doctor). */
  async verify(): Promise<boolean> {
    if (!(await this.has())) return false;
    for (const mem of this.spec.members) {
      if ((await sha256File(join(this.dir, mem.name))) !== mem.sha256) return false;
    }
    return true;
  }

  /** Downloads, verifies and extracts the runtime unless installed; returns the server path. */
  ensure(
    options: { signal?: AbortSignal; onProgress?: (p: DownloadProgress) => void } = {},
  ): Promise<string> {
    if (this.#inflight !== undefined) return this.#inflight;
    const p = this.#ensure(options).finally(() => {
      this.#inflight = undefined;
    });
    this.#inflight = p;
    return p;
  }

  async remove(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
    await this.#zips.remove(this.spec.id);
  }

  async #ensure(options: {
    signal?: AbortSignal;
    onProgress?: (p: DownloadProgress) => void;
  }): Promise<string> {
    if (await this.has()) return this.serverPath;
    const zip = await this.#zips.ensure(this.spec.id, options);
    const staging = await mkdtemp(join(this.binDir, `${this.spec.dir}.part-`));
    try {
      await this.#extract(
        zip,
        staging,
        this.spec.members.map((mem) => `${this.spec.prefix}${mem.name}`),
      );
      const root = join(staging, ...this.spec.prefix.split("/").filter(Boolean));
      for (const mem of this.spec.members) {
        const path = join(root, mem.name);
        const size = await stat(path).then(
          (s) => s.size,
          () => -1,
        );
        const digest = size === mem.sizeBytes ? await sha256File(path) : "";
        if (digest !== mem.sha256) {
          throw new PsycheError(
            "invalid_params",
            `checksum mismatch for ${mem.name} in ${this.spec.id}: expected ${mem.sha256} (${mem.sizeBytes} B), got ${digest || "-"} (${size} B)`,
          );
        }
      }
      await rm(this.dir, { recursive: true, force: true });
      await rename(root, this.dir);
    } finally {
      await rm(staging, { recursive: true, force: true });
      await this.#zips.remove(this.spec.id);
    }
    return this.serverPath;
  }
}
