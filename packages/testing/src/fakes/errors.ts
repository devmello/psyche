import { type ErrorCode, PsycheError } from "@psyche/protocol";

/** Shorthand used by every fake. */
export function fail(code: ErrorCode, message: string, details?: unknown): never {
  throw new PsycheError(code, message, details === undefined ? {} : { details });
}
