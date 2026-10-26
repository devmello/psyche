import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { PsycheError, type ToolCallDescription } from "@psyche/protocol";
import { canonicalJSON, sha256 } from "../framework/binding.ts";
import type {
  CatalogueEntry,
  ConnectInput,
  Connector,
  ConnectorAction,
  ConnectorFactory,
  ConnectorHealth,
  ConnectorRecord,
  ConnectorTool,
  ConnectResult,
  ToolOutput,
} from "../framework/types.ts";

/**
 * Obsidian (docs/connectors/apple-apps-2026.md §5, #639): the vault is a folder the owner shared
 * in Settings → File access, read and written as plain Markdown. No helper, no app, no macOS
 * grant. One connector per vault. Every path is checked by the Gateway's `access` (granted
 * folder, read-only vs read-write, protected roots, no symlinks) before it is touched. Note
 * contents are untrusted.
 */

export interface ObsidianOptions {
  /**
   * Throws unless `path` (absolute, canonical) may be read, or written, now: the Gateway's
   * granted-folder, protected-path and symlink checks (@psyche/files).
   */
  access(path: string, mode: "read" | "write"): Promise<void>;
  /** Today's date as YYYY-MM-DD in the owner's time zone (for the daily note). */
  today?: () => string;
}

const MAX_FILES = 5_000;
const MAX_NOTE_BYTES = 1_000_000;
const SKIP_DIRS = new Set([".obsidian", ".trash", ".git", "node_modules"]);

const ACTIONS: ConnectorAction[] = [
  { id: "obsidian.read", title: "Search and read notes", sideEffect: "read", defaultRule: "allow" },
  {
    id: "obsidian.write",
    title: "Add to and create notes",
    sideEffect: "write",
    approvalKind: "connector_action",
    defaultRule: "ask",
  },
];

export const OBSIDIAN_CATALOGUE: CatalogueEntry = {
  type: "obsidian",
  id: "obsidian",
  label: "Obsidian",
  description:
    "Search and read the notes in an Obsidian vault on your Mac, add to today's daily note, and create notes. Uses the vault folder you share in Settings → File access.",
  category: "first_party",
  vendor: "Obsidian",
  auth: "none",
  scopes: { read: ["vault.read"], read_act: ["vault.read", "vault.write"] },
  actions: ACTIONS,
  setupGuide: "docs/guides/connectors.md#obsidian",
  available: true,
};

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const untrusted = (output: unknown, extra: Partial<ToolOutput> = {}): ToolOutput => ({
  output,
  provenance: "untrusted",
  ...extra,
});

/** A vault-relative note path, refused when it escapes the vault or is not Markdown. */
function notePath(vault: string, rel: unknown, field = "path"): string {
  if (typeof rel !== "string" || rel.trim() === "" || rel.includes("\0")) {
    throw new PsycheError("invalid_params", `${field} is a note path inside the vault`);
  }
  const full = resolve(vault, rel);
  if (full !== vault && !full.startsWith(vault + sep)) {
    throw new PsycheError("forbidden", `${rel} is outside the vault`);
  }
  if (!full.toLowerCase().endsWith(".md")) {
    throw new PsycheError("invalid_params", `${rel} is not a Markdown note (.md)`);
  }
  return full;
}

/** `.obsidian/daily-notes.json`: the daily-note folder (format other than YYYY-MM-DD is not supported). */
async function dailyFolder(vault: string): Promise<string> {
  try {
    const raw = JSON.parse(
      await readFile(join(vault, ".obsidian", "daily-notes.json"), "utf8"),
    ) as {
      folder?: unknown;
    };
    return typeof raw.folder === "string" ? raw.folder.replace(/^\/+|\/+$/g, "") : "";
  } catch {
    return "";
  }
}

async function* markdownFiles(
  root: string,
  dir: string,
  budget: { left: number },
): AsyncGenerator<string> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (budget.left <= 0) return;
    if (e.isSymbolicLink()) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* markdownFiles(root, full, budget);
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
      budget.left -= 1;
      yield full;
    }
  }
}

