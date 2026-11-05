import { PsycheError } from "@psyche/protocol";
import type { WhisperServerProcess, WhisperServerState } from "./engines/whisper-server-process.ts";
import type { ModelManager } from "./models.ts";
import type { WhisperRuntime } from "./runtime.ts";

/**
 * The owner's one-click whisper.cpp setup where Psyche provisions the runtime (Windows): the
 * pinned `whisper-server` release and the dictation model, downloaded together when the owner
 * asks (Settings → Voice & dictation, onboarding), each verified by SHA-256 and stored under
 * `$PSYCHE_HOME` (`speech/bin`, `models/whisper`). Progress goes out as `speech.model_download`
 * events, like the Mac helper's system speech assets. Nothing downloads on its own.
 */

export type WhisperInstallState = "missing" | "downloading" | "ready" | "error";

export interface WhisperInstallStatus {
  state: WhisperInstallState;
  model: { id: string; sizeBytes: number; present: boolean; description?: string };
  runtime: { id: string; release: string; sizeBytes: number; present: boolean };
  /** What a download fetches now (the parts that are missing). */
  downloadBytes: number;
  /** While downloading. */
  receivedBytes?: number;
  totalBytes?: number;
  /** The last download's failure. */
  error?: string;
  server: WhisperServerState;
  /** Why the server last failed to start or died (`vcredist_missing`, `crash_loop`, …). */
  serverError?: string;
}

export type WhisperDownloadPhase = "started" | "progress" | "finished" | "failed";

export interface WhisperDownloadEvent {
  phase: WhisperDownloadPhase;
  model: string;
  receivedBytes: number;
  totalBytes: number;
  fraction: number;
  error?: string;
}

export interface WhisperInstallerOptions {
  runtime: WhisperRuntime;
  models: ModelManager;
  modelId: string;
  process?: WhisperServerProcess;
  onEvent?: (e: WhisperDownloadEvent) => void;
  /** Least time between two `progress` events (default 250 ms). */
  progressEveryMs?: number;
  now?: () => number;
}

export class WhisperInstaller {
  readonly #o: WhisperInstallerOptions;
  #running: Promise<void> | undefined;
  #abort: AbortController | undefined;
  #received = 0;
  #total = 0;
  #error: string | undefined;

  constructor(options: WhisperInstallerOptions) {
    this.#o = options;
  }

  get modelId(): string {
    return this.#o.modelId;
  }

  /** Runtime and model installed. */
  async ready(): Promise<boolean> {
    return (await this.#o.runtime.has()) && (await this.#o.models.has(this.#o.modelId));
  }

  async status(): Promise<WhisperInstallStatus> {
    const spec = this.#o.models.spec(this.#o.modelId);
    const rt = this.#o.runtime.spec;
    const modelPresent = await this.#o.models.has(spec.id);
    const runtimePresent = await this.#o.runtime.has();
    const downloading = this.#running !== undefined;
    const state: WhisperInstallState = downloading
      ? "downloading"
      : modelPresent && runtimePresent
        ? "ready"
        : this.#error !== undefined
          ? "error"
          : "missing";
    const out: WhisperInstallStatus = {
      state,
      model: { id: spec.id, sizeBytes: spec.sizeBytes, present: modelPresent },
      runtime: { id: rt.id, release: rt.release, sizeBytes: rt.sizeBytes, present: runtimePresent },
      downloadBytes: (modelPresent ? 0 : spec.sizeBytes) + (runtimePresent ? 0 : rt.sizeBytes),
      server: this.#o.process?.state ?? "stopped",
    };
    if (spec.description !== undefined) out.model.description = spec.description;
    if (downloading) {
      out.receivedBytes = this.#received;
      out.totalBytes = this.#total;
    }
    if (state === "error" && this.#error !== undefined) out.error = this.#error;
    const serverError = this.#o.process?.lastError;
    if (serverError !== undefined) out.serverError = serverError;
    return out;
  }

  /**
   * Starts the download of whatever is missing and returns at once; progress and the outcome
   * arrive as events. `started: false` when one is already running or nothing is missing.
   */
  async download(): Promise<{ started: boolean }> {
    if (this.#running !== undefined) return { started: false };
    if (await this.ready()) return { started: false };
    const abort = new AbortController();
    this.#abort = abort;
    this.#error = undefined;
    const p = this.#download(abort.signal).finally(() => {
      this.#running = undefined;
      this.#abort = undefined;
    });
    this.#running = p;
    void p.catch(() => undefined);
    return { started: true };
  }

  /** Waits for the running download (tests, the CLI). */
  async settled(): Promise<void> {
    await this.#running?.catch(() => undefined);
  }

  cancel(): void {
    this.#abort?.abort();
  }

  async #download(signal: AbortSignal): Promise<void> {
    const spec = this.#o.models.spec(this.#o.modelId);
    const rt = this.#o.runtime;
    const needRuntime = !(await rt.has());
    const needModel = !(await this.#o.models.has(spec.id));
    this.#total = (needRuntime ? rt.spec.sizeBytes : 0) + (needModel ? spec.sizeBytes : 0);
    this.#received = 0;
    const now = this.#o.now ?? Date.now;
    const every = this.#o.progressEveryMs ?? 250;
    let last = 0;
    const emit = (phase: WhisperDownloadPhase, error?: string) => {
      const e: WhisperDownloadEvent = {
        phase,
        model: spec.id,
        receivedBytes: this.#received,
        totalBytes: this.#total,
        fraction: this.#total === 0 ? 1 : Math.min(1, this.#received / this.#total),
      };
      if (error !== undefined) e.error = error;
      this.#o.onEvent?.(e);
    };
    emit("started");
    let base = 0;
    const onProgress = (p: { receivedBytes: number }) => {
      this.#received = base + p.receivedBytes;
      const t = now();
      if (t - last >= every) {
        last = t;
        emit("progress");
      }
    };
    try {
      // The runtime first: it is small, and a model without a server is no use here.
      if (needRuntime) {
        await rt.ensure({ signal, onProgress });
        base += rt.spec.sizeBytes;
        this.#received = base;
      }
      if (needModel) {
        await this.#o.models.ensure(spec.id, { signal, onProgress });
        base += spec.sizeBytes;
        this.#received = base;
      }
    } catch (err) {
      const e = PsycheError.from(err);
      this.#error = e.code === "cancelled" ? undefined : e.message;
      emit("failed", e.message);
      throw e;
    }
    // A fresh install: a start failure from before (a missing file) no longer applies.
    this.#o.process?.reset();
    emit("finished");
  }
}
