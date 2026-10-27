import { rm } from "node:fs/promises";
import {
  installOrtRuntime,
  type OrtRuntimeOptions,
  type OrtRuntimeSpec,
  ortRuntimeSpec,
  ortRuntimeState,
} from "@psyche/search";
import { ModelManager } from "@psyche/speech";

export interface EnsureOrtRuntimeOptions extends OrtRuntimeOptions {
  home: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** Bytes of the archive received so far, and its total. */
  onProgress?: (receivedBytes: number, totalBytes: number) => void;
}

/** Bytes still to download for the runtime: 0 when the package carries it or it is installed. */
export function ortRuntimeDownloadBytes(options: OrtRuntimeOptions = {}): number {
  const spec = "spec" in options ? options.spec : ortRuntimeSpec();
  return spec === undefined || ortRuntimeState(options) !== "missing" ? 0 : spec.sizeBytes;
}

/**
 * Makes the on-device search runtime loadable (packages/search/src/ort-runtime.ts): downloads the
 * pinned release archive into `$PSYCHE_HOME/runtimes/` with the model manager (HTTPS, SHA-256
 * checked while streaming, `.part` file renamed only when verified), installs the library from it
 * and deletes the archive. Nothing happens when the package carries its library or it is already
 * installed. Concurrent calls share one download.
 */
export async function ensureOrtRuntime(options: EnsureOrtRuntimeOptions): Promise<void> {
  const spec: OrtRuntimeSpec | undefined = "spec" in options ? options.spec : ortRuntimeSpec();
  if (spec === undefined || ortRuntimeState(options) !== "missing") return;
  const id = `onnxruntime-${spec.version}-${spec.platform}.tgz`;
  const manager = new ModelManager({
    home: options.home,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    catalog: [
      {
        id,
        engine: "runtimes",
        file: `runtimes/${id}`,
        url: spec.url,
        sha256: spec.sha256,
        sizeBytes: spec.sizeBytes,
        license: spec.license,
      },
    ],
  });
  const archive = await manager.ensure(id, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    onProgress: (p) => options.onProgress?.(p.receivedBytes, p.totalBytes),
  });
  try {
    await installOrtRuntime(archive, { ...options, home: options.home, spec });
  } finally {
    await rm(archive, { force: true });
  }
}
