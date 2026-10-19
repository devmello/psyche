/**
 * Structured logs without message bodies or secrets (architecture §14, ADR-017).
 * Callers pass metadata only: ids, method names, sizes, codes — never params or payloads.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  log(
    level: LogLevel,
    msg: string,
    fields?: Record<string, string | number | boolean | null>,
  ): void;
}

export function createLogger(
  sink: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
  minLevel: LogLevel = (process.env.PSYCHE_LOG_LEVEL as LogLevel | undefined) ?? "info",
): Logger {
  const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
  return {
    log(level, msg, fields = {}) {
      if (order[level] < order[minLevel]) return;
      sink(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }));
    },
  };
}

export const silentLogger: Logger = { log() {} };
