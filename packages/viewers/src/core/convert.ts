import type { SandboxRunner } from "@psyche/protocol";
import { extensionOf } from "./registry.ts";

/**
 * Office conversion (P4). There is no maintained permissive PPTX renderer in JS (ADR-013), so
 * slides (and fidelity-critical documents) are converted to PDF by LibreOffice headless or
 * Gotenberg inside the sandbox, or to a thumbnail by `qlmanage` on the Mac node. Viewers take a
 * `ConversionService` and show a placeholder when none is configured or conversion fails.
 */

export type ConversionTarget = "pdf" | "thumbnail";

export interface ConversionInput {
  bytes: Uint8Array;
  name: string;
  mime: string;
}

export type ConversionResult =
  | { kind: "pdf"; bytes: Uint8Array }
  | { kind: "thumbnail"; mime: "image/png"; bytes: Uint8Array };

export interface ConversionService {
  readonly id: string;
  supports(input: { name: string; mime: string }, target: ConversionTarget): boolean;
  convert(
    input: ConversionInput,
    target: ConversionTarget,
    opts?: { signal?: AbortSignal },
  ): Promise<ConversionResult>;
}

export class ConversionError extends Error {
  constructor(
    message: string,
    readonly service: string,
  ) {
    super(message);
    this.name = "ConversionError";
  }
}

/** Formats LibreOffice / Gotenberg convert well. */
export const OFFICE_EXTENSIONS = new Set([
  "pptx", "ppt", "odp", "key", "docx", "doc", "odt", "rtf", "xlsx", "xls", "ods",
]);

const officeLike = (name: string) => OFFICE_EXTENSIONS.has(extensionOf(name) ?? "");

/** Keeps only a safe basename: no directories, no leading dashes (argv injection), no NUL. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  const cleaned = base.replace(/[^\w.\- ]+/g, "_").replace(/^[-.]+/, "");
  return cleaned.length === 0 ? "file" : cleaned.slice(0, 120);
}

/** Gotenberg 8 (`gotenberg/gotenberg:8`), reachable from the Gateway (sandbox-local). */
export class GotenbergConversionService implements ConversionService {
  readonly id = "gotenberg";
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(opts: { baseUrl: string; fetch?: typeof fetch }) {
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.#fetch = opts.fetch ?? fetch;
  }

  supports(input: { name: string }, target: ConversionTarget): boolean {
    return target === "pdf" && officeLike(input.name);
  }

  async convert(input: ConversionInput, target: ConversionTarget, opts: { signal?: AbortSignal } = {}) {
    if (!this.supports(input, target)) throw new ConversionError(`unsupported: ${input.name}`, this.id);
    const form = new FormData();
    form.append("files", new Blob([input.bytes.slice()], { type: input.mime }), safeFileName(input.name));
    const res = await this.#fetch(`${this.#baseUrl}/forms/libreoffice/convert`, {
      method: "POST",
      body: form,
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    });
    if (!res.ok) throw new ConversionError(`Gotenberg returned ${res.status}`, this.id);
    return { kind: "pdf", bytes: new Uint8Array(await res.arrayBuffer()) } as const;
  }
}

/** Moves files in and out of a sandbox workspace (provided by the Gateway with S21's runner). */
export interface WorkspaceFiles {
  write(relativePath: string, bytes: Uint8Array): Promise<void>;
  read(relativePath: string): Promise<Uint8Array>;
  remove(relativePath: string): Promise<void>;
}

const randomId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");

/** argv for `soffice` headless PDF conversion (exported for tests and the Mac node). */
export function libreOfficeArgv(inputPath: string, outDir: string): string[] {
  return [
    "soffice",
    "--headless",
    "--norestore",
    "--nolockcheck",
    "--nodefault",
    "--convert-to",
    "pdf",
    "--outdir",
    outDir,
    inputPath,
  ];
}

/** argv for a Quick Look thumbnail on macOS (`qlmanage -t -s <px> -o <dir> <file>`). */
export function qlmanageArgv(inputPath: string, outDir: string, size = 1600): string[] {
  return ["qlmanage", "-t", "-s", String(size), "-o", outDir, inputPath];
}

/**
 * LibreOffice headless inside the task's sandbox (network `none`). Never runs on the host: the
 * runner rejects when no container backend exists, and so does this service.
 */
export class SandboxLibreOfficeService implements ConversionService {
  readonly id = "libreoffice";
  constructor(
    private readonly opts: {
      runner: SandboxRunner;
      sandboxId: string;
      files: WorkspaceFiles;
      /** Container path of the workspace volume (`/workspace`). */
      workspacePath: string;
      timeoutMs?: number;
    },
  ) {}

  supports(input: { name: string }, target: ConversionTarget): boolean {
    return target === "pdf" && officeLike(input.name);
  }

  async convert(input: ConversionInput, target: ConversionTarget, opts: { signal?: AbortSignal } = {}) {
    if (!this.supports(input, target)) throw new ConversionError(`unsupported: ${input.name}`, this.id);
    const dir = `.psyche-convert/${randomId()}`;
    const name = safeFileName(input.name);
    const outName = `${name.replace(/\.[^.]+$/, "")}.pdf`;
    await this.opts.files.write(`${dir}/${name}`, input.bytes);
    try {
      const root = `${this.opts.workspacePath.replace(/\/+$/, "")}/${dir}`;
      const result = await this.opts.runner.exec({
        sandboxId: this.opts.sandboxId,
        argv: libreOfficeArgv(`${root}/${name}`, `${root}/out`),
        cwd: root,
        timeoutMs: this.opts.timeoutMs ?? 120_000,
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      });
      if (result.exitCode !== 0) {
        throw new ConversionError(`soffice exited ${result.exitCode ?? "killed"}`, this.id);
      }
      return { kind: "pdf", bytes: await this.opts.files.read(`${dir}/out/${outName}`) } as const;
    } finally {
      await this.opts.files.remove(dir).catch(() => undefined);
    }
  }
}

/** Tries services in order; the first that supports the input and succeeds wins. */
export class ChainedConversionService implements ConversionService {
  readonly id = "chain";
  constructor(private readonly services: readonly ConversionService[]) {}

  supports(input: { name: string; mime: string }, target: ConversionTarget): boolean {
    return this.services.some((s) => s.supports(input, target));
  }

  async convert(input: ConversionInput, target: ConversionTarget, opts?: { signal?: AbortSignal }) {
    const errors: string[] = [];
    for (const s of this.services) {
      if (!s.supports(input, target)) continue;
      try {
        return await s.convert(input, target, opts);
      } catch (err) {
        if (opts?.signal?.aborted) throw err;
        errors.push(`${s.id}: ${(err as Error).message}`);
      }
    }
    throw new ConversionError(errors.join("; ") || "no converter available", this.id);
  }
}
