/**
 * Keeps each Electron `Notification` alive until it is clicked, closed or fails. A notification
 * nothing references can be garbage-collected, and then its click handler never runs. The set
 * is capped so a flood of notifications cannot grow it forever: past the cap the oldest instance
 * is let go (its click may then be lost, but only for a notification that is long gone).
 */
export interface KeepableNotification {
  on(event: "click" | "close" | "failed", listener: () => void): unknown;
  show(): void;
}

export class NotificationKeeper<T extends KeepableNotification> {
  private readonly live = new Set<T>();
  private readonly cap: number;

  constructor(cap = 50) {
    this.cap = cap;
  }

  /** How many instances are still held. */
  get size(): number {
    return this.live.size;
  }

  show(n: T, onClick: () => void): void {
    this.live.add(n);
    if (this.live.size > this.cap) this.live.delete(this.live.values().next().value as T);
    const release = () => {
      this.live.delete(n);
    };
    n.on("click", () => {
      release();
      onClick();
    });
    n.on("close", release);
    n.on("failed", release);
    n.show();
  }
}
