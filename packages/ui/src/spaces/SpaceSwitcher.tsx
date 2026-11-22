import { Check, ChevronDown, Diamond } from "lucide-react";
import { type ReactElement, useState } from "react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import { useStoreState } from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import { useSlots } from "../slots.tsx";
import { NewSpaceDialog } from "./NewSpaceDialog.tsx";
import { useSpaceActions, useSpaces } from "./use-spaces.ts";

/**
 * The chat header's Space switcher (docs/design/spaces-2026.md §7.1). It sits in the title area
 * and never adds a sidebar row. Picking a Space starts a new chat in it; "Move this chat to…"
 * moves the open one (`spaces.threads.move`, from its next run). Drawn once a Space exists, or
 * when the chat is in one.
 */
export function SpaceSwitcher({
  threadId,
  onNavigate,
}: {
  threadId: string | null;
  onNavigate?: (to: string) => void;
}): ReactElement | null {
  const { navigate: slotNavigate } = useSlots();
  const navigate = onNavigate ?? slotNavigate ?? (() => {});
  const actions = useSpaceActions();
  const { spaces } = useSpaces();
  const entry = useStoreState((s) => (threadId === null ? undefined : s.threads[threadId]));
  const [creating, setCreating] = useState(false);
  const live = spaces.filter((s) => s.archivedAt == null);
  const currentId = entry?.thread.spaceId ?? null;
  const current = spaces.find((s) => s.id === currentId) ?? null;
  if (entry === undefined || entry.thread.kind === "incognito") return null;
  if (live.length === 0 && currentId === null) return null;
  // The main chat can start chats in a Space but is never moved into one.
  const movable = entry.thread.kind === "side" && entry.thread.imported === undefined;
  const fail = (err: unknown) =>
    toast.error(t("spaces.switcher.moveFailed", { reason: describeError(err) }));
  const startIn = (spaceId: string) =>
    actions.newChatIn(spaceId).then((id) => navigate(`/chat/${id}`), fail);
  const moveTo = (target: (typeof live)[number] | null) =>
    actions
      .moveThreads([entry.thread.id], target?.id ?? null)
      .then(
        () =>
          toast(
            target === null
              ? t("spaces.switcher.movedOut", { name: current?.name ?? "" })
              : t("spaces.switcher.moved", { name: target.name }),
          ),
        fail,
      );
  const label = current?.name ?? t("spaces.switcher.none");
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          className="inline-flex h-7 min-w-0 max-w-[24ch] shrink cursor-default items-center gap-1 rounded-full px-2.5 text-callout text-label-secondary outline-none transition-colors hover:bg-fill-tertiary hover:text-label-primary focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-fill-secondary [&_svg]:size-3.5 [&_svg]:shrink-0"
          aria-label={t("spaces.switcher.label", { name: label })}
          data-testid="space-switcher"
        >
          <Diamond aria-hidden="true" />
          <span className="truncate">{label}</span>
          <ChevronDown aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-56">
          <DropdownMenuItem onClick={() => navigate("/chat")}>
            {currentId === null ? <Check aria-hidden="true" /> : null}
            {t("spaces.switcher.noneMain")}
          </DropdownMenuItem>
          {live.map((s) => (
            <DropdownMenuItem key={s.id} onClick={() => void startIn(s.id)}>
              {s.id === currentId ? <Check aria-hidden="true" /> : null}
              <span className="truncate">{s.name}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setCreating(true)}>
            {t("spaces.switcher.new")}
          </DropdownMenuItem>
          {movable ? (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>{t("spaces.switcher.move")}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem disabled={currentId === null} onClick={() => void moveTo(null)}>
                  {t("spaces.switcher.none")}
                </DropdownMenuItem>
                {live.map((s) => (
                  <DropdownMenuItem
                    key={s.id}
                    disabled={s.id === currentId}
                    onClick={() => void moveTo(s)}
                  >
                    <span className="truncate">{s.name}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <NewSpaceDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(id) => void startIn(id)}
      />
    </>
  );
}

/**
 * The composer chip (§7.1): which Space the next message goes to. A quiet pill above the
 * composer that opens the Space's page; drawn only for a chat in a Space.
 */
export function SpaceComposerChip({
  threadId,
  onNavigate,
}: {
  threadId: string;
  onNavigate?: (to: string) => void;
}): ReactElement | null {
  const { navigate: slotNavigate } = useSlots();
  const navigate = onNavigate ?? slotNavigate;
  const spaceId = useStoreState((s) => s.threads[threadId]?.thread.spaceId ?? null);
  const { spaces } = useSpaces({ enabled: spaceId !== null });
  const space = spaces.find((s) => s.id === spaceId);
  if (spaceId === null || space === undefined) return null;
  return (
    <div className="flex" data-testid="space-chip">
      <button
        type="button"
        aria-label={t("spaces.composer.label", { name: space.name })}
        onClick={() => navigate?.(`/spaces/${space.id}`)}
        className="inline-flex h-6 max-w-full cursor-default items-center gap-1.5 rounded-full bg-fill-tertiary px-2.5 text-callout text-label-secondary outline-none hover:text-label-primary focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3 [&_svg]:shrink-0"
      >
        <Diamond aria-hidden="true" />
        <span className="truncate">{t("spaces.composer.chip", { name: space.name })}</span>
      </button>
    </div>
  );
}
