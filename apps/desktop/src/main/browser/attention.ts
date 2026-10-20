/**
 * The desktop's half of pause-when-unwatched (security §7.2 item 5, #272): tells the Gateway
 * whether the browser pane is on screen and, throttled, that the owner gave input in the app
 * (`attention.report {pane: "browser", visible, input?}`, S01's method). The Gateway keeps the
 * state; the browser tools refuse to act on sensitive origins without it.
 *
 * Visibility goes out on every change, input at most once per `inputEveryMs` (default 30 s, well
 * inside the 5-minute window), and both again after a reconnect. A Gateway without the method
 * answers `unknown_method`, which is ignored.
 */
export interface AttentionReport {
  pane: "browser";
  visible: boolean;
  input?: boolean;
}

export interface AttentionReporterOptions {
  send(report: AttentionReport): Promise<unknown>;
  now?(): number;
  inputEveryMs?: number;
}

export interface AttentionReporter {
  /** The pane was shown or hidden (the window minimized, hidden or the pane closed). */
  visible(visible: boolean): void;
  /** The owner pressed a key or clicked somewhere in the app. */
  input(): void;
  /** The Gateway connection came (back): send the current state again. */
  resend(): void;
}

export function createAttentionReporter(o: AttentionReporterOptions): AttentionReporter {
  const now = () => o.now?.() ?? Date.now();
  const every = o.inputEveryMs ?? 30_000;
  let visible = false;
  let known = false;
  let lastInputSent = Number.NEGATIVE_INFINITY;
  const send = (report: AttentionReport) => void o.send(report).catch(() => undefined);
  return {
    visible(v) {
      if (known && v === visible) return;
      known = true;
      visible = v;
      send({ pane: "browser", visible });
    },
    input() {
      const t = now();
      if (t - lastInputSent < every) return;
      lastInputSent = t;
      send({ pane: "browser", visible, input: true });
    },
    resend() {
      if (!known) return;
      send({ pane: "browser", visible });
    },
  };
}
