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
import { activeI18n, t } from "../i18n/core.ts";
import { formatDate } from "../lib/format.ts";
import { cn } from "../lib/utils.ts";
import { Card, type CardAction } from "./card.tsx";

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
  const Icon = ICONS[kind];
  const actions: CardAction[] = [];
  if (onSave)
    actions.push({
      id: "save",
      label: t("blocks.artifact.save"),
      kind: "send",
      onSelect: () => onSave(artifact),
    });
  if (onOpen)
    actions.push({
      id: "open",
      label: t("blocks.common.open"),
      kind: "open",
      primary: true,
      onSelect: () => onOpen(artifact),
    });
  return (
    <Card
      label={t("blocks.artifact.label", { title: artifact.title })}
      icon={<Icon />}
      title={artifact.title}
      meta={t("blocks.artifact.meta", {
        kind: kindLabel(kind),
        version: artifact.version,
        date: formatDate(artifact.updatedAt),
      })}
      actions={actions}
      className="max-w-md"
    >
      <div
        className="relative mt-2 h-24 overflow-hidden rounded-md bg-fill-tertiary"
        aria-hidden="true"
      >
        {renderPreview?.({ artifact, kind }) ?? <Thumbnail kind={kind} />}
      </div>
    </Card>
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
    <Card
      label={t("blocks.artifact.fileLabel", { name: item.name })}
      icon={renderPreview?.({ item, kind: "file" }) ?? <Icon />}
      title={item.name}
      meta={`${formatBytes(item.size)} · ${item.origin}`}
      actions={
        onOpen
          ? [
              {
                id: "open",
                label: t("blocks.common.open"),
                kind: "open",
                primary: true,
                onSelect: () => onOpen(item),
              },
            ]
          : []
      }
      className="max-w-md"
    >
      {item.quarantined ? (
        <p className="inline-flex items-center gap-1 text-callout text-approval-text">
          <ShieldAlert className="size-3" aria-hidden="true" /> {t("blocks.artifact.quarantined")}
        </p>
      ) : undefined}
    </Card>
  );
}
