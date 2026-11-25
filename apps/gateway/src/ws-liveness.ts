/** Server ping cadence for WebSocket peers. A peer that misses one round is dropped. */
export const WS_PING_INTERVAL_MS = 20_000;

/** A subscriber whose buffer shows no drain progress for this long is terminated. */
export const STUCK_BUFFER_MS = 30_000;

export interface SlowGuard {
  /** The bus sink: sends, or pauses (drops) events while the socket is backed up. */
  sink: (frame: string) => void;
  /** Call periodically: resumes a drained subscriber (sending the resync marker) or ends a stuck one. */
  check: () => void;
}

/**
 * Wraps an event subscriber's sink. Above `limit` queued bytes, bus frames are paused (dropped;
 * the bus already counted their `seq`, so the client sees a gap). Once the buffer drains to the
 * limit, the last dropped frame is sent as the resync marker: its `seq` gap makes the client
 * refetch through the existing stateVersion resync. If the buffer stays above the limit with no
 * drain progress for `stuckMs`, `onStuck` runs. Replies do not pass through here, so a large
 * reply is never dropped.
 */
export function guardSlowSubscriber(opts: {
  send: (frame: string) => void;
  bufferedAmount: () => number;
  limit: number;
  onStuck: (bufferedBytes: number) => void;
  stuckMs?: number;
  now?: () => number;
}): SlowGuard {
  const now = opts.now ?? (() => Date.now());
  const stuckMs = opts.stuckMs ?? STUCK_BUFFER_MS;
  let paused = false;
  let last: string | null = null;
  let lowest = 0;
  let progressAt = 0;
  let ended = false;
  const check = (): void => {
    if (!paused || ended) return;
    const bytes = opts.bufferedAmount();
    if (bytes <= opts.limit) {
      paused = false;
      if (last !== null) opts.send(last);
      last = null;
    } else if (bytes < lowest) {
      lowest = bytes;
      progressAt = now();
    } else if (now() - progressAt >= stuckMs) {
      ended = true;
      opts.onStuck(bytes);
    }
  };
  const sink = (frame: string): void => {
    if (ended) return;
    if (paused) {
      check();
      if (paused) {
        last = frame;
        return;
      }
    } else if (opts.bufferedAmount() > opts.limit) {
      paused = true;
      lowest = opts.bufferedAmount();
      progressAt = now();
      last = frame;
      return;
    }
    opts.send(frame);
  };
  return { sink, check };
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
