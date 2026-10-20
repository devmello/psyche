import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ExecRequest,
  type ExecResult,
  type MethodParams,
  type MethodResult,
  PsycheError,
  type SandboxInstance,
  type SandboxScope,
} from "@psyche/protocol";
import { type ContainerSandboxRunnerOptions, createSandboxRunner } from "@psyche/sandbox";
import { libreOfficeArgv } from "@psyche/viewers/core/convert";
import type { Call } from "../context.ts";
import {
  etagOf,
  type FileSource,
  type FilesSetup,
  openRegularFile,
  readChunk,
  resolveFileSource,
} from "./files.ts";
import type { ComposedPart } from "./services.ts";

/**
 * `documents.convert` (feature P4; ADR-013): Office files become a PDF (or a PNG of the first
 * page) with LibreOffice headless in a sandbox on the full image, network `none`, never on the
 * host. Results are cached under `$PSYCHE_HOME/cache/conversions`, keyed by the file's path,
 * etag and target, and returned in FILE_CHUNK_BYTES chunks. Without a container runtime or the
 * full image the answer is `unavailable` with `details.reason`, which the viewers word.
 */

/** What conversion needs from a sandbox runner; ContainerSandboxRunner fits, tests pass a fake. */
export interface ConversionRunner {
  backend(): Promise<unknown>;
  ensureSandbox(scope: SandboxScope, options?: { network?: "none" }): Promise<SandboxInstance>;
  exec(request: ExecRequest): Promise<ExecResult>;
  readonly files: {
    importFile(
      sandboxId: string,
      path: string,
      bytes: Uint8Array,
      options?: { createParents?: boolean; provenance?: "trusted" | "untrusted" },
    ): Promise<unknown>;
    exportFile(sandboxId: string, path: string): Promise<{ bytes: Uint8Array }>;
  };
  dispose?(): Promise<void>;
}

export interface ConvertSetup extends FilesSetup {
  /** Creates the runner on first use; default: a runner on the full sandbox image. */
  runner?: () => ConversionRunner;
  timeoutMs?: number;
}

/** What LibreOffice converts for the viewers: slides, documents, sheets (UI design §3.7). */
export const CONVERTIBLE = /\.(pptx?|odp|key|docx?|odt|rtf|xlsx?|ods)$/i;

/** The sandbox's import limit (WorkspaceFiles.importFile). */
export const CONVERT_MAX_BYTES = 10 * 1024 * 1024;

/** One long-lived conversion sandbox, apart from every thread's and task's. */
const SCOPE: SandboxScope = { kind: "project", id: "psyche-convert" };
const WORKSPACE = "/workspace";

const unavailable = (message: string, reason: "sandbox_unavailable" | "image_missing") =>
  new PsycheError("unavailable", message, { details: { reason } });

const IMAGE_MISSING =
  "the full sandbox image, which includes LibreOffice, is not installed (deploy/sandbox-image, target full)";

/** A file name safe inside the sandbox, keeping the extension LibreOffice reads. */
export function sandboxFileName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "");
  return safe === "" ? "document" : safe.slice(-120);
}

/** `soffice` argv with a throwaway profile, converting to PDF or a PNG of the first page. */
export function conversionArgv(inputPath: string, outDir: string, target: "pdf" | "thumbnail") {
  const argv = libreOfficeArgv(inputPath, outDir).map((a) =>
    a === "pdf" && target === "thumbnail" ? "png" : a,
  );
  // LibreOffice writes a user profile; keep it in the conversion's own folder.
  argv.splice(1, 0, `-env:UserInstallation=file://${outDir}/../profile`);
  return argv;
}

