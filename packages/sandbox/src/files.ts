import { type ErrorCode, PsycheError } from "@psyche/protocol";
import type { CliResult } from "./cli.ts";
import { fail } from "./errors.ts";
import { TEXT_FILE_CAP_BYTES, TRANSFER_FILE_CAP_BYTES } from "./limits.ts";
import { FILES_HELPER, PYTHON } from "./scripts.ts";
import { workspaceRelative } from "./validate.ts";

export type WorkspaceEntryKind = "file" | "dir" | "symlink" | "other";

export interface WorkspaceEntry {
  name: string;
  /** Symlinks are listed (as `symlink`) but never followed. */
  kind: WorkspaceEntryKind;
  size: number;
  mtimeMs: number;
}

/** Runs the files helper in the sandbox: `python3 -c FILES_HELPER <args>` with stdin. */
export type HelperExec = (
  sandboxId: string,
  argv: string[],
  options: { input?: Uint8Array | string; maxBytes: number },
) => Promise<CliResult>;

const KNOWN_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  "invalid_params",
  "forbidden",
  "not_found",
  "conflict",
  "internal",
]);

/**
 * File API confined to `/workspace` (K3). Runs inside the container as UID 1000, so it sees
 * exactly what commands see; symlinks and special files are rejected by the helper after
 * each path component is opened with O_NOFOLLOW. Text is capped at 256 KB, import/export at
 * 10 MB.
 */
export class WorkspaceFiles {
  readonly #exec: HelperExec;

  constructor(exec: HelperExec) {
    this.#exec = exec;
  }

  async list(
    sandboxId: string,
    path = "",
  ): Promise<{ entries: WorkspaceEntry[]; truncated: boolean }> {
    const listed = await this.#json<{ entries: WorkspaceEntry[]; truncated: boolean }>(sandboxId, [
      "list",
      workspaceRelative(path),
    ]);
    // Names come from inside the sandbox; drop anything that is not a single path component.
    const entries = listed.entries.filter(
      (e) =>
        typeof e.name === "string" &&
        e.name !== "" &&
        !/[/\0]/.test(e.name) &&
        e.name !== "." &&
        e.name !== "..",
    );
    return { entries, truncated: listed.truncated === true };
  }

  async stat(sandboxId: string, path: string): Promise<Omit<WorkspaceEntry, "name">> {
    return this.#json(sandboxId, ["stat", workspaceRelative(path)]);
  }

  /** UTF-8 text up to 256 KB; larger or binary files reject with `invalid_params`. */
  async readText(sandboxId: string, path: string): Promise<string> {
    const bytes = await this.#read(sandboxId, path, TEXT_FILE_CAP_BYTES);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return fail("invalid_params", `${path} is not UTF-8 text; use exportFile`);
    }
  }

  /** Atomic replace (temp file + rename). Keeps the mode of an existing file. */
  async writeText(
    sandboxId: string,
    path: string,
    text: string,
    options: { createParents?: boolean } = {},
  ): Promise<{ size: number }> {
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length > TEXT_FILE_CAP_BYTES) {
      fail("invalid_params", `text is larger than ${TEXT_FILE_CAP_BYTES} bytes`);
    }
    return this.#write(sandboxId, path, bytes, TEXT_FILE_CAP_BYTES, options.createParents);
  }

  /**
   * Replaces `oldText` with `newText`. It must occur exactly once unless `replaceAll`
   * (`not_found` when absent, `conflict` when ambiguous). Atomic.
   */
  async edit(
    sandboxId: string,
    path: string,
    edit: { oldText: string; newText: string; replaceAll?: boolean },
  ): Promise<{ replacements: number }> {
    if (typeof edit.oldText !== "string" || edit.oldText === "") {
      fail("invalid_params", "oldText must be a non-empty string");
    }
    if (typeof edit.newText !== "string") fail("invalid_params", "newText must be a string");
    const input = JSON.stringify({ old: edit.oldText, new: edit.newText, all: edit.replaceAll });
    return this.#json(sandboxId, ["edit", workspaceRelative(path), String(TEXT_FILE_CAP_BYTES)], {
      input,
    });
  }

  /** Byte-exact copy into the workspace (PDFs, images), up to 10 MB. */
  async importFile(
    sandboxId: string,
    path: string,
    bytes: Uint8Array,
    options: { createParents?: boolean } = {},
  ): Promise<{ size: number }> {
    if (bytes.length > TRANSFER_FILE_CAP_BYTES) {
      fail("invalid_params", `file is larger than ${TRANSFER_FILE_CAP_BYTES} bytes`);
    }
    return this.#write(sandboxId, path, bytes, TRANSFER_FILE_CAP_BYTES, options.createParents);
  }

  /** Byte-exact copy out of the workspace, up to 10 MB. */
  async exportFile(sandboxId: string, path: string): Promise<Uint8Array> {
    return this.#read(sandboxId, path, TRANSFER_FILE_CAP_BYTES);
  }

  async #read(sandboxId: string, path: string, cap: number): Promise<Uint8Array> {
    const r = await this.#run(sandboxId, ["read", workspaceRelative(path), String(cap)], {
      maxBytes: cap + 1,
    });
    return new Uint8Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length);
  }

  async #write(
    sandboxId: string,
    path: string,
    bytes: Uint8Array,
    cap: number,
    createParents = false,
  ): Promise<{ size: number }> {
    const rel = workspaceRelative(path);
    if (rel === "") fail("invalid_params", "path names the workspace root");
    return this.#json(sandboxId, ["write", rel, String(cap), createParents ? "1" : "0"], {
      input: bytes,
    });
  }

  async #json<T>(
    sandboxId: string,
    args: string[],
    options: { input?: Uint8Array | string } = {},
  ): Promise<T> {
    const r = await this.#run(sandboxId, args, { ...options, maxBytes: 4 * 1024 * 1024 });
    try {
      return JSON.parse(r.stdout.toString("utf8")) as T;
    } catch {
      return fail("internal", "file helper returned malformed output");
    }
  }

  async #run(
    sandboxId: string,
    args: string[],
    options: { input?: Uint8Array | string; maxBytes: number },
  ): Promise<CliResult> {
    const r = await this.#exec(sandboxId, [PYTHON, "-I", "-S", "-c", FILES_HELPER, ...args], {
      input: options.input ?? "",
      maxBytes: options.maxBytes,
    });
    if (r.exitCode === 0) return r;
    throw helperError(r);
  }
}

export function helperError(r: CliResult): PsycheError {
  const text = r.stderr.toString("utf8").trim();
  if (r.exitCode === 3) {
    try {
      const parsed = JSON.parse(text) as { code?: unknown; message?: unknown };
      const code =
        typeof parsed.code === "string" && KNOWN_CODES.has(parsed.code)
          ? (parsed.code as ErrorCode)
          : "internal";
      return new PsycheError(code, String(parsed.message ?? "file operation failed"));
    } catch {
      // fall through
    }
  }
  return new PsycheError(
    "internal",
    `file helper failed (exit ${r.exitCode}): ${text.slice(0, 500)}`,
  );
}
