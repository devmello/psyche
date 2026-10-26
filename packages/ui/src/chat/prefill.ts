import { useAui } from "@assistant-ui/react";
import { useEffect } from "react";
import { useStore, useStoreState } from "../data/provider.tsx";
import { useSlots } from "../slots.tsx";

/**
 * Fills the chat composer from elsewhere (Settings → Connectors "Try it", #640): the host's
 * `prefillComposer` slot when it has one (a separate Settings window), else the text waits in the
 * store and the app opens the chat, whose composer takes it. Undefined when neither can reach a
 * chat (a bare story).
 */
export function usePrefillComposer(): ((text: string) => void) | undefined {
  const store = useStore();
  const { prefillComposer, navigate } = useSlots();
  if (prefillComposer) return prefillComposer;
  if (!navigate || store.detached) return undefined;
  return (text) => {
    store.update((s) => ({ ...s, composerPrefill: text }));
    navigate("/chat");
  };
}

/** Takes waiting composer text once the chat is mounted (inside the composer's runtime). */
export function ComposerPrefill(): null {
  const aui = useAui();
  const store = useStore();
  const text = useStoreState((s) => s.composerPrefill);
  useEffect(() => {
    if (text === null) return;
    aui.composer.setText(text);
    store.update((s) => ({ ...s, composerPrefill: null }));
    document.querySelector<HTMLTextAreaElement>("[data-composer-input]")?.focus();
  }, [aui, store, text]);
  return null;
}
