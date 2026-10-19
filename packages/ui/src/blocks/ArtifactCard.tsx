import type { Artifact, LibraryItem } from "@psyche/protocol";
import {
  FileText,
  Globe,
  Image as ImageIcon,
  LayoutDashboard,
  Mail,
  Map as MapIcon,
  ShieldAlert,
  Table,
  Wallet,
} from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { Button } from "../components/ui/button.tsx";
import { formatDate } from "../lib/format.ts";

/** Preview kinds the artifact block names in `preview` (data model §9.1). */
export type ArtifactPreviewKind =
  | "email"
  | "file"
  | "browser"
  | "pdf"
  | "finance"
  | "itinerary"
  | "sheet"
  | "html"
  | "markdown"
  | "dashboard";

/**
 * Slot the shell fills with `packages/viewers` (S13): the kit never renders untrusted documents
 * itself. It gets the artifact or library item and returns a thumbnail or a preview.
 */
export type PreviewSlot = (target: {
  artifact?: Artifact;
  item?: LibraryItem;
  kind: ArtifactPreviewKind;
}) => ReactNode;

const ICONS: Record<ArtifactPreviewKind, typeof FileText> = {
  email: Mail,
  file: FileText,
  browser: Globe,
  pdf: FileText,
  finance: Wallet,
  itinerary: MapIcon,
  sheet: Table,
  html: Globe,
  markdown: FileText,
  dashboard: LayoutDashboard,
};

export function previewKindOf(artifact: Artifact, preview?: string): ArtifactPreviewKind {
  if (preview !== undefined && preview in ICONS) return preview as ArtifactPreviewKind;
  switch (artifact.type) {
    case "pdf":
      return "pdf";
    case "sheet":
      return "sheet";
    case "itinerary":
      return "itinerary";
    case "dashboard":
      return "dashboard";
    case "html":
    case "react":
      return "html";
    default:
      return "markdown";
  }
}

export interface ArtifactCardProps {
  artifact: Artifact;
  preview?: string;
  renderPreview?: PreviewSlot;
  onOpen?: (artifact: Artifact) => void;
  onSave?: (artifact: Artifact) => void;
}

/** Artifact card (UI design §3.2): title, type, thumbnail, Open, Save to Library. */
export function ArtifactCard({
  artifact,
  preview,
  renderPreview,
  onOpen,
  onSave,
}: ArtifactCardProps): ReactElement {
  const kind = previewKindOf(artifact, preview);
  const Icon = ICONS[kind];
  return (
    <article
      aria-label={`Artifact: ${artifact.title}`}
      className="my-2 flex max-w-md overflow-hidden rounded-lg border border-gray-6 bg-gray-2 psy-enter"
    >
      <div className="flex w-24 shrink-0 items-center justify-center bg-gray-3" aria-hidden="true">
        {renderPreview?.({ artifact, kind }) ?? <Icon className="size-8 text-gray-9" />}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1 p-3">
        <h3 className="truncate text-sm font-semibold">{artifact.title}</h3>
        <p className="text-xs text-muted-foreground">
          {kind} · v{artifact.version} · {formatDate(artifact.updatedAt)}
        </p>
        <div className="mt-1 flex gap-2">
          {onOpen ? (
            <Button size="sm" variant="outline" onClick={() => onOpen(artifact)}>
              Open
            </Button>
          ) : null}
          {onSave ? (
            <Button size="sm" variant="ghost" onClick={() => onSave(artifact)}>
              Save to Library
            </Button>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function iconForMime(mime: string) {
  if (mime.startsWith("image/")) return ImageIcon;
  if (mime.includes("sheet") || mime.includes("csv")) return Table;
  return FileText;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** A Library file in the transcript (file block). Downloads stay quarantined until opened. */
export function FileCard({
  item,
  renderPreview,
  onOpen,
}: {
  item: LibraryItem;
  renderPreview?: PreviewSlot;
  onOpen?: (item: LibraryItem) => void;
}): ReactElement {
  const Icon = iconForMime(item.mime);
  return (
    <article
      aria-label={`File: ${item.name}`}
      className="my-2 flex max-w-md items-center gap-3 rounded-lg border border-gray-6 bg-gray-2 p-2 psy-enter"
    >
      <div
        className="flex size-10 shrink-0 items-center justify-center rounded-md bg-gray-3"
        aria-hidden="true"
      >
        {renderPreview?.({ item, kind: "file" }) ?? <Icon className="size-5 text-gray-9" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{item.name}</p>
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          {formatBytes(item.size)} · {item.origin}
          {item.quarantined ? (
            <span className="inline-flex items-center gap-0.5 text-approval-text">
              <ShieldAlert className="size-3" aria-hidden="true" /> quarantined
            </span>
          ) : null}
        </p>
      </div>
      {onOpen ? (
        <Button size="sm" variant="outline" onClick={() => onOpen(item)}>
          Open
        </Button>
      ) : null}
    </article>
  );
}
