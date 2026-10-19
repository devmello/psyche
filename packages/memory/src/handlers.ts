import { statSync } from "node:fs";
import { join } from "node:path";
import { type MethodParams, type MethodResult, PsycheError } from "@psyche/protocol";
import { parseDailyNote } from "./daily.ts";
import { exportMemory } from "./export.ts";
import { confirmClaim, importMemory, importOpenClaw } from "./importer.ts";
import { dailyNoteDate } from "./layout.ts";
import { normalizeWorkspacePath } from "./paths.ts";
import {
  applyPersonaChange,
  interpretPersonaInstruction,
  type PersonaChange,
  type PersonaModel,
  readPersona,
} from "./persona-edit.ts";
import type { SqliteMemoryStore } from "./store.ts";

/**
 * `memory.*` method handlers for the Gateway (S01). The caller is a paired device that already
 * passed scope checks, i.e. the owner: writes here are owner writes (no approval card, owner
 * provenance). Params arrive validated against the protocol schemas.
 */

type MemoryMethod =
  | "memory.search"
  | "memory.read"
  | "memory.write"
  | "memory.files.list"
  | "memory.daily.list"
  | "memory.claims.list"
  | "memory.claims.confirm"
  | "memory.explain"
  | "memory.forget"
  | "memory.remember"
  | "memory.import"
  | "memory.export"
  | "memory.reset"
  | "memory.status"
  | "memory.pause"
  | "memory.persona.get"
  | "memory.persona.edit";

export type MemoryHandlers = {
  [M in MemoryMethod]: (params: MethodParams<M>) => Promise<MethodResult<M>>;
};

export const MEMORY_METHODS: readonly MemoryMethod[] = [
  "memory.search",
  "memory.read",
  "memory.write",
  "memory.files.list",
  "memory.daily.list",
  "memory.claims.list",
  "memory.claims.confirm",
  "memory.explain",
  "memory.forget",
  "memory.remember",
  "memory.import",
  "memory.export",
  "memory.reset",
  "memory.status",
  "memory.pause",
  "memory.persona.get",
  "memory.persona.edit",
];

function updatedAt(store: SqliteMemoryStore, path: string): string {
  return new Date(statSync(join(store.root, ...path.split("/"))).mtimeMs).toISOString();
}

export interface MemoryHandlerOptions {
  /** Utility model for `memory.persona.edit { instruction }` (H9). */
  persona?: PersonaModel;
}

export function createMemoryHandlers(
  store: SqliteMemoryStore,
  options: MemoryHandlerOptions = {},
): MemoryHandlers {
  return {
    async "memory.search"(p) {
      const hits = await store.search(p.query, {
        ...(p.limit === undefined ? {} : { limit: p.limit }),
        ...(p.provenance === undefined ? {} : { provenance: p.provenance }),
        ...(p.sources === undefined ? {} : { sources: p.sources }),
      });
      return { hits };
    },

    async "memory.read"(p) {
      const file = await store.readFile(p.path);
      if (file === undefined) throw new PsycheError("not_found", `${p.path} does not exist`);
      let content = file.content;
      if (p.lineStart !== undefined || p.lineEnd !== undefined) {
        const lines = content.split("\n");
        content = lines.slice((p.lineStart ?? 1) - 1, p.lineEnd ?? lines.length).join("\n");
      }
      return { path: file.path, content, etag: file.etag, updatedAt: updatedAt(store, file.path) };
    },

    async "memory.write"(p) {
      let content = p.content;
      if (p.mode === "append") {
        const current = await store.readFile(p.path);
        const base = current?.content ?? "";
        content = base.length === 0 || base.endsWith("\n") ? base + content : `${base}\n${content}`;
      }
      const written = await store.writeFileAsOwner(p.path, content, {
        ...(p.etag === undefined ? {} : { etag: p.etag }),
      });
      return {
        path: written.path,
        bytes: Buffer.byteLength(written.content),
        etag: written.etag,
        updatedAt: updatedAt(store, written.path),
      };
    },

    async "memory.files.list"(p) {
      const prefix = p.prefix === undefined || p.prefix === "" ? "" : p.prefix;
      if (prefix !== "") normalizeWorkspacePath(prefix.replace(/\/+$/, ""));
      return { files: await store.listFileInfo(prefix) };
    },

    async "memory.daily.list"(p) {
      const limit = p.limit ?? 30;
      const notes = [];
      const paths = (await store.listFiles("memory/"))
        .filter((path) => dailyNoteDate(path) !== undefined)
        .sort()
        .reverse();
      for (const path of paths) {
        const date = dailyNoteDate(path) as string;
        if (p.before !== undefined && date >= p.before) continue;
        const file = await store.readFile(path);
        if (file === undefined) continue;
        notes.push({
          date,
          path,
          entries: parseDailyNote(file.content).length,
          bytes: Buffer.byteLength(file.content),
        });
        if (notes.length >= limit) break;
      }
      return { notes };
    },

    async "memory.claims.list"(p) {
      return {
        claims: await store.listClaims({ includeRetracted: p.includeRetracted === true }),
      };
    },

    async "memory.claims.confirm"(p) {
      return { claim: await confirmClaim(store, p.claimId) };
    },

    async "memory.explain"(p) {
      const explained = await store.explain(p.claimId);
      if (explained === undefined) throw new PsycheError("not_found", "no such claim");
      return explained;
    },

    async "memory.forget"(p) {
      const r = await store.forget(p.subject, { dryRun: p.dryRun === true });
      return {
        retractedClaimIds: r.retractedClaimIds,
        removedChunkIds: r.removedChunkIds,
        files: r.files ?? [],
      };
    },

    async "memory.remember"(p) {
      return store.appendDailyNote({ text: p.text, provenance: "owner" });
    },

    async "memory.import"(p) {
      const dryRun = p.dryRun === true;
      if (p.format === "openclaw") {
        if (p.files === undefined) throw new PsycheError("invalid_params", "openclaw needs files");
        return importOpenClaw(store, p.files, { dryRun });
      }
      if (p.content === undefined) throw new PsycheError("invalid_params", "content is required");
      return importMemory(store, p.format, p.content, { dryRun });
    },

    async "memory.export"() {
      const { filename, data } = await exportMemory(store);
      return {
        filename,
        mime: "application/zip",
        data: Buffer.from(data).toString("base64"),
        bytes: data.byteLength,
      };
    },

    async "memory.reset"(p) {
      return store.reset({ dryRun: p.dryRun === true });
    },

    async "memory.status"() {
      return store.status();
    },

    async "memory.pause"(p) {
      return { paused: store.setPaused(p.paused) };
    },

    async "memory.persona.get"() {
      return readPersona(store);
    },

    async "memory.persona.edit"(p) {
      let change: PersonaChange = {};
      if (p.instruction !== undefined) {
        if (options.persona === undefined) {
          throw new PsycheError("unavailable", "no utility model is configured for persona edits");
        }
        change = await interpretPersonaInstruction(
          options.persona,
          p.instruction,
          await readPersona(store),
        );
      }
      const fields = { ...change.fields, ...stripUndefined(p.fields ?? {}) };
      const description = p.description ?? change.description;
      return applyPersonaChange(
        store,
        { fields, ...(description === undefined ? {} : { description }) },
        { actor: "owner", ...(p.etag === undefined ? {} : { etag: p.etag }) },
      );
    },
  };
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) if (typeof v === "string") out[k] = v;
  return out;
}
