import { ArrowDown, ArrowUp, Plus } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "../components/ui/button.tsx";
import { useStore } from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import { useNow } from "../lib/use-now.ts";
import { ScreenToolbar } from "../screens/feed/ScreenToolbar.tsx";
import { useSlots } from "../slots.tsx";
import { SpaceRow } from "./HomeSpacesSection.tsx";
import { NewSpaceDialog } from "./NewSpaceDialog.tsx";
import { spaceHref, useSpaces } from "./use-spaces.ts";

export interface SpacesScreenProps {
  onNavigate?: (to: string) => void;
  /** `/spaces?new=1`: the New Space dialog is open on arrival. */
  startAdding?: boolean;
  /** `/spaces#archived`: scrolls the archived Spaces into view. */
  anchor?: string;
  now?: number;
}

/**
 * `/spaces` (docs/design/spaces-2026.md §7.1): every Space as a row, in the owner's order, with
 * Archived at the end. Off the sidebar: it is reached from Home's "All Spaces" and from ⌘K. The
 * order changes with the move buttons, which also work from the keyboard.
 */
export function SpacesScreen({
  onNavigate,
  startAdding = false,
  anchor,
  now: fixedNow,
}: SpacesScreenProps): ReactElement {
  const { navigate: slotNavigate } = useSlots();
  const navigate = onNavigate ?? slotNavigate ?? (() => {});
  const store = useStore();
  const now = useNow(60_000, fixedNow);
  const live = useSpaces();
  const archived = useSpaces({ archived: true });
  const [adding, setAdding] = useState(startAdding);
  useEffect(() => {
    if (anchor === "archived") document.getElementById("archived")?.scrollIntoView?.();
  }, [anchor]);

  const move = async (index: number, by: -1 | 1) => {
    const order = [...live.spaces];
    const other = order[index + by];
    const self = order[index];
    if (other === undefined || self === undefined) return;
    order[index] = other;
    order[index + by] = self;
    try {
      // Only the rows whose place changed are written.
      await Promise.all(
        order.flatMap((s, i) =>
          s.sort === i + 1 ? [] : [store.call("spaces.update", { spaceId: s.id, sort: i + 1 })],
        ),
      );
      live.reload();
    } catch (err) {
      toast.error(describeError(err));
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="spaces-screen">
      <ScreenToolbar
        title={t("spaces.list.title")}
        actions={
          <Button type="button" size="sm" onClick={() => setAdding(true)}>
            <Plus aria-hidden="true" />
            {t("spaces.new")}
          </Button>
        }
      />
      <div className="mx-auto flex w-full max-w-[calc(720px+3rem)] flex-col gap-8 px-4 pt-4 pb-16 md:px-6">
        {live.spaces.length === 0 && !live.loading ? (
          <p className="px-1 text-body text-label-secondary" data-testid="spaces-empty">
            {t("spaces.list.empty")}
          </p>
        ) : (
          <ul
            aria-label={t("spaces.list.label")}
            className="flex flex-col rounded-lg bg-surface-raised p-1 shadow-elevation-1"
          >
            {live.spaces.map((space, i) => (
              <li key={space.id} className="flex items-center gap-1">
                <div className="min-w-0 flex-1">
                  <SpaceRow space={space} now={now} onOpen={(s) => navigate(spaceHref(s.id))} />
                </div>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  disabled={i === 0}
                  aria-label={t("spaces.list.moveUp", { name: space.name })}
                  onClick={() => void move(i, -1)}
                >
                  <ArrowUp aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  disabled={i === live.spaces.length - 1}
                  aria-label={t("spaces.list.moveDown", { name: space.name })}
                  onClick={() => void move(i, 1)}
                >
                  <ArrowDown aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        {archived.spaces.length > 0 ? (
          <section id="archived" aria-labelledby="archived-heading" className="flex flex-col gap-3">
            <h2 id="archived-heading" className="px-1 text-title-3 text-label-primary">
              {t("spaces.list.archived")}
            </h2>
            <ul
              aria-label={t("spaces.list.archived")}
              className="flex flex-col rounded-lg bg-surface-raised p-1 shadow-elevation-1"
            >
              {archived.spaces.map((space) => (
                <li key={space.id}>
                  <SpaceRow space={space} now={now} onOpen={(s) => navigate(spaceHref(s.id))} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
      <NewSpaceDialog
        open={adding}
        onOpenChange={setAdding}
        onCreated={(id) => navigate(spaceHref(id))}
      />
    </div>
  );
}
