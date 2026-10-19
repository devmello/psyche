import { type Static, Type } from "@sinclair/typebox";
import { IsoDateTime, StringEnum } from "../common.ts";
import { defineMethod } from "./define.ts";

/**
 * `logs.*` (feature U5; architecture §14): the Gateway's structured logs for the in-app log
 * viewer. Lines carry metadata only (ids, method names, codes, sizes), never message bodies,
 * params or secrets, which is why `operator.read` is enough. The files are the same ones
 * `psyche logs` tails (`$PSYCHE_HOME/logs/gateway*.log`).
 */

export const LogLevel = StringEnum(["debug", "info", "warn", "error"], { $id: "LogLevel" });
export type LogLevel = Static<typeof LogLevel>;

export const LogLine = Type.Object(
  {
    ts: IsoDateTime,
    level: LogLevel,
    /** Subsystem that wrote the line (`gateway`, `agent`, `browser`, …) when known. */
    subsystem: Type.Optional(Type.String({ maxLength: 64 })),
    msg: Type.String(),
    /** Structured fields of the line (everything except ts, level, msg, subsystem). */
    fields: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { $id: "LogLine" },
);
export type LogLine = Static<typeof LogLine>;

export const LogsMethods = {
  "logs.tail": defineMethod({
    params: Type.Object({
      /** Newest lines to return after filtering (default 200). */
      lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
      /** Minimum level (default `debug`, i.e. everything the Gateway kept). */
      level: Type.Optional(LogLevel),
      subsystem: Type.Optional(Type.String({ maxLength: 64 })),
      /** Only lines at or after this time. */
      since: Type.Optional(IsoDateTime),
      /** Case-insensitive substring over msg and the JSON of fields. */
      search: Type.Optional(Type.String({ maxLength: 256 })),
    }),
    result: Type.Object({
      lines: Type.Array(LogLine),
      /** Every subsystem seen in the scanned files, for the filter menu. */
      subsystems: Type.Array(Type.String()),
      /** `true` when older matching lines exist beyond the requested count. */
      truncated: Type.Boolean(),
    }),
    scope: "operator.read",
    description:
      "Returns the newest matching log lines, oldest first, with the subsystems seen. No bodies or secrets.",
  }),
} as const;
