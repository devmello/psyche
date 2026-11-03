import { Search } from "lucide-react";
import { type ReactElement, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { t } from "../../i18n/core.ts";
import type { MessageId } from "../../i18n/messages/index.ts";
import { ConnectorIcon } from "./ConnectorIcon.tsx";
import { useSubheading } from "./ConnectorRow.tsx";
import type { PresetCategory, PresetIcon } from "./mcp-preset-build.ts";
import { StatusChip } from "./shared.tsx";

/**
 * The Add connector gallery: built-in connectors, ready-made MCP servers and a custom one, as tiles
 * grouped by what they are for, with a search box. Picking a tile opens its connect form.
 */

export type GalleryGroup = "popular" | PresetCategory | "custom";

export const GALLERY_ORDER: readonly GalleryGroup[] = [
  "popular",
  "files",
  "dev",
  "productivity",
  "comms",
  "web",
  "everyday",
  "finance",
  "custom",
];

export interface GalleryEntry {
  /** Unique across the gallery. */
  key: string;
  label: string;
  description: string;
  group: GalleryGroup;
  /** Where it also shows when searching (its own category, for a popular tile). */
  category: GalleryGroup;
  type?: string;
  icon?: PresetIcon;
  badge: "builtIn" | "official" | "community" | null;
  /** Already connected (one per machine). */
  taken?: boolean;
  onPick: () => void;
}

function matches(e: GalleryEntry, q: string): boolean {
  const hay = `${e.label} ${e.description} ${t(`gallery.category.${e.category}` as MessageId)}`;
  return hay.toLocaleLowerCase().includes(q);
}

export function ConnectorGallery({ entries }: { entries: readonly GalleryEntry[] }): ReactElement {
  const searchId = useId();
  const Heading = useSubheading();
  const [query, setQuery] = useState("");
  const q = query.trim().toLocaleLowerCase();
  // Searching lists each match once, in its own category; "Popular" is the unsearched front page.
  const shown = q === "" ? entries : entries.filter((e) => e.group !== "popular" && matches(e, q));
  const groups = GALLERY_ORDER.map((g) => ({
    id: g,
    items: shown.filter((e) => (q === "" ? e.group === g : e.category === g)),
  })).filter((g) => g.items.length > 0);
  return (
    <div className="flex flex-col gap-4">
      <p className="text-callout text-label-secondary">
        {t("settings.connectors.page.gallery.intro")}
      </p>
      <div className="relative">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute start-3 top-1/2 size-3.5 -translate-y-1/2 text-label-tertiary"
        />
        <input
          id={searchId}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("gallery.search")}
          aria-label={t("gallery.search")}
          className="h-8 w-full rounded-md bg-fill-tertiary ps-8 pe-2 text-body text-label-primary outline-none placeholder:text-label-tertiary focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      {groups.length === 0 ? (
        <p role="status" className="py-6 text-center text-callout text-label-secondary">
          {t("settings.connectors.page.gallery.noMatch")}
        </p>
      ) : null}
      {groups.map((g) => (
        <section key={g.id} aria-label={t(`gallery.category.${g.id}` as MessageId)}>
          <Heading className="pb-1.5 text-caption text-label-tertiary">
            {t(`gallery.category.${g.id}` as MessageId)}
          </Heading>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2">
            {g.items.map((e) => (
              <li key={e.key} className="flex">
                <GalleryTile entry={e} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** One tile: icon, name, a line about it. Already-added ones are disabled and say so. */
export function GalleryTile({ entry: e }: { entry: GalleryEntry }): ReactElement {
  return (
    <button
      type="button"
      disabled={e.taken === true}
      onClick={e.onPick}
      className="flex w-full cursor-default items-start gap-3 rounded-lg border border-separator bg-surface-raised p-3 text-start outline-none transition-colors duration-(--duration-micro) hover:bg-fill-quaternary focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 disabled:hover:bg-surface-raised"
    >
      <ConnectorIcon {...(e.type ? { type: e.type } : {})} {...(e.icon ? { icon: e.icon } : {})} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-headline text-label-primary">{e.label}</span>
          {e.taken ? (
            <StatusChip tone="success">{t("settings.connectors.status.connected")}</StatusChip>
          ) : e.badge === "community" ? (
            <StatusChip tone="neutral">
              {t("settings.connectors.page.gallery.community")}
            </StatusChip>
          ) : null}
        </span>
        <span className="line-clamp-2 text-callout text-label-secondary">{e.description}</span>
      </span>
    </button>
  );
}

/** How many suggestions "Add more" shows before "Browse all". */
const SUGGESTED = 4;

/**
 * "Add more" on the page's list: a few things worth connecting next (built-in ones first, then the
 * popular ready-made tools) and a way into the whole gallery. Nothing here is connected yet.
 */
export function AddMore({
  entries,
  onBrowse,
}: {
  entries: readonly GalleryEntry[];
  onBrowse: () => void;
}): ReactElement | null {
  const id = useId();
  const Heading = useSubheading();
  const open = entries.filter((e) => e.taken !== true && e.group !== "custom");
  const suggested = [
    ...open.filter((e) => e.badge === "builtIn"),
    ...open.filter((e) => e.group === "popular"),
  ].slice(0, SUGGESTED);
  if (suggested.length === 0) return null;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2 px-1">
        <Heading id={id} className="min-w-0 flex-1 text-title-3 text-label-primary">
          {t("settings.connectors.page.addMore")}
        </Heading>
        <Button type="button" variant="ghost" size="sm" onClick={onBrowse}>
          {t("settings.connectors.page.addMore.browse")}
        </Button>
      </div>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2">
        {suggested.map((e) => (
          <li key={e.key} className="flex">
            <GalleryTile entry={e} />
          </li>
        ))}
      </ul>
      <p className="px-1 text-callout text-label-secondary">
        {t("settings.connectors.page.addMore.hint")}
      </p>
    </section>
  );
}
