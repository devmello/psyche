import {
  Bot,
  Building2,
  CalendarDays,
  Database,
  FolderKanban,
  ListChecks,
  type LucideIcon,
  Mail,
  MapPin,
  MessageCircle,
  Phone,
  ShieldAlert,
  Sparkles,
  StickyNote,
  UserRound,
} from "lucide-react";
import type { ReactElement } from "react";
import { t } from "../i18n/core.ts";
import { formatDate } from "../lib/format.ts";
import { cn } from "../lib/utils.ts";
import type {
  GraphEntityKind,
  GraphInteractionKind,
  GraphProvenance,
  GraphSourceRef,
} from "./types.ts";

/** Up to two initials: "Sam Lee" → "SL", "Acme" → "A". */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.[0] ?? "?";
  const last = words.length > 1 ? (words.at(-1)?.[0] ?? "") : "";
  return `${first}${last}`.toUpperCase();
}

const KIND_ICON: Partial<Record<GraphEntityKind, LucideIcon>> = {
  org: Building2,
  project: FolderKanban,
  place: MapPin,
};

/**
 * A person's monogram or the glyph for an org, project or place (redesign §6.4: 20 px in rows).
 * People are circles; orgs, projects and places are rounded squares so kinds read at a glance.
 */
export function EntityMonogram({
  kind,
  name,
  size = 20,
  className,
}: {
  kind: GraphEntityKind;
  name: string;
  size?: 20 | 32 | 40;
  className?: string;
}): ReactElement {
  const Icon = KIND_ICON[kind];
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center bg-fill-secondary font-semibold text-label-secondary",
        kind === "person" ? "rounded-full" : "rounded-md",
        size === 20 && "size-5 text-[9px]",
        size === 32 && "size-8 text-[12px]",
        size === 40 && "size-10 text-[15px]",
        className,
      )}
    >
      {Icon ? (
        <Icon className={size === 20 ? "size-3" : size === 32 ? "size-4" : "size-5"} />
      ) : (
        initials(name)
      )}
    </span>
  );
}

export const INTERACTION_ICON: Record<GraphInteractionKind, LucideIcon> = {
  mail: Mail,
  message: MessageCircle,
  meeting: CalendarDays,
  call: Phone,
  note: StickyNote,
  chat: Bot,
  task: ListChecks,
};

const PROVENANCE_ICON: Record<GraphProvenance, LucideIcon> = {
  owner: UserRound,
  agent: Sparkles,
  untrusted: ShieldAlert,
  system: Database,
};

/** Who a fact or loop came from, as a 12 px glyph with its name for assistive tech. */
export function ProvenanceGlyph({
  provenance,
  className,
}: {
  provenance: GraphProvenance;
  className?: string;
}): ReactElement {
  const Icon = PROVENANCE_ICON[provenance];
  const label = t(`people.provenance.${provenance}`);
  return (
    <span className={cn("inline-flex shrink-0", className)} title={label}>
      <Icon
        className={cn(
          "size-3",
          provenance === "untrusted" ? "text-approval-text" : "text-label-tertiary",
        )}
        aria-hidden="true"
      />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * Where something came from, in words: "Contacts", "mail, Oct 12", "you, Oct 3", or for a claim
 * inside someone else's message "From Sam Lee's mail, Oct 12" (spec §6.5).
 */
export function sourceText(source: GraphSourceRef | undefined | null, untrusted = false): string {
  if (!source) return "";
  const name = t(`people.source.${source.kind}`);
  const date = source.at ? formatDate(source.at) : null;
  if (untrusted && source.from) {
    return t("people.source.fromSender", { name: source.from, source: name, date: date ?? "" });
  }
  return date ? t("people.source.withDate", { source: name, date }) : name;
}
