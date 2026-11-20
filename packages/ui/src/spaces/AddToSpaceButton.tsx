import { Diamond } from "lucide-react";
import { type ReactElement, useState } from "react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import { useStore } from "../data/index.ts";
import { put } from "../data/state.ts";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import { NewSpaceDialog } from "./NewSpaceDialog.tsx";
import { useSpaces } from "./use-spaces.ts";

/**
 * "Add to Space…" in a widget's header, next to Pin to Home (docs/design/spaces-2026.md §7.1):
 * the owner's Spaces, then New Space…. It puts the widget on that Space's shelf as a tracker.
 * Not drawn for a widget that is already on a shelf.
 */
export function AddToSpaceButton({
  widgetId,
  spaceId,
}: {
  widgetId: string;
  spaceId: string | null | undefined;
}): ReactElement | null {
  const store = useStore();
  const { spaces } = useSpaces();
  const [creating, setCreating] = useState(false);
  if (spaceId != null) return null;
  const live = spaces.filter((s) => s.archivedAt == null);
  const add = async (target: string, name: string) => {
    try {
      await store.call("spaces.trackers.add", { spaceId: target, widgetId });
      const { widgets } = await store.call("widgets.get", { widgetIds: [widgetId] });
      store.update((s) => widgets.reduce((acc, w) => put(acc, "widgets", w), s));
      toast(t("spaces.add.done", { name }));
    } catch (err) {
      toast.error(t("spaces.add.failed", { reason: describeError(err) }));
    }
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          className="inline-flex size-6 shrink-0 cursor-default items-center justify-center rounded-md outline-none hover:bg-fill-quaternary focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t("spaces.add.label")}
          title={t("spaces.add.label")}
          data-testid="widget-add-to-space"
        >
          <Diamond className="size-3.5" aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          {live.length === 0 ? (
            <DropdownMenuItem disabled>{t("spaces.add.none")}</DropdownMenuItem>
          ) : (
            live.map((s) => (
              <DropdownMenuItem key={s.id} onClick={() => void add(s.id, s.name)}>
                <span className="truncate">{s.name}</span>
              </DropdownMenuItem>
            ))
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setCreating(true)}>
            {t("spaces.add.new")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <NewSpaceDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(id, name) => void add(id, name)}
      />
    </>
  );
}
