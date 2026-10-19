import type { LibraryItem } from "@psyche/protocol";

/** Library sections (UI design §3.12) and the item kinds each one shows. */
export type LibrarySection = "documents" | "images" | "artifacts" | "downloads" | "system";

export const LIBRARY_SECTIONS: readonly {
  id: LibrarySection;
  label: string;
  kinds: readonly LibraryItem["kind"][];
  empty: string;
}[] = [
  {
    id: "documents",
    label: "Documents",
    kinds: ["document", "audio", "video", "recording"],
    empty: "No documents yet. Files the agent makes or receives land here.",
  },
  {
    id: "images",
    label: "Images",
    kinds: ["image"],
    empty: "No images yet. Screenshots and pictures from chats land here.",
  },
  {
    id: "artifacts",
    label: "Artifacts",
    kinds: ["artifact"],
    empty: "No artifacts yet. Plans, itineraries and reports the agent builds land here.",
  },
  {
    id: "downloads",
    label: "Downloads",
    kinds: ["download"],
    empty: "No downloads. Files the agent downloads wait here until you open them.",
  },
  {
    id: "system",
    label: "System files",
    kinds: ["system"],
    empty: "No system files yet. They appear once the workspace is set up.",
  },
];

export function sectionOf(item: LibraryItem): LibrarySection {
  return LIBRARY_SECTIONS.find((s) => s.kinds.includes(item.kind))?.id ?? "documents";
}

export const KIND_LABEL: Record<LibraryItem["kind"], string> = {
  document: "Document",
  image: "Image",
  audio: "Audio",
  video: "Video",
  artifact: "Artifact",
  download: "Download",
  recording: "Recording",
  system: "System file",
};

/** A coarse file type for the type filter, from the mime type and extension. */
export function fileType(item: LibraryItem): string {
  const ext = /\.([a-z0-9]+)$/i.exec(item.name)?.[1]?.toLowerCase();
  if (item.mime === "application/pdf" || ext === "pdf") return "PDF";
  if (item.mime === "text/markdown" || ext === "md") return "Markdown";
  if (item.mime.startsWith("image/")) return "Image";
  if (item.mime === "text/html" || ext === "html") return "HTML";
  if (item.mime.endsWith("+json") || item.mime === "application/json") return "Data";
  if (item.mime.startsWith("audio/")) return "Audio";
  if (item.mime.startsWith("video/")) return "Video";
  return ext ? ext.toUpperCase() : "File";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** Workspace path for the editor: `system/SOUL.md` → `SOUL.md`. */
export function workspacePath(item: LibraryItem): string {
  return item.path.replace(/^system\//, "");
}

/** Audit months are read-only (§3.12). */
export function isReadOnly(item: LibraryItem): boolean {
  return item.kind === "system" && /(^|\/)audit/i.test(item.path);
}

export type DateFilter = "any" | "today" | "week" | "month";

export const DATE_FILTERS: readonly { id: DateFilter; label: string; ms: number }[] = [
  { id: "any", label: "Any time", ms: Number.POSITIVE_INFINITY },
  { id: "today", label: "Last 24 hours", ms: 24 * 3600_000 },
  { id: "week", label: "Last 7 days", ms: 7 * 24 * 3600_000 },
  { id: "month", label: "Last 30 days", ms: 30 * 24 * 3600_000 },
];

export interface LibraryFilters {
  type: string | null;
  taskId: string | null;
  date: DateFilter;
}

export const NO_FILTERS: LibraryFilters = { type: null, taskId: null, date: "any" };

export function applyFilters(
  items: readonly LibraryItem[],
  filters: LibraryFilters,
  now: number,
): LibraryItem[] {
  const window = DATE_FILTERS.find((d) => d.id === filters.date)?.ms ?? Number.POSITIVE_INFINITY;
  return items.filter(
    (i) =>
      (filters.type === null || fileType(i) === filters.type) &&
      (filters.taskId === null || i.taskId === filters.taskId) &&
      now - Date.parse(i.createdAt) <= window,
  );
}
