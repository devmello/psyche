/**
 * Structured one-line JSON logs on stderr. Callers pass ids, names and counts only: never
 * params, results, outputs or anything that could hold a secret (security §2).
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(
  write: (line: string) => void = (l) => process.stderr.write(`${l}\n`),
  minLevel: LogLevel = "info",
): Logger {
  const order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  return {
    log(level, msg, fields) {
      if (order[level] < order[minLevel]) return;
      write(JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }));
    },
  };
}

export const silentLogger: Logger = { log() {} };
