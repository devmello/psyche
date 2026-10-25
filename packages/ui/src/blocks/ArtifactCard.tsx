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
import { activeI18n, t } from "../i18n/core.ts";
import { formatDate } from "../lib/format.ts";
import { cn } from "../lib/utils.ts";

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

const kindLabel = (kind: ArtifactPreviewKind): string => t(`blocks.artifact.kind.${kind}`);

/**
 * The thumbnail when the shell's viewers give none: a small page drawn for the artifact's kind
 * (lines for documents, a grid for sheets, a timeline for itineraries) with the kind's icon, so a
 * card reads as a document rather than a generic glyph.
 */
function Thumbnail({ kind }: { kind: ArtifactPreviewKind }): ReactElement {
  const Icon = ICONS[kind];
  const body =
    kind === "sheet" || kind === "finance" || kind === "dashboard" ? (
      <div className="grid grid-cols-3 gap-0.5">
        {Array.from({ length: 12 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static decoration
          <span key={i} className={cn("h-1.5 rounded-[1px]", i < 3 ? "bg-gray-7" : "bg-gray-5")} />
        ))}
      </div>
    ) : kind === "itinerary" ? (
      <div className="flex flex-col gap-1.5">
        {[0, 1, 2].map((i) => (
          <span key={i} className="flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-accent-8" />
            <span className="h-1 flex-1 rounded-full bg-gray-5" />
          </span>
        ))}
      </div>
    ) : (
      <div className="flex flex-col gap-1">
        <span className="h-1.5 w-3/4 rounded-full bg-gray-7" />
        {[100, 90, 95, 60].map((w) => (
          <span key={w} className="h-1 rounded-full bg-gray-5" style={{ width: `${w}%` }} />
        ))}
      </div>
    );
  return (
    <div className="absolute inset-x-3 top-3 -bottom-2 flex flex-col gap-2 rounded-t-md border border-gray-6 bg-background p-2 shadow-level-2">
      <Icon className="size-4 text-accent-11" />
      {body}
    </div>
  );
}

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
  return (
    <article
      aria-label={t("blocks.artifact.label", { title: artifact.title })}
      className="my-2 flex max-w-md overflow-hidden rounded-lg border border-gray-6 bg-gray-2 psy-enter"
    >
      <div
        className="relative w-28 shrink-0 overflow-hidden border-e border-gray-6 bg-gray-3"
        aria-hidden="true"
      >
        {renderPreview?.({ artifact, kind }) ?? <Thumbnail kind={kind} />}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1 p-3">
        <h3 className="truncate text-h3">{artifact.title}</h3>
        <p className="text-callout text-muted-foreground">
          {t("blocks.artifact.meta", {
            kind: kindLabel(kind),
            version: artifact.version,
            date: formatDate(artifact.updatedAt),
          })}
        </p>
        <div className="mt-1 flex gap-2">
          {onOpen ? (
            <Button size="sm" variant="outline" onClick={() => onOpen(artifact)}>
              {t("blocks.common.open")}
            </Button>
          ) : null}
          {onSave ? (
            <Button size="sm" variant="ghost" onClick={() => onSave(artifact)}>
              {t("blocks.artifact.save")}
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
  const { number } = activeI18n();
  const oneDecimal = { minimumFractionDigits: 1, maximumFractionDigits: 1 };
  if (n < 1024) return t("blocks.artifact.bytes", { size: number(n) });
  if (n < 1024 * 1024)
    return t("blocks.artifact.kilobytes", { size: number(n / 1024, oneDecimal) });
  return t("blocks.artifact.megabytes", { size: number(n / 1024 / 1024, oneDecimal) });
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
      aria-label={t("blocks.artifact.fileLabel", { name: item.name })}
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
              <ShieldAlert className="size-3" aria-hidden="true" />{" "}
              {t("blocks.artifact.quarantined")}
            </span>
          ) : null}
        </p>
      </div>
      {onOpen ? (
        <Button size="sm" variant="outline" onClick={() => onOpen(item)}>
          {t("blocks.common.open")}
        </Button>
      ) : null}
    </article>
  );
}
