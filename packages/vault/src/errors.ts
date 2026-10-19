import { type ErrorCode, PsycheError } from "@psyche/protocol";

/** Throw a `PsycheError`. Messages and details never carry secret values. */
export function fail(code: ErrorCode, message: string, details?: unknown): never {
  throw new PsycheError(code, message, details === undefined ? {} : { details });
}

/** The machine-readable reason inside a `PsycheError`'s details, if any. */
export function reasonOf(err: unknown): string | undefined {
  if (!(err instanceof PsycheError)) return undefined;
  const d = err.details as { reason?: unknown } | undefined;
  return typeof d?.reason === "string" ? d.reason : err.code;
}
