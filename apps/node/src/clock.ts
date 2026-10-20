/**
 * Gateway-aligned clock. The Gateway is the time authority for approvals and receipts; a node
 * in a VM that just resumed, or a remote box without NTP, can be minutes off. `paired` carries
 * `serverTime`, and every later timestamp the node produces is corrected by the measured skew.
 */
export class SkewClock {
  readonly #now: () => number;
  #offsetMs = 0;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Server time minus local time, in ms (positive when the local clock is behind). */
  get offsetMs(): number {
    return this.#offsetMs;
  }

  /**
   * Records `serverTime` observed at the end of a round trip that started at `sentAtMs`
   * (local). Uses the midpoint, the usual NTP-style estimate.
   */
  observe(serverTimeIso: string, sentAtMs: number): void {
    const server = Date.parse(serverTimeIso);
    if (Number.isNaN(server)) return;
    const received = this.#now();
    const midpoint = sentAtMs + (received - sentAtMs) / 2;
    this.#offsetMs = Math.round(server - midpoint);
  }

  nowMs(): number {
    return this.#now() + this.#offsetMs;
  }

  now(): Date {
    return new Date(this.nowMs());
  }

  iso(): string {
    return this.now().toISOString();
  }
}
