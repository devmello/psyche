import type { LibraryItem } from "@psyche/protocol";
import { t } from "../../i18n/core.ts";

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
    get label() {
      return t("screens.library.section.documents");
    },
    kinds: ["document", "audio", "video", "recording"],
    get empty() {
      return t("screens.library.empty.documents");
    },
  },
  {
    id: "images",
    get label() {
      return t("screens.library.section.images");
    },
    kinds: ["image"],
    get empty() {
      return t("screens.library.empty.images");
    },
  },
  {
    id: "artifacts",
    get label() {
      return t("screens.library.section.artifacts");
    },
    kinds: ["artifact"],
    get empty() {
      return t("screens.library.empty.artifacts");
    },
  },
  {
    id: "downloads",
    get label() {
      return t("screens.library.section.downloads");
    },
    kinds: ["download"],
    get empty() {
      return t("screens.library.empty.downloads");
    },
  },
  {
    id: "system",
    get label() {
      return t("screens.library.section.system");
    },
    kinds: ["system"],
    get empty() {
      return t("screens.library.empty.system");
    },
  },
];

export function sectionOf(item: LibraryItem): LibrarySection {
  return LIBRARY_SECTIONS.find((s) => s.kinds.includes(item.kind))?.id ?? "documents";
}

export const KIND_LABEL: Record<LibraryItem["kind"], string> = {
  get document() {
    return t("screens.library.kind.document");
  },
  get image() {
    return t("screens.library.kind.image");
  },
  get audio() {
    return t("screens.library.kind.audio");
  },
  get video() {
    return t("screens.library.kind.video");
  },
  get artifact() {
    return t("screens.library.kind.artifact");
  },
  get download() {
    return t("screens.library.kind.download");
  },
  get recording() {
    return t("screens.library.kind.recording");
  },
  get system() {
    return t("screens.library.kind.system");
  },
};

/** A coarse file type for the type filter, from the mime type and extension. */
export function fileType(item: LibraryItem): string {
  const ext = /\.([a-z0-9]+)$/i.exec(item.name)?.[1]?.toLowerCase();
  if (item.mime === "application/pdf" || ext === "pdf") return "PDF";
  if (item.mime === "text/markdown" || ext === "md") return "Markdown";
  if (item.mime.startsWith("image/")) return t("screens.library.type.image");
  if (item.mime === "text/html" || ext === "html") return "HTML";
  if (item.mime.endsWith("+json") || item.mime === "application/json")
    return t("screens.library.type.data");
  if (item.mime.startsWith("audio/")) return t("screens.library.type.audio");
  if (item.mime.startsWith("video/")) return t("screens.library.type.video");
  return ext ? ext.toUpperCase() : t("screens.library.type.file");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return t("screens.library.bytes", { n: bytes });
  const kb = bytes / 1024;
  // One decimal under 10 ("9.5 KB"), whole numbers above ("180 KB").
  if (kb < 1024)
    return kb < 10
      ? t("screens.library.kbSmall", { n: Math.round(kb * 10) / 10 })
      : t("screens.library.kb", { n: Math.round(kb) });
  const mb = kb / 1024;
  return mb < 10
    ? t("screens.library.mbSmall", { n: Math.round(mb * 10) / 10 })
    : t("screens.library.mb", { n: Math.round(mb) });
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
  {
    id: "any",
    get label() {
      return t("screens.library.date.any");
    },
    ms: Number.POSITIVE_INFINITY,
  },
  {
    id: "today",
    get label() {
      return t("screens.library.date.today");
    },
    ms: 24 * 3600_000,
  },
  {
    id: "week",
    get label() {
      return t("screens.library.date.week");
    },
    ms: 7 * 24 * 3600_000,
  },
  {
    id: "month",
    get label() {
      return t("screens.library.date.month");
    },
    ms: 30 * 24 * 3600_000,
  },
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
