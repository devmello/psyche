import { Download } from "lucide-react";
import type { ReactElement } from "react";
import { Button } from "../components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";

export type ExportFormat = "markdown" | "json" | "html";

/** ⋯ → Export: Markdown / JSON / HTML; tool calls collapsed, receipts included (UI design §2.2). */
export function ExportMenu({
  onExport,
}: {
  onExport: (format: ExportFormat) => void;
}): ReactElement {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="sm" aria-label="Export thread" />}>
        <Download aria-hidden="true" /> Export
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onExport("markdown")}>Markdown</DropdownMenuItem>
        <DropdownMenuItem onClick={() => onExport("json")}>JSON</DropdownMenuItem>
        <DropdownMenuItem onClick={() => onExport("html")}>HTML</DropdownMenuItem>
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
