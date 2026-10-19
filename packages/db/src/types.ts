/** Minimal structured logger; field values must never contain message bodies or secrets. */
export interface DbLogger {
  debug?(msg: string, fields?: Record<string, unknown>): void;
  info?(msg: string, fields?: Record<string, unknown>): void;
  warn?(msg: string, fields?: Record<string, unknown>): void;
}
