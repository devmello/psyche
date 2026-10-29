import type { Provenance } from "@psyche/protocol";

/**
 * Local sources the Gateway can index into the main search index (docs/design/search-roadmap-2026.md
 * §2). Every one is opt-in and off by default; the owner switches each in Settings → Search sources.
 */
export const SOURCE_IDS = ["mail", "messages", "notes", "calendar", "reminders", "files"] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

/** Where text of a source may be processed (cards, future routing): the default is today's behaviour. */
export const PROCESSING_MODELS = ["cloud", "local", "none"] as const;
export type ProcessingModel = (typeof PROCESSING_MODELS)[number];

export interface SourceConfig {
  enabled: boolean;
  /**
   * Which model class may read this source's text. Only `none` has an effect today (no context
   * cards); `cloud` and `local` are recorded for the router to use later.
   */
  processing: ProcessingModel;
  /**
   * Whether the agent's `search_everything` may search this source. On for every source except
   * Messages, which stays owner-only until the owner allows it. The owner's own Search ignores it.
   */
  agent: boolean;
}

/** Things the owner keeps out of the index, matched case-insensitively. */
export interface SourceExclusions {
  /** Email addresses, phone numbers or names; any mail, message or event involving one is skipped. */
  contacts: string[];
  /** Messages chat ids. */
  chats: string[];
  /** Mail accounts. */
  accounts: string[];
  /** Folder paths; files and notes folders under one are skipped. */
  folders: string[];
}

export interface SourcesConfig {
  sources: Record<SourceId, SourceConfig>;
  exclude: SourceExclusions;
}

export const SOURCE_LABELS: Record<SourceId, string> = {
  mail: "Mail",
  messages: "Messages",
  notes: "Notes",
  calendar: "Calendar",
  reminders: "Reminders",
  files: "Files",
};

export function defaultSourcesConfig(): SourcesConfig {
  const sources = {} as Record<SourceId, SourceConfig>;
  for (const id of SOURCE_IDS)
    sources[id] = { enabled: false, processing: "cloud", agent: id !== "messages" };
  return { sources, exclude: { contacts: [], chats: [], accounts: [], folders: [] } };
}

/** Reads a stored config, keeping only well-formed values (anything else is the default). */
export function readSourcesConfig(raw: unknown): SourcesConfig {
  const out = defaultSourcesConfig();
  if (typeof raw !== "object" || raw === null) return out;
  const r = raw as { sources?: Record<string, unknown>; exclude?: Record<string, unknown> };
  for (const id of SOURCE_IDS) {
    const s = r.sources?.[id] as Partial<SourceConfig> | undefined;
    if (s === undefined || typeof s !== "object" || s === null) continue;
    if (s.enabled === true) out.sources[id].enabled = true;
    if (typeof s.agent === "boolean") out.sources[id].agent = s.agent;
    if (PROCESSING_MODELS.includes(s.processing as ProcessingModel))
      out.sources[id].processing = s.processing as ProcessingModel;
  }
  for (const key of ["contacts", "chats", "accounts", "folders"] as const) {
    const v = r.exclude?.[key];
    if (Array.isArray(v))
      out.exclude[key] = [
        ...new Set(
          v
            .filter((x): x is string => typeof x === "string" && x.trim() !== "")
            .map((x) => x.trim()),
        ),
      ].slice(0, 2000);
  }
  return out;
}

/** One record read from a source, before it becomes a search document. */
export interface SourceItem {
  /** Stable id inside the source (message id, event id, file path). */
  nativeId: string;
  title: string;
  text: string;
  /** Sender, for `from:`. */
  from?: string;
  /** Epoch ms: when it was sent, written, starts or is due. */
  createdAt: number;
  updatedAt?: number;
  /** `untrusted` for other people's mail and messages; `owner` for the owner's own content. */
  provenance: Extract<Provenance, "owner" | "untrusted">;
  tags?: string[];
  mime?: string;
  /** Everyone involved (addresses, phone numbers, names), for the exclusion list. */
  parties?: string[];
  chatId?: string;
  account?: string;
  /** Folder path, for the folder exclusion. */
  path?: string;
}

export interface SourcePull {
  items: SourceItem[];
  /** Opaque; handed back on the next pull. */
  cursor: unknown;
  hasMore: boolean;
}

export interface SourceAdapter {
  readonly id: SourceId;
  /** Why the source cannot be read now (no helper, no access), or undefined. */
  unavailable(): string | undefined;
  /** The next page after `cursor` (null = from the start). */
  pull(cursor: unknown, ctx: { signal: AbortSignal; limit: number }): Promise<SourcePull>;
  /**
   * Every native id still present, for the nightly sweep. `complete: false` (the read was partial)
   * keeps the sweep from deleting anything.
   */
  listIds?(signal: AbortSignal): Promise<{ ids: string[]; complete: boolean }>;
}

export type SourceState = "off" | "unavailable" | "idle" | "indexing" | "error";

export interface SourceStatus {
  id: SourceId;
  label: string;
  enabled: boolean;
  processing: ProcessingModel;
  agent: boolean;
  state: SourceState;
  /** Why it cannot run now (`unavailable`) or the last error. */
  detail?: string;
  items: number;
  /** Epoch ms of the last pass that wrote or checked this source. */
  lastIndexedAt?: number;
  /** Text bytes indexed for this source (title, body, extras); FTS roughly doubles it on disk. */
  textBytes: number;
  /** The first pass reached the end of the source. */
  backfilled: boolean;
}

export interface SourcesStatus {
  sources: SourceStatus[];
  exclude: SourceExclusions;
  /** Size of the whole index file, bytes. */
  indexBytes: number;
}