function snippet(text: string, query: string): string {
  const i = text.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return text.slice(0, 160);
  return text.slice(Math.max(0, i - 80), i + query.length + 80).replace(/\s+/g, " ");
}

class ObsidianConnector implements Connector {
  readonly id: string;
  readonly type = "obsidian";
  readonly #opts: ObsidianOptions;
  #vault: string | null;

  constructor(record: ConnectorRecord, opts: ObsidianOptions) {
    this.id = record.id;
    this.#opts = opts;
    const v = (record.config as Record<string, unknown> | undefined)?.vaultPath;
    this.#vault = typeof v === "string" ? v : null;
  }

  async connect(input: ConnectInput): Promise<ConnectResult> {
    const raw = input.config.vaultPath;
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new PsycheError("invalid_params", "Choose the vault folder (config.vaultPath)", {
        details: { reason: "vault_required" },
      });
    }
    const vault = resolve(raw);
    await this.#opts.access(vault, input.scopeMode === "read_act" ? "write" : "read");
    const isVault = await stat(join(vault, ".obsidian")).then(
      (s) => s.isDirectory(),
      () => false,
    );
    if (!isVault) {
      throw new PsycheError(
        "invalid_params",
        `${vault} is not an Obsidian vault (no .obsidian folder)`,
        {
          details: { reason: "not_a_vault" },
        },
      );
    }
    this.#vault = vault;
    return {
      account: basename(vault),
      scopes: OBSIDIAN_CATALOGUE.scopes[input.scopeMode],
      config: { vaultPath: vault },
    };
  }

  async disconnect(): Promise<void> {}

  actions(): ConnectorAction[] {
    return ACTIONS;
  }

  #root(): string {
    if (this.#vault === null) throw new PsycheError("unavailable", "the vault is not connected");
    return this.#vault;
  }

  tools(): ConnectorTool[] {
    const action = (name: string, params: unknown): ToolCallDescription => ({
      kind: "connector_action",
      target: { kind: "account", value: this.id },
      bindingFields: {
        connectorId: this.id,
        tool: name,
        paramsHash: sha256(canonicalJSON(params ?? {})),
      },
      grantKey: `connector_action:${this.id}:${name}`,
    });
    return [
      {
        name: "obsidian_search",
        action: "obsidian.read",
        description:
          "Find notes in the Obsidian vault by text in their name or content, newest modified first, with a snippet; optionally in one folder. Untrusted.",
        inputSchema: obj(
          {
            query: { type: "string", minLength: 1, maxLength: 200 },
            folder: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 100 },
          },
          ["query"],
        ),
        sideEffect: "read",
        execute: async (p) => {
          const o = (p ?? {}) as { query: string; folder?: string; limit?: number };
          const root = this.#root();
          const base = o.folder ? resolve(root, o.folder) : root;
          if (base !== root && !base.startsWith(root + sep)) {
            throw new PsycheError("forbidden", `${o.folder} is outside the vault`);
          }
          await this.#opts.access(base, "read");
          const q = o.query.toLowerCase();
          const hits: { path: string; title: string; modified: string; snippet: string }[] = [];
          for await (const file of markdownFiles(root, base, { left: MAX_FILES })) {
            const st = await stat(file);
            if (st.size > MAX_NOTE_BYTES) continue;
            const text = await readFile(file, "utf8");
            const title = basename(file, ".md");
            if (!title.toLowerCase().includes(q) && !text.toLowerCase().includes(q)) continue;
            hits.push({
              path: relative(root, file),
              title,
              modified: st.mtime.toISOString(),
              snippet: snippet(text, o.query),
            });
          }
          hits.sort((a, b) => b.modified.localeCompare(a.modified));
          return untrusted({ notes: hits.slice(0, o.limit ?? 20) });
        },
      },
      {
        name: "obsidian_read",
        action: "obsidian.read",
        description:
          "Read one note of the vault by its path (as obsidian_search returns it). Untrusted.",
        inputSchema: obj({ path: { type: "string" } }, ["path"]),
        sideEffect: "read",
        execute: async (p) => {
          const root = this.#root();
          const file = notePath(root, (p as { path?: unknown }).path);
          await this.#opts.access(file, "read");
          const text = await readFile(file, "utf8").catch(() => {
            throw new PsycheError("not_found", `${relative(root, file)} does not exist`);
          });
          const truncated = text.length > 200_000;
          return untrusted({ path: relative(root, file), text: text.slice(0, 200_000), truncated });
        },
      },
      {
        name: "obsidian_append",
        action: "obsidian.write",
        description: "Add text to the end of an existing note of the vault (by path).",
        inputSchema: obj(
          { path: { type: "string" }, text: { type: "string", minLength: 1, maxLength: 100_000 } },
          ["path", "text"],
        ),
        sideEffect: "write",
        describeCall: (p) => action("obsidian_append", p),
        execute: async (p) => {
          const o = p as { path: string; text: string };
          const root = this.#root();
          const file = notePath(root, o.path);
          await this.#opts.access(file, "write");
          const before = await readFile(file, "utf8").catch(() => {
            throw new PsycheError("not_found", `${o.path} does not exist; use obsidian_create`);
          });
          await writeFile(
            file,
            `${before}${before.endsWith("\n") || before === "" ? "" : "\n"}${o.text}\n`,
          );
          return untrusted(
            { path: relative(root, file) },
            { receiptSummary: `Added to ${relative(root, file)}` },
          );
        },
      },
      {
        name: "obsidian_append_daily",
        action: "obsidian.write",
        description:
          "Add text to today's daily note (or date: YYYY-MM-DD), creating it in the vault's daily-notes folder if needed, e.g. a log line or meeting notes.",
        inputSchema: obj(
          {
            text: { type: "string", minLength: 1, maxLength: 100_000 },
            date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          },
          ["text"],
        ),
        sideEffect: "write",
        describeCall: (p) => action("obsidian_append_daily", p),
        execute: async (p) => {
          const o = p as { text: string; date?: string };
          const root = this.#root();
          const date = o.date ?? this.#opts.today?.() ?? new Date().toISOString().slice(0, 10);
          const folder = await dailyFolder(root);
          const file = notePath(root, join(folder, `${date}.md`));
          await this.#opts.access(file, "write");
          const before = await readFile(file, "utf8").catch(() => "");
          await mkdir(dirname(file), { recursive: true });
          await writeFile(
            file,
            `${before}${before.endsWith("\n") || before === "" ? "" : "\n"}${o.text}\n`,
          );
          return untrusted(
            { path: relative(root, file), created: before === "" },
            { receiptSummary: `Added to the daily note ${date}` },
          );
        },
      },
      {
        name: "obsidian_create",
        action: "obsidian.write",
        description:
          "Create a new note in the vault at path (e.g. Meetings/Offsite.md); refused if it exists.",
        inputSchema: obj(
          { path: { type: "string" }, content: { type: "string", maxLength: 100_000 } },
          ["path", "content"],
        ),
        sideEffect: "write",
        describeCall: (p) => action("obsidian_create", p),
        execute: async (p) => {
          const o = p as { path: string; content: string };
          const root = this.#root();
          const file = notePath(root, o.path);
          await this.#opts.access(file, "write");
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, o.content, { flag: "wx" }).catch((err: NodeJS.ErrnoException) => {
            if (err.code === "EEXIST")
              throw new PsycheError("conflict", `${o.path} already exists`);
            throw err;
          });
          return untrusted(
            {
              path: relative(root, file),
              sha256: createHash("sha256").update(o.content).digest("hex"),
            },
            { receiptSummary: `Created ${relative(root, file)}` },
          );
        },
      },
    ];
  }

  async health(): Promise<ConnectorHealth> {
    const checkedAt = Date.now();
    if (this.#vault === null) return { ok: false, status: "error", detail: "no vault", checkedAt };
    try {
      await this.#opts.access(this.#vault, "read");
      return { ok: true, status: "connected", checkedAt };
    } catch (err) {
      return { ok: false, status: "connected", detail: (err as Error).message, checkedAt };
    }
  }
}

/** One connector per vault (not single-instance). */
export function obsidianFactory(opts: ObsidianOptions): ConnectorFactory {
  return { entry: OBSIDIAN_CATALOGUE, create: (record) => new ObsidianConnector(record, opts) };
}
