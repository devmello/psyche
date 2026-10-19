import { describeNotifierConformance } from "@psyche/testing/conformance";
import Database from "better-sqlite3";
import { createNotifier, MemoryNotificationStore, SqliteNotificationStore } from "../src/index.ts";

describeNotifierConformance("PsycheNotifier (memory store)", (ctx) =>
  createNotifier({
    clock: ctx.clock,
    newId: () => ctx.ids.next("ntf"),
    store: new MemoryNotificationStore(),
  }),
);

describeNotifierConformance("PsycheNotifier (sqlite store)", (ctx) =>
  createNotifier({
    clock: ctx.clock,
    newId: () => ctx.ids.next("ntf"),
    store: new SqliteNotificationStore(new Database(":memory:"), {
      migrate: true,
      now: () => ctx.clock.iso(),
    }),
  }),
);
