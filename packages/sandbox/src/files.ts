import {
  type ErrorCode,
  type ProvenanceOut,
  PsycheError,
  type TaintSource,
} from "@psyche/protocol";
import type { CliResult } from "./cli.ts";
import { fail } from "./errors.ts";
import { TEXT_FILE_CAP_BYTES, TRANSFER_FILE_CAP_BYTES } from "./limits.ts";
import {
  type FileProvenance,
  sha256Hex,
  type WorkspaceProvenance,
  type WriteProvenance,
} from "./provenance.ts";
import { FILES_HELPER, PYTHON } from "./scripts.ts";
import { workspaceRelative } from "./validate.ts";

export type WorkspaceEntryKind = "file" | "dir" | "symlink" | "other";

export interface WorkspaceEntry {
  name: string;
  /** Symlinks are listed (as `symlink`) but never followed. */
  kind: WorkspaceEntryKind;
  size: number;
  mtimeMs: number;
  /**
   * For files: the provenance of the latest recorded write (design-07). Names are data from
   * inside the sandbox either way; a listing that holds any untrusted entry is `untrusted`.
   */
  provenance?: ProvenanceOut;
}

export interface WorkspaceListing {
  entries: WorkspaceEntry[];
  truncated: boolean;
  /** `untrusted` when any entry is a file of untrusted provenance or a symlink / special file. */
  provenance: ProvenanceOut;
}

export interface WriteOptions extends WriteProvenance {
  createParents?: boolean;
}

