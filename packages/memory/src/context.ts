import { stripComments } from "./chunker.ts";
import { formatEntry, parseDailyNote } from "./daily.ts";
import { BUDGETS, dailyNotePath } from "./layout.ts";
import { type Identity, parseIdentity } from "./persona.ts";
import type { SqliteMemoryStore } from "./store.ts";
import { previousDate } from "./support.ts";

/**
 * Context assembly input (architecture §4.2 step 3): the persona files under hard character
 * budgets (20k per file, 60k total, 4k for `USER.md`) with visible markers for truncated and
 * missing files, plus today's and yesterday's daily notes for the owner's private sessions.
 * HTML comments (template guidance for the owner) are stripped before measuring.
 */

/** Which files a session sees (templates/README.md "Injected into the prompt"). */
export type SessionKind = "private" | "delegated" | "shared";

const FILES_BY_SESSION: Record<SessionKind, readonly string[]> = {
  // MEMORY.md only in the owner's private sessions, never group or delegated (architecture §4.8).
  private: ["SOUL.md", "IDENTITY.md", "AGENTS.md", "USER.md", "MEMORY.md", "BOOTSTRAP.md"],
  delegated: ["SOUL.md", "IDENTITY.md", "AGENTS.md"],
  shared: ["IDENTITY.md", "AGENTS.md"],
};

/** Files whose absence is normal and gets no marker. */
const OPTIONAL = new Set(["BOOTSTRAP.md"]);

export interface BootstrapOptions {
  session?: SessionKind;
  budgets?: { perFile?: number; total?: number; user?: number };
  /** Include today's and yesterday's notes (private sessions only). Default true. */
  dailyNotes?: boolean;
  /**
   * Include `untrusted` daily-note entries in the injected notes. Default false: they stay
   * searchable through `memory_search` (which taints the turn) but are not put in the prompt.
   */
  includeUntrusted?: boolean;
}

export interface InjectedFile {
  path: string;
  /** Characters after stripping comments, before truncation. */
  chars: number;
  truncated: boolean;
  missing: boolean;
  /** Text as injected, including any marker. */
  text: string;
}

export interface BootstrapContext {
  files: InjectedFile[];
  dailyNotes: InjectedFile[];
  /** Persona block ready for the system prompt. */
  text: string;
  /** Daily-notes block (placed after tool definitions by context assembly). */
  dailyText: string;
  /** Characters of persona file content injected (markers excluded). */
  totalChars: number;
  identity?: Identity;
}

export function missingMarker(path: string): string {
  return `[missing file: ${path} does not exist in the workspace. The owner can create it in Soul & Memory.]`;
}

export function withheldMarker(path: string): string {
  return `[withheld: ${path} contains untrusted content and is not injected. The owner can review it in Soul & Memory.]`;
}

export function truncationMarker(path: string, chars: number, shown: number, why: string): string {
  return `[truncated: ${path} has ${chars.toLocaleString("en-US")} characters; the first ${shown.toLocaleString("en-US")} are shown (${why}). The full file is in the workspace.]`;
}

/** Cuts at most `max` UTF-16 units without splitting a surrogate pair. */
function cut(text: string, max: number): string {
  let out = text.slice(0, Math.max(0, max));
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

function wrap(path: string, body: string): string {
  const safe = body.replace(/<\/\s*workspace_file\s*>/gi, "&lt;/workspace_file>");
  return `<workspace_file path="${path}">\n${safe}\n</workspace_file>`;
}

export async function bootstrapContext(
  store: SqliteMemoryStore,
  options: BootstrapOptions = {},
): Promise<BootstrapContext> {
  const session = options.session ?? "private";
  const perFile = options.budgets?.perFile ?? BUDGETS.perFile;
  const userBudget = options.budgets?.user ?? BUDGETS["USER.md"];
  let remaining = options.budgets?.total ?? BUDGETS.total;
  let injected = 0;
  const files: InjectedFile[] = [];
  let identity: Identity | undefined;

  for (const path of FILES_BY_SESSION[session]) {
    const file = await store.readFile(path);
    if (file === undefined) {
      if (!OPTIONAL.has(path)) {
        files.push({ path, chars: 0, truncated: false, missing: true, text: missingMarker(path) });
      }
      continue;
    }
    if (store.contentProvenance(path) === "untrusted") {
      // Defence in depth: untrusted text is never placed in the persona block.
      files.push({ path, chars: 0, truncated: false, missing: false, text: withheldMarker(path) });
      continue;
    }
    if (path === "IDENTITY.md") identity = parseIdentity(file.content).identity;
    const body = stripComments(file.content)
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    const fileBudget = path === "USER.md" ? userBudget : perFile;
    const budget = Math.min(fileBudget, remaining);
    let text = body;
    let truncated = false;
    if (body.length > budget) {
      const why =
        budget < fileBudget
          ? "the total persona budget is used up"
          : `the ${path === "USER.md" ? "USER.md" : "per-file"} budget is ${fileBudget.toLocaleString("en-US")}`;
      text = `${cut(body, budget)}\n${truncationMarker(path, body.length, budget, why)}`;
      truncated = true;
    }
    remaining -= Math.min(body.length, budget);
    injected += Math.min(body.length, budget);
    files.push({ path, chars: body.length, truncated, missing: false, text });
  }

  const dailyNotes: InjectedFile[] = [];
  if (session === "private" && options.dailyNotes !== false) {
    const today = store.now().date;
    for (const date of [previousDate(today), today]) {
      const path = dailyNotePath(date);
      const file = await store.readFile(path);
      if (file === undefined) continue;
      const lines = parseDailyNote(file.content)
        .filter((e) => options.includeUntrusted === true || e.provenance !== "untrusted")
        .map((e) => formatEntry(e.time ?? "--:--", e.tag ?? { provenance: "agent" }, e.text));
      const body = lines.join("\n");
      const truncated = body.length > perFile;
      const text = truncated
        ? `${cut(body, perFile)}\n${truncationMarker(path, body.length, perFile, "the per-file budget")}`
        : body;
      dailyNotes.push({ path, chars: body.length, truncated, missing: false, text });
    }
  }

  return {
    files,
    dailyNotes,
    text: files.map((f) => wrap(f.path, f.text)).join("\n\n"),
    dailyText: dailyNotes.map((f) => wrap(f.path, f.text)).join("\n\n"),
    totalChars: injected,
    ...(identity === undefined ? {} : { identity }),
  };
}
