import { Search } from "lucide-react";
import { type ReactElement, useId, useState } from "react";
import { t } from "../../i18n/core.ts";
import type { MessageId } from "../../i18n/messages/index.ts";
import { ConnectorIcon } from "./ConnectorIcon.tsx";
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

const BADGE_TONE = { builtIn: "info", official: "info", community: "neutral" } as const;

function matches(e: GalleryEntry, q: string): boolean {
  const hay = `${e.label} ${e.description} ${t(`gallery.category.${e.category}` as MessageId)}`;
  return hay.toLocaleLowerCase().includes(q);
}

export function ConnectorGallery({ entries }: { entries: readonly GalleryEntry[] }): ReactElement {
  const searchId = useId();
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
      <p className="text-callout text-label-secondary">{t("gallery.intro")}</p>
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
          {t("gallery.noMatch")}
        </p>
      ) : null}
      {groups.map((g) => (
        <section key={g.id} aria-label={t(`gallery.category.${g.id}` as MessageId)}>
          <h3 className="pb-1.5 text-caption text-label-tertiary">
            {t(`gallery.category.${g.id}` as MessageId)}
          </h3>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2">
            {g.items.map((e) => (
              <li key={e.key} className="flex">
                <button
                  type="button"
                  disabled={e.taken === true}
                  onClick={e.onPick}
                  className="flex w-full cursor-default items-start gap-3 rounded-lg border border-separator bg-surface-raised p-3 text-start outline-none transition-colors hover:bg-fill-quaternary focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 disabled:hover:bg-surface-raised"
                >
                  <ConnectorIcon
                    {...(e.type ? { type: e.type } : {})}
                    {...(e.icon ? { icon: e.icon } : {})}
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="text-headline text-label-primary">{e.label}</span>
                      {e.taken ? (
                        <StatusChip tone="success">
                          {t("settings.connectors.status.connected")}
                        </StatusChip>
                      ) : e.badge ? (
                        <StatusChip tone={BADGE_TONE[e.badge]}>
                          {t(`gallery.badge.${e.badge}` as MessageId)}
                        </StatusChip>
                      ) : null}
                    </span>
                    <span className="line-clamp-2 text-callout text-label-secondary">
                      {e.description}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
