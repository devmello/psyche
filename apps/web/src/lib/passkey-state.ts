/**
 * Tells every window of this app that this computer's passkeys changed (one was added or removed
 * in Settings), so a card in the main window stops saying "Answer on <host>" without a reload.
 * Windows of one app share the origin, so a `BroadcastChannel` reaches them; where there is none
 * (tests, old engines) the same-window listeners still hear it.
 */

const NAME = "psyche-passkeys";
const listeners = new Set<() => void>();
let channel: BroadcastChannel | null | undefined;

function chan(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  channel =
    typeof BroadcastChannel === "function"
      ? (() => {
          const c = new BroadcastChannel(NAME);
          c.onmessage = () => {
            for (const l of listeners) l();
          };
          return c;
        })()
      : null;
  return channel;
}

export function notifyPasskeysChanged(): void {
  for (const l of listeners) l();
  chan()?.postMessage("changed");
}

export function onPasskeysChanged(cb: () => void): () => void {
  chan();
  listeners.add(cb);
  return () => listeners.delete(cb);
}
