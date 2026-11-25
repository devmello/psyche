import { describe, expect, it } from "vitest";
import { NotificationKeeper } from "../src/lib/notify-keep.ts";

/** A stand-in for Electron's Notification: it fires the events a test asks for. */
class FakeNotification {
  private readonly listeners = new Map<string, () => void>();
  shown = 0;
  on(event: string, listener: () => void): this {
    this.listeners.set(event, listener);
    return this;
  }
  show(): void {
    this.shown++;
  }
  fire(event: "click" | "close" | "failed"): void {
    this.listeners.get(event)?.();
  }
}

describe("NotificationKeeper", () => {
  it("holds an instance until it is clicked, then runs the click once", () => {
    const keep = new NotificationKeeper<FakeNotification>();
    const n = new FakeNotification();
    let clicks = 0;
    keep.show(n, () => clicks++);
    expect(n.shown).toBe(1);
    expect(keep.size).toBe(1);
    n.fire("click");
    expect(clicks).toBe(1);
    expect(keep.size).toBe(0);
  });

  it("releases an instance when it is closed or fails, without running the click", () => {
    const keep = new NotificationKeeper<FakeNotification>();
    const closed = new FakeNotification();
    const failed = new FakeNotification();
    let clicks = 0;
    keep.show(closed, () => clicks++);
    keep.show(failed, () => clicks++);
    expect(keep.size).toBe(2);
    closed.fire("close");
    failed.fire("failed");
    expect(keep.size).toBe(0);
    expect(clicks).toBe(0);
  });

  it("caps the set, dropping the oldest instance first", () => {
    const keep = new NotificationKeeper<FakeNotification>(3);
    const all = Array.from({ length: 5 }, () => new FakeNotification());
    for (const n of all) keep.show(n, () => {});
    expect(keep.size).toBe(3);
    // The two oldest are no longer held; the newest three still are.
    expect(all[0]?.shown).toBe(1);
    all[4]?.fire("click");
    expect(keep.size).toBe(2);
  });
});