/** Looks up the provenance index of a sandbox; `not_found` for an unknown sandbox. */
export type ProvenanceLookup = (sandboxId: string) => WorkspaceProvenance;

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
  readonly #provenance: ProvenanceLookup;

  constructor(exec: HelperExec, provenance: ProvenanceLookup) {
    this.#exec = exec;
    this.#provenance = provenance;
  }

  async list(sandboxId: string, path = ""): Promise<WorkspaceListing> {
    const dir = workspaceRelative(path);
    const listed = await this.#json<{ entries: WorkspaceEntry[]; truncated: boolean }>(sandboxId, [
      "list",
      dir,
    ]);
    const index = this.#provenance(sandboxId);
    // Names come from inside the sandbox; drop anything that is not a single path component.
    const entries = listed.entries.filter(
      (e) =>
        typeof e.name === "string" &&
        e.name !== "" &&
        !/[/\0]/.test(e.name) &&
        e.name !== "." &&
        e.name !== "..",
    );
    let provenance: ProvenanceOut = "trusted";
    for (const e of entries) {
      if (e.kind === "file") {
        e.provenance = index.lookup(dir === "" ? e.name : `${dir}/${e.name}`).provenance;
        if (e.provenance === "untrusted") provenance = "untrusted";
      } else if (e.kind !== "dir") {
        // Symlinks and special files are never written through the API: nobody vouches for them.
        provenance = "untrusted";
      }
    }
    return { entries, truncated: listed.truncated === true, provenance };
  }

  async stat(
    sandboxId: string,
    path: string,
  ): Promise<Omit<WorkspaceEntry, "name" | "provenance"> & FileProvenance> {
    const rel = workspaceRelative(path);
    const st = await this.#json<Omit<WorkspaceEntry, "name" | "provenance">>(sandboxId, [
      "stat",
      rel,
    ]);
    const p =
      st.kind === "file" || rel === ""
        ? this.#provenance(sandboxId).lookup(rel)
        : { provenance: "untrusted" as const, sources: [] };
    return rel === "" && st.kind === "dir"
      ? { ...st, provenance: "trusted", sources: [] }
      : { ...st, ...p };
  }

  /**
   * UTF-8 text up to 256 KB; larger or binary files reject with `invalid_params`. The
   * provenance is that of the latest recorded write; a file with no record, or whose content
   * differs from it, is `untrusted` with its sources (design-07).
   */
  async readText(sandboxId: string, path: string): Promise<{ text: string } & FileProvenance> {
    const { bytes, ...provenance } = await this.#read(sandboxId, path, TEXT_FILE_CAP_BYTES);
    try {
      return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), ...provenance };
    } catch {
      return fail("invalid_params", `${path} is not UTF-8 text; use exportFile`);
    }
  }

  /**
   * Atomic replace (temp file + rename). Keeps the mode of an existing file. Records the
   * write's provenance: pass `provenance: "untrusted"` with the turn's `sources` from a
   * tainted turn, `"trusted"` from an untainted one; absent means `untrusted`.
   */
  async writeText(
    sandboxId: string,
    path: string,
    text: string,
    options: WriteOptions = {},
  ): Promise<{ size: number; provenance: ProvenanceOut }> {
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length > TEXT_FILE_CAP_BYTES) {
      fail("invalid_params", `text is larger than ${TEXT_FILE_CAP_BYTES} bytes`);
    }
    return this.#write(sandboxId, path, bytes, TEXT_FILE_CAP_BYTES, options);
  }

  /**
   * Replaces `oldText` with `newText`. It must occur exactly once unless `replaceAll`
   * (`not_found` when absent, `conflict` when ambiguous). Atomic. The edited file takes the
   * provenance of this write (absent means `untrusted`).
   */
  async edit(
    sandboxId: string,
    path: string,
    edit: { oldText: string; newText: string; replaceAll?: boolean },
    options: WriteProvenance = {},
  ): Promise<{ replacements: number; provenance: ProvenanceOut }> {
    if (typeof edit.oldText !== "string" || edit.oldText === "") {
      fail("invalid_params", "oldText must be a non-empty string");
    }
    if (typeof edit.newText !== "string") fail("invalid_params", "newText must be a string");
    const rel = workspaceRelative(path);
    const input = JSON.stringify({ old: edit.oldText, new: edit.newText, all: edit.replaceAll });
    const r = await this.#json<{ replacements: number }>(
      sandboxId,
      ["edit", rel, String(TEXT_FILE_CAP_BYTES)],
      { input },
    );
    // The result's bytes were not seen on the host, so the record carries no hash.
    await this.#provenance(sandboxId).record([rel], options, null);
    return { replacements: r.replacements, provenance: provenanceOf(options) };
  }

  /**
   * Byte-exact copy into the workspace (PDFs, images), up to 10 MB. Downloads and attachments
   * are `untrusted` at birth: pass `provenance: "trusted"` only for the owner's own files.
   */
  async importFile(
    sandboxId: string,
    path: string,
    bytes: Uint8Array,
    options: WriteOptions = {},
  ): Promise<{ size: number; provenance: ProvenanceOut }> {
    if (bytes.length > TRANSFER_FILE_CAP_BYTES) {
      fail("invalid_params", `file is larger than ${TRANSFER_FILE_CAP_BYTES} bytes`);
    }
    return this.#write(sandboxId, path, bytes, TRANSFER_FILE_CAP_BYTES, options);
  }

  /** Byte-exact copy out of the workspace, up to 10 MB, with the file's provenance. */
  async exportFile(
    sandboxId: string,
    path: string,
  ): Promise<{ bytes: Uint8Array } & FileProvenance> {
    return this.#read(sandboxId, path, TRANSFER_FILE_CAP_BYTES);
  }

  async #read(
    sandboxId: string,
    path: string,
    cap: number,
  ): Promise<{ bytes: Uint8Array } & FileProvenance> {
    const rel = workspaceRelative(path);
    const r = await this.#run(sandboxId, ["read", rel, String(cap)], { maxBytes: cap + 1 });
    const bytes = new Uint8Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length);
    return { bytes, ...this.#provenance(sandboxId).lookup(rel, bytes) };
  }

  async #write(
    sandboxId: string,
    path: string,
    bytes: Uint8Array,
    cap: number,
    options: WriteOptions,
  ): Promise<{ size: number; provenance: ProvenanceOut }> {
    const rel = workspaceRelative(path);
    if (rel === "") fail("invalid_params", "path names the workspace root");
    const r = await this.#json<{ size: number }>(
      sandboxId,
      ["write", rel, String(cap), options.createParents ? "1" : "0"],
      { input: bytes },
    );
    await this.#provenance(sandboxId).record([rel], options, sha256Hex(bytes));
    return { size: r.size, provenance: provenanceOf(options) };
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

function provenanceOf(write: WriteProvenance): ProvenanceOut {
  return write.provenance === "trusted" ? "trusted" : "untrusted";
}

export type { TaintSource };

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
