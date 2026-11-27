import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger, LogLevel } from "../src/log.ts";
import {
  failureFields,
  uncaughtExceptionHandler,
  unhandledRejectionHandler,
} from "../src/process-errors.ts";

interface Line {
  level: LogLevel;
  msg: string;
  fields: Record<string, string | number | boolean | null>;
}

function recorder(): { log: Logger; lines: Line[] } {
  const lines: Line[] = [];
  const log: Logger = {
    log(level, msg, fields = {}) {
      lines.push({ level, msg, fields });
    },
  };
  return { log, lines };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("process-level failure handlers", () => {
  it("an unhandled rejection is logged at error level and does not exit the process", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const { log, lines } = recorder();
    const handler = unhandledRejectionHandler(log);
    const err = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    expect(() => handler(err)).not.toThrow();
    expect(exit).not.toHaveBeenCalled();
    expect(lines).toEqual([
      {
        level: "error",
        msg: "unhandled promise rejection",
        fields: { code: "SQLITE_BUSY", message: "database is locked" },
      },
    ]);
  });

  it("a non-Error rejection logs its kind only, never its value", () => {
    const { log, lines } = recorder();
    unhandledRejectionHandler(log)({ text: "the owner's private note" });
    expect(lines).toHaveLength(1);
    expect(JSON.stringify(lines)).not.toContain("private note");
    expect(lines[0]?.fields).toEqual({ code: "none", message: "non-error object value" });
  });

  it("an uncaught exception is logged, then runs the graceful shutdown once", () => {
    const { log, lines } = recorder();
    const shutdown = vi.fn();
    const handler = uncaughtExceptionHandler(log, shutdown);
    handler(Object.assign(new Error("boom"), { code: "ERR_X" }));
    expect(lines.map((l) => l.level)).toEqual(["error"]);
    expect(lines[0]?.fields).toEqual({ code: "ERR_X", message: "boom" });
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledWith("uncaughtException");
  });

  it("the logged message is cut so a long error text cannot flood the log", () => {
    expect(failureFields(new Error("x".repeat(500))).message).toHaveLength(200);
  });
});
