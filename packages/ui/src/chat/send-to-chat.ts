import type { LibraryItem } from "@psyche/protocol";
import { toast } from "sonner";
import { useThreads } from "../data/hooks.ts";
import { useStore } from "../data/provider.tsx";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import { useSlots } from "../slots.tsx";
import { classifyFile } from "./attachments.ts";

/**
 * "Send to chat" on a Library item: a new side chat named for the item, with the item waiting in
 * its composer as an attachment (the same chip a picked file gets, so the Gateway reads it the
 * way it reads any attachment). The chip carries the Library id only; nothing the file holds is
 * put into the composer text. Undefined when nothing can open a chat (a detached window, a bare
 * story).
 */

/** Only files the Gateway can read can be attached; audio, video and system files cannot. */
export const canSendToChat = (item: Pick<LibraryItem, "name" | "mime">): boolean =>
  classifyFile({ name: item.name, type: item.mime }) !== null;

export function useSendToChat(): ((item: LibraryItem) => void) | undefined {
  const store = useStore();
  const threads = useThreads();
  const { navigate } = useSlots();
  if (!navigate || store.detached) return undefined;
  return (item) => {
    threads
      .create({
        kind: "side",
        title: t("chat.sideChat.title", { title: item.name.trim().slice(0, 150) }).slice(0, 200),
      })
      .then((thread) => {
        store.update((s) => ({
          ...s,
          composerAttachments: {
            threadId: thread.id,
            items: [{ id: item.id, name: item.name, mime: item.mime, size: item.size }],
          },
        }));
        navigate(`/chat/${thread.id}`);
      })
      .catch((err: unknown) => {
        toast.error(t("screens.search.sideChatFailed", { reason: describeError(err) }));
      });
  };
}