/** Runs LibreOffice on `bytes` in the conversion sandbox and returns the result's bytes. */
export async function runLibreOffice(
  runner: ConversionRunner,
  name: string,
  bytes: Uint8Array,
  target: "pdf" | "thumbnail",
  timeoutMs = 120_000,
): Promise<Uint8Array> {
  if ((await runner.backend()) == null) {
    throw unavailable("no container runtime is available for the sandbox", "sandbox_unavailable");
  }
  let sandbox: SandboxInstance;
  try {
    sandbox = await runner.ensureSandbox(SCOPE, { network: "none" });
  } catch (err) {
    if (err instanceof PsycheError && err.code === "unavailable") {
      throw /is not present|image/i.test(err.message)
        ? unavailable(IMAGE_MISSING, "image_missing")
        : unavailable(err.message, "sandbox_unavailable");
    }
    throw err;
  }
  const dir = `.psyche-convert/${randomUUID()}`;
  const root = `${WORKSPACE}/${dir}`;
  const input = sandboxFileName(name);
  try {
    await runner.files.importFile(sandbox.id, `${dir}/${input}`, bytes, {
      createParents: true,
      provenance: "untrusted",
    });
    const r = await runner.exec({
      sandboxId: sandbox.id,
      argv: conversionArgv(`${root}/${input}`, `${root}/out`, target),
      cwd: root,
      timeoutMs,
      provenance: "untrusted",
    });
    if (r.exitCode === 127) throw unavailable(IMAGE_MISSING, "image_missing");
    if (r.timedOut)
      throw new PsycheError("timeout", `LibreOffice took longer than ${timeoutMs} ms`);
    if (r.exitCode !== 0) {
      throw new PsycheError("internal", `LibreOffice exited ${r.exitCode ?? "killed"}`);
    }
    const out = `${input.replace(/\.[^.]+$/, "")}.${target === "pdf" ? "pdf" : "png"}`;
    return (await runner.files.exportFile(sandbox.id, `${dir}/out/${out}`)).bytes;
  } finally {
    await runner
      .exec({ sandboxId: sandbox.id, argv: ["rm", "-rf", root], cwd: WORKSPACE, timeoutMs: 30_000 })
      .catch(() => undefined);
  }
}

/**
 * The conversion runner's options. One container serves every document, so each exec's
 * session is reaped when it returns (`reapBackground: "always"`, #286): a process a document
 * starts in LibreOffice cannot outlive its conversion to read or swap the next one.
 */
export const CONVERSION_RUNNER_OPTIONS = {
  variant: "full",
  namePrefix: "psyche-convert",
  idleTimeoutMs: 5 * 60_000,
  maxRunningSandboxes: 1,
  reapBackground: "always",
} as const satisfies ContainerSandboxRunnerOptions;

const defaultRunner = (): ConversionRunner => createSandboxRunner(CONVERSION_RUNNER_OPTIONS);

/** `documents.convert` for the dispatcher, with the conversion runner stopped on shutdown. */
export function composeConversion(setup: ConvertSetup): ComposedPart {
  let runner: ConversionRunner | null = null;
  const inflight = new Map<string, Promise<string>>();
  const cacheDir = join(setup.home, "cache", "conversions");

  const convertToCache = (source: FileSource, target: "pdf" | "thumbnail", key: string) => {
    const out = join(cacheDir, `${key}.${target === "pdf" ? "pdf" : "png"}`);
    let pending = inflight.get(key);
    if (pending === undefined) {
      pending = (async () => {
        try {
          await stat(out);
          return out;
        } catch {
          // Not cached yet.
        }
        const fh = await openRegularFile(source.path);
        let bytes: Uint8Array;
        try {
          const info = await fh.stat();
          if (info.size > CONVERT_MAX_BYTES) {
            throw new PsycheError(
              "invalid_params",
              `${source.name} is larger than 10 MB; Psyche converts files up to 10 MB`,
            );
          }
          bytes = await fh.readFile();
        } finally {
          await fh.close();
        }
        runner ??= (setup.runner ?? defaultRunner)();
        const result = await runLibreOffice(runner, source.name, bytes, target, setup.timeoutMs);
        await mkdir(cacheDir, { recursive: true, mode: 0o700 });
        const tmp = `${out}.${randomUUID()}.tmp`;
        await writeFile(tmp, result, { mode: 0o600 });
        await rename(tmp, out);
        return out;
      })().finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    return pending;
  };

  return {
    handlers: {
      "documents.convert": {
        async run(
          _call: Call,
          params: MethodParams<"documents.convert">,
        ): Promise<MethodResult<"documents.convert">> {
          const source = await resolveFileSource(params, setup);
          if (!CONVERTIBLE.test(source.name)) {
            throw new PsycheError(
              "invalid_params",
              `${source.name} is not a document Psyche converts`,
            );
          }
          const probe = await openRegularFile(source.path);
          const info = await probe.stat().finally(() => probe.close());
          const key = createHash("sha256")
            .update(`${source.path}\0${etagOf(info)}\0${params.target}`)
            .digest("hex")
            .slice(0, 32);
          const path = await convertToCache(source, params.target, key);
          const fh = await open(path, "r");
          try {
            const size = (await fh.stat()).size;
            const chunk = await readChunk(fh, size, params.offset, params.length);
            return { mime: params.target === "pdf" ? "application/pdf" : "image/png", ...chunk };
          } finally {
            await fh.close();
          }
        },
      },
    },
    async stop() {
      await runner?.dispose?.();
    },
  };
}
