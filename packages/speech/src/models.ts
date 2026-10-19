import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, normalize, sep } from "node:path";
import { PsycheError } from "@psyche/protocol";

/**
 * Model download manager. Models live in `$PSYCHE_HOME/models/<engine>/<file>` (default
 * `~/.psyche`). Policy (README "Model download policy"):
 *
 * - Nothing downloads on its own. `ensure` runs only when the owner picks a model (Settings →
 *   Voice & dictation, onboarding, `psyche models pull`). Engines report `unavailable` until then.
 * - Every model is pinned to an HTTPS URL and a SHA-256 in the catalog. The bytes are hashed while
 *   streaming into `<file>.part`; a mismatch deletes the partial and rejects. Only a verified file
 *   is renamed into place, so a crash never leaves a half-written model under the real name.
 * - Directories are 0700 and files 0600, like the rest of `$PSYCHE_HOME`.
 */
export interface ModelSpec {
  id: string;
  engine: string;
  /** Path relative to the models dir, e.g. `whisper/ggml-base.en.bin`. */
  file: string;
  url: string;
  sha256: string;
  sizeBytes: number;
  license: string;
  description?: string;
}

export interface ModelStatus {
  spec: ModelSpec;
  path: string;
  present: boolean;
}

export interface DownloadProgress {
  id: string;
  receivedBytes: number;
  totalBytes: number;
}

export interface ModelManagerOptions {
  /** `$PSYCHE_HOME`; defaults to the env var, then `~/.psyche`. */
  home?: string;
  catalog: readonly ModelSpec[];
  fetch?: typeof fetch;
}

export function psycheHome(env: NodeJS.ProcessEnv = process.env): string {
  const h = env.PSYCHE_HOME;
  return h !== undefined && h !== "" ? h : join(homedir(), ".psyche");
}

export class ModelManager {
  readonly dir: string;
  readonly #catalog: Map<string, ModelSpec>;
  readonly #fetch: typeof fetch;
  readonly #inflight = new Map<string, Promise<string>>();

  constructor(options: ModelManagerOptions) {
    this.dir = join(options.home ?? psycheHome(), "models");
    this.#catalog = new Map(options.catalog.map((s) => [s.id, s]));
    this.#fetch = options.fetch ?? fetch;
    for (const s of options.catalog) {
      if (!s.url.startsWith("https://")) {
        throw new PsycheError("invalid_params", `model ${s.id} must download over https`);
      }
      if (!/^[0-9a-f]{64}$/.test(s.sha256)) {
        throw new PsycheError("invalid_params", `model ${s.id} needs a hex sha256`);
      }
    }
  }

  spec(id: string): ModelSpec {
    const s = this.#catalog.get(id);
    if (s === undefined) throw new PsycheError("not_found", `unknown model ${id}`);
    return s;
  }

  catalog(): ModelSpec[] {
    return [...this.#catalog.values()];
  }

  /** Absolute path for a model; rejects catalog entries that escape the models dir. */
  path(id: string): string {
    const p = normalize(join(this.dir, this.spec(id).file));
    if (!p.startsWith(this.dir + sep)) {
      throw new PsycheError("invalid_params", `model ${id} path escapes the models dir`);
    }
    return p;
  }

  /** Present means the file exists with the catalog size (the hash was checked on download). */
  async has(id: string): Promise<boolean> {
    try {
      const st = await stat(this.path(id));
      return st.isFile() && st.size === this.spec(id).sizeBytes;
    } catch {
      return false;
    }
  }

  async list(): Promise<ModelStatus[]> {
    const out: ModelStatus[] = [];
    for (const spec of this.#catalog.values()) {
      out.push({ spec, path: this.path(spec.id), present: await this.has(spec.id) });
    }
    return out;
  }

  /** Re-hashes a present model (doctor). */
  async verify(id: string): Promise<boolean> {
    if (!(await this.has(id))) return false;
    return (await sha256File(this.path(id))) === this.spec(id).sha256;
  }

  /** Downloads and verifies the model unless present; returns its path. Concurrent calls share. */
  ensure(
    id: string,
    options: { signal?: AbortSignal; onProgress?: (p: DownloadProgress) => void } = {},
  ): Promise<string> {
    const running = this.#inflight.get(id);
    if (running !== undefined) return running;
    const p = this.#ensure(id, options).finally(() => this.#inflight.delete(id));
    this.#inflight.set(id, p);
    return p;
  }

  async remove(id: string): Promise<void> {
    await rm(this.path(id), { force: true });
  }

  async #ensure(
    id: string,
    options: { signal?: AbortSignal; onProgress?: (p: DownloadProgress) => void },
  ): Promise<string> {
    const spec = this.spec(id);
    const dest = this.path(id);
    if (await this.has(id)) return dest;
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700).catch(() => {});
    const part = `${dest}.part`;
    const init: RequestInit = { redirect: "follow" };
    if (options.signal !== undefined) init.signal = options.signal;
    let res: Response;
    try {
      res = await this.#fetch(spec.url, init);
    } catch (err) {
      if (options.signal?.aborted === true)
        throw new PsycheError("cancelled", `download of ${id} cancelled`);
      throw new PsycheError("unavailable", `download of ${id} failed`, {
        cause: err,
        retryable: true,
      });
    }
    if (!res.ok || res.body === null) {
      throw new PsycheError("unavailable", `download of ${id} failed: HTTP ${res.status}`, {
        retryable: res.status >= 500 || res.status === 429,
      });
    }
    const hash = createHash("sha256");
    const fh = await open(part, "w", 0o600);
    let received = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > spec.sizeBytes) {
          await reader.cancel();
          throw new PsycheError("invalid_params", `${id} is larger than the catalog says`);
        }
        hash.update(value);
        await fh.write(value);
        options.onProgress?.({ id, receivedBytes: received, totalBytes: spec.sizeBytes });
      }
    } catch (err) {
      await fh.close();
      await rm(part, { force: true });
      if (options.signal?.aborted === true)
        throw new PsycheError("cancelled", `download of ${id} cancelled`);
      throw err;
    }
    await fh.close();
    const digest = hash.digest("hex");
    if (digest !== spec.sha256 || received !== spec.sizeBytes) {
      await rm(part, { force: true });
      throw new PsycheError(
        "invalid_params",
        `checksum mismatch for ${id}: expected ${spec.sha256} (${spec.sizeBytes} B), got ${digest} (${received} B)`,
      );
    }
    await rename(part, dest);
    return dest;
  }
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (b) => hash.update(b))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}
