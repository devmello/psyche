import { toast } from "sonner";
import { useThreads } from "../data/hooks.ts";
import { useStore } from "../data/provider.tsx";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import { useSlots } from "../slots.tsx";

/**
 * "Open as a chat" on an answer in Search (docs/roadmap/future-features.md §1): a new side chat
 * with the answer as the composer's context chip and the question waiting in the composer. The
 * chip carries the answer's opaque id and nothing else: the Gateway holds the answer, reads every
 * source it cites again for this connection and the chat's model when the message is sent, and
 * puts the answer with its citation chips at the start of the chat. The window never sends answer
 * text or ids of sources. Undefined when nothing can open a chat (a detached window, a bare story).
 */
export function useOpenAnswerAsChat():
  | ((answer: { answerId: string; question: string }) => void)
  | undefined {
  const store = useStore();
  const threads = useThreads();
  const { navigate } = useSlots();
  if (!navigate || store.detached) return undefined;
  return ({ answerId, question }) => {
    const asked = question.trim().slice(0, 500);
    threads
      .create({
        kind: "side",
        title: t("chat.sideChat.title", { title: asked.slice(0, 150) }).slice(0, 200),
      })
      .then((thread) => {
        store.update((s) => ({
          ...s,
          composerPrefill: asked,
          composerContext: {
            threadId: thread.id,
            ref: { kind: "life_answer", id: answerId },
            title: t("screens.search.answer.chipTitle", { question: asked.slice(0, 200) }),
            source: t("screens.search.answer.chipSource"),
            url: null,
          },
        }));
        navigate(`/chat/${thread.id}`);
      })
      .catch((err: unknown) => {
        toast.error(t("screens.search.answer.openFailed", { reason: describeError(err) }));
      });
  };
}
