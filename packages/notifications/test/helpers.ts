import type { Notification, Surface } from "@psyche/protocol";
import { FakeClock, FakeNodeClient } from "@psyche/testing";
import Database from "better-sqlite3";
import {
  createNotifier,
  type DeliveryOutcome,
  MemoryNotificationStore,
  type NotificationStore,
  type NotifierOptions,
  SqliteNotificationStore,
  type SurfaceAdapter,
} from "../src/index.ts";

/** A recording adapter whose outcome tests can script per call. */
export class RecordingAdapter implements SurfaceAdapter {
  readonly name: string;
  readonly calls: { id: string; surface: Surface; attempt: number; title: string }[] = [];
  outcomes: DeliveryOutcome[] = [];
  #match: (s: Surface) => boolean;

  constructor(name: string, match: (s: Surface) => boolean) {
    this.name = name;
    this.#match = match;
  }

  handles(surface: Surface): boolean {
    return this.#match(surface);
  }

  async deliver(
    n: Notification,
    ctx: { surface: Surface; attempt: number },
  ): Promise<DeliveryOutcome> {
    this.calls.push({ id: n.id, surface: ctx.surface, attempt: ctx.attempt, title: n.title });
    return this.outcomes.shift() ?? { status: "delivered" };
  }
}

export function memoryStore(): NotificationStore {
  return new MemoryNotificationStore();
}

export function sqliteStore(
  db: Database.Database = new Database(":memory:"),
  migrate = true,
): { store: SqliteNotificationStore; db: Database.Database } {
  return { store: new SqliteNotificationStore(db, { migrate }), db };
}

export function setup(options: Partial<NotifierOptions> & { store?: NotificationStore } = {}) {
  const clock = new FakeClock();
  const os = new RecordingAdapter("os", (s) => s === "notification");
  const chat = new RecordingAdapter("chat", (s) => s.includes(":"));
  let n = 0;
  const notifier = createNotifier({
    clock,
    newId: () => `ntf_${String(++n).padStart(3, "0")}`,
    adapters: [os, chat],
    ...options,
  });
  return { clock, os, chat, notifier };
}

export function helperNode(): FakeNodeClient {
  return new FakeNodeClient().handle({
    capability: { name: "notify.show", sideEffect: "none" },
    handle: () => ({ shown: true }),
  });
}
