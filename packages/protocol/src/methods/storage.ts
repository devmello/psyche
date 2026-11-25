import { type Static, Type } from "@sinclair/typebox";
import { StringEnum } from "../common.ts";
import { defineMethod } from "./define.ts";

/**
 * `storage.*` (Settings > Data > Storage): how much disk `$PSYCHE_HOME` uses by category, and a
 * safe clear for the two categories Psyche can rebuild or that expire anyway. Nothing that is the
 * owner's data (the database, memory, the Library, vault, browser profiles) can be cleared here:
 * `storage.clearCache` accepts only the clearable targets.
 */

export const StorageCategoryId = StringEnum(
  [
    "database",
    "memoryIndex",
    "library",
    "browserProfiles",
    "recordings",
    "logs",
    "caches",
    "other",
  ],
  { $id: "StorageCategoryId" },
);
export type StorageCategoryId = Static<typeof StorageCategoryId>;

/** The categories `storage.clearCache` may empty. */
export const StorageClearTarget = StringEnum(["caches", "recordings"], {
  $id: "StorageClearTarget",
});
export type StorageClearTarget = Static<typeof StorageClearTarget>;

export const StorageCategory = Type.Object(
  {
    id: StorageCategoryId,
    bytes: Type.Integer({ minimum: 0 }),
    /** True for the categories `storage.clearCache` can empty. */
    clearable: Type.Boolean(),
    /** Clearable categories: the bytes `storage.clearCache` would free now (recordings: only those older than 7 days). */
    reclaimableBytes: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { $id: "StorageCategory" },
);
export type StorageCategory = Static<typeof StorageCategory>;

export const StorageMethods = {
  "storage.usage": defineMethod({
    params: Type.Object({}),
    result: Type.Object(
      {
        categories: Type.Array(StorageCategory),
        totalBytes: Type.Integer({ minimum: 0 }),
        /** True when the walk hit its entry or time cap: the sizes are lower bounds. */
        partial: Type.Optional(Type.Boolean()),
      },
      { $id: "StorageUsage" },
    ),
    scope: "operator.admin",
    description:
      "Disk use under the Gateway's data folder by category (database, memory index, attachments and Library, browser profiles, recordings, logs, caches, other). Sizes only; symbolic links are not followed.",
  }),
  "storage.clearCache": defineMethod({
    params: Type.Object({
      /** Defaults to both. */
      targets: Type.Optional(Type.Array(StorageClearTarget, { minItems: 1, maxItems: 2 })),
    }),
    result: Type.Object(
      {
        cleared: Type.Array(StorageClearTarget),
        freedBytes: Type.Integer({ minimum: 0 }),
      },
      { $id: "StorageCleared" },
    ),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Side-effecting. Empties the rebuildable caches (converted documents and thumbnails) and deletes finished browser recordings older than 7 days together with their Library entries. Recordings still in progress, and every other category, are untouched.",
  }),
  "storage.compactEstimate": defineMethod({
    params: Type.Object({}),
    result: Type.Object(
      {
        /** The database file plus its WAL. */
        dbBytes: Type.Integer({ minimum: 0 }),
        /** `freelist_count x page_size`: the most a compaction can give back. */
        reclaimableBytes: Type.Integer({ minimum: 0 }),
        /** False while a run, task or scheduler run is active: compaction is refused then. */
        idle: Type.Boolean(),
      },
      { $id: "StorageCompactEstimate" },
    ),
    scope: "operator.read",
    description:
      "The database's size, how much a compaction could give back, and whether one can run now.",
  }),
  "storage.compact": defineMethod({
    params: Type.Object({}),
    result: Type.Object(
      {
        durationMs: Type.Integer({ minimum: 0 }),
        savedBytes: Type.Integer({ minimum: 0 }),
      },
      { $id: "StorageCompacted" },
    ),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Side-effecting. Compacts the database (VACUUM, then a WAL checkpoint). Psyche pauses while it runs. Refused with `conflict` while a run, task or scheduled run is active, so none is interrupted.",
  }),
} as const;
