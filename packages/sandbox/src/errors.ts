import { type ErrorCode, PsycheError } from "@psyche/protocol";

export function fail(code: ErrorCode, message: string, details?: unknown): never {
  throw new PsycheError(code, message, details === undefined ? {} : { details });
}
