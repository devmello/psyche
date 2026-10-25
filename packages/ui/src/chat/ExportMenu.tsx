import { Download } from "lucide-react";
import { type ReactElement, useCallback } from "react";
import { Button } from "../components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import { useCall, useStoreState } from "../data/index.ts";
import { t } from "../i18n/core.ts";

export type ExportFormat = "markdown" | "json" | "html";

/** ⋯ → Export: Markdown / JSON / HTML; tool calls collapsed, receipts included (UI design §2.2). */
export function ExportMenu({
  onExport,
}: {
  onExport: (format: ExportFormat) => void;
}): ReactElement {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="sm" aria-label={t("chat.export.label")} />}
      >
        <Download aria-hidden="true" /> {t("chat.export.button")}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onExport("markdown")}>
          {t("chat.export.markdown")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onExport("json")}>
          {t("chat.export.json")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onExport("html")}>
          {t("chat.export.html")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Minimal standalone HTML around exported Markdown (no scripts, escaped). */
export function markdownToHtmlDocument(title: string, markdown: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title></head><body><pre style="white-space:pre-wrap;font:15px/22px system-ui">${esc(markdown)}</pre></body></html>`;
}

/** Saves `content` as a file through a temporary link (no-op where blobs can't be made). */
export function downloadFile(filename: string, mime: string, content: string): void {
  if (typeof URL.createObjectURL !== "function") return;
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * The toolbar's ⋯ → Export (redesign-2026 §5.2): Markdown and JSON from `chat.export`, HTML as
 * the Markdown in a standalone escaped document. Resolves when the file has been handed over.
 */
export function useThreadExport(threadId: string): (format: ExportFormat) => Promise<void> {
  const call = useCall();
  const title = useStoreState((s) => s.threads[threadId]?.thread.title ?? "");
  return useCallback(
    async (format: ExportFormat) => {
      const json = format === "json";
      const res = await call("chat.export", { threadId, format: json ? "json" : "markdown" });
      const base = (title || "thread").replace(/[^\w.-]+/g, "-").slice(0, 60);
      if (format === "html") {
        downloadFile(`${base}.html`, "text/html", markdownToHtmlDocument(title, res.content));
        return;
      }
      downloadFile(`${base}.${json ? "json" : "md"}`, res.mime, res.content);
    },
    [call, threadId, title],
  );
}
