import type { GraphEntityDetail } from "@psyche/protocol";
import { toast } from "sonner";
import { useThreads } from "../data/hooks.ts";
import { useStore } from "../data/provider.tsx";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import { useSlots } from "../slots.tsx";

/**
 * "Continue in chat" on a Memory page (docs/design/memory-everything-2026.md §7.1 W4): a new side
 * chat opened with the item as the composer's context chip and a fixed question waiting in the
 * composer. The chip carries the item's **id only**: the Gateway reads the item itself, decides
 * whether its title is the owner's and whether the turn starts tainted, so a send after reading
 * third-party text asks first (`taint:floor`). Nothing the item holds is interpolated into the
 * composer text, so a mail subject cannot become an owner message with one click.
 */

const WORK_KINDS: ReadonlySet<string> = new Set(["project", "assignment", "event"]);

/** Only work items continue in chat: the agent reads them with `work_status`. */
export const canContinueInChat = (kind: string): boolean => WORK_KINDS.has(kind);

export interface ContinueItem {
  id: string;
  /** Shown on the chip as plain data. */
  name: string;
  kind: GraphEntityDetail["entity"]["kind"];
  /**
   * The title is the owner's own words: a work item the owner named (not a tracked suggestion)
   * whose status, deadline and progress did not come from third-party text. Only then does the new chat take the title as its name.
   */
  titleTrusted: boolean;
}

/** Same rule the Gateway applies (`memoryItemContext`); the Gateway's answer is the one that counts. */
export function continueItemOf(detail: GraphEntityDetail): ContinueItem {
  const { entity, facts } = detail;
  const work = WORK_KINDS.has(entity.kind);
  const untrusted = facts.some(
    (f) =>
      f.provenance === "untrusted" &&
      (f.attribute === "deadline" || f.attribute === "status" || f.attribute === "progress"),
  );
  return {
    id: entity.id,
    name: entity.name,
    kind: entity.kind,
    // W4: the owner's own title only. A tracked suggestion's name stays third-party text.
    titleTrusted: work && entity.titleUntrusted !== true && !untrusted,
  };
}

/** The question waiting in the composer: fixed words, never the item's text. */
export function continuePrefill(item: Pick<ContinueItem, "kind">): string {
  return t(
    WORK_KINDS.has(item.kind) ? "memory.page.continue.prefillWork" : "memory.page.continue.prefill",
  );
}

/** Undefined when nothing can open a chat (a detached window, a bare story). */
export function useContinueInChat(): ((item: ContinueItem) => void) | undefined {
  const store = useStore();
  const threads = useThreads();
  const { navigate } = useSlots();
  if (!navigate || store.detached) return undefined;
  return (item) => {
    const title = item.titleTrusted
      ? t("chat.sideChat.title", { title: item.name.trim().slice(0, 150) })
      : t("memory.page.continue.threadTitle");
    threads
      .create({ kind: "side", title: title.slice(0, 200) })
      .then((thread) => {
        store.update((s) => ({
          ...s,
          composerPrefill: continuePrefill(item),
          composerContext: {
            threadId: thread.id,
            ref: { kind: "memory_entity", id: item.id },
            title: item.name.trim().slice(0, 300),
            source: t("memory.page.continue.source"),
            url: null,
          },
        }));
        navigate(`/chat/${thread.id}`);
      })
      .catch((err: unknown) => {
        toast.error(t("memory.page.continue.failed", { reason: describeError(err) }));
      });
  };
}
