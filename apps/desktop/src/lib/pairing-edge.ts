/**
 * Runs `onPaired` when the Gateway connection becomes paired and `onUnpaired` when it stops
 * being paired, and nothing in between. The connection reports its status on every health check
 * (every 10 s) as well as on real changes; work tied to pairing (re-arming dictation, reading
 * settings) must not repeat on each tick, or a call the Gateway refuses, such as
 * `dictation.watch` with the helper offline, fails every 10 s.
 */
export function pairingEdge(handlers: {
  onPaired: () => void;
  onUnpaired: () => void;
}): (status: { phase: string }) => void {
  let paired = false;
  return (status) => {
    const now = status.phase === "paired";
    if (now && !paired) handlers.onPaired();
    else if (!now && paired) handlers.onUnpaired();
    paired = now;
  };
}
