/** Server ping cadence for WebSocket peers. A peer that misses one round is dropped. */
export const WS_PING_INTERVAL_MS = 20_000;

/**
 * Wraps an event subscriber's sink: once the peer's socket has more than `limit` bytes queued, the
 * frame is not sent and `onOverflow` runs (it terminates the connection; the client reconnects
 * and resyncs through `stateVersion`). Frames after the overflow are dropped too.
 */
export function guardSlowSubscriber(opts: {
  send: (frame: string) => void;
  bufferedAmount: () => number;
  limit: number;
  onOverflow: (bufferedBytes: number) => void;
}): (frame: string) => void {
  let dropped = false;
  return (frame) => {
    if (dropped) return;
    const bytes = opts.bufferedAmount();
    if (bytes > opts.limit) {
      dropped = true;
      opts.onOverflow(bytes);
      return;
    }
    opts.send(frame);
  };
}

/** The slice of a `ws` socket the liveness check needs. */
export interface PingableSocket {
  ping(): void;
  terminate(): void;
  on(event: "pong" | "message", listener: () => void): unknown;
}

/**
 * Pings the peer every `intervalMs`. Any pong or message since the last tick counts as alive;
 * if nothing came, `onDead` runs and the socket is terminated (the `close` event then runs the
 * normal cleanup). A phone that slept or lost Wi-Fi never sends a FIN, so without this its
 * socket stays subscribed and frames pile up. Browsers, URLSession and `ws` answer pings with
 * a pong on their own. Returns a stop function. `intervalMs <= 0` disables it.
 */
export function watchLiveness(
  ws: PingableSocket,
  intervalMs: number,
  onDead: () => void,
): () => void {
  if (intervalMs <= 0) return () => {};
  let alive = true;
  const mark = () => {
    alive = true;
  };
  ws.on("pong", mark);
  ws.on("message", mark);
  const timer = setInterval(() => {
    if (!alive) {
      clearInterval(timer);
      try {
        onDead();
      } finally {
        ws.terminate();
      }
      return;
    }
    alive = false;
    try {
      ws.ping();
    } catch {
      // A socket that cannot take a ping is not open; the missed pong ends it next tick.
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
