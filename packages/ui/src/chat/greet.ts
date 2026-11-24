import { useEffect } from "react";

/**
 * Threads this window already asked to greet. Module-level so a StrictMode double effect, a
 * reconnect or a re-render never asks twice; the Gateway's own check (no message yet, no run)
 * stops a second window from greeting again.
 */
const asked = new Set<string>();

/**
 * The main chat opens with the agent's greeting (`chat.greet`, #555). Onboarding asks for it
 * when it finishes, but that call can fail silently (an older Gateway, a model error), which
 * would leave the main chat empty for good. So an empty, connected main chat asks once. A
 * failure stays quiet: the empty state remains and the owner can say hello first.
 */
export function useGreetEmptyMainChat(options: {
  threadId: string;
  kind: string | undefined;
  empty: boolean;
  connected: boolean;
  call: (method: "chat.greet", params: { threadId: string }) => Promise<unknown>;
}): void {
  const { threadId, kind, empty, connected, call } = options;
  const shouldGreet = kind === "main" && empty && connected;
  useEffect(() => {
    if (!shouldGreet || asked.has(threadId)) return;
    asked.add(threadId);
    call("chat.greet", { threadId }).catch(() => {
      // Quiet by design: the empty state stays. A retry needs a reload of this window.
    });
  }, [shouldGreet, threadId, call]);
}
