import { PsycheError } from "@psyche/protocol";

/** Exit codes: 0 ok, 1 failure or problems found, 2 usage error, 3 not paired / pairing pending, 4 Gateway unreachable. */
export const EXIT = { ok: 0, failure: 1, usage: 2, pairing: 3, unreachable: 4 } as const;

export type CliErrorKind = "usage" | "failure" | "pairing" | "unreachable" | "unavailable";

/** An error the CLI reports to the user and maps to an exit code. */
export class CliError extends Error {
  readonly kind: CliErrorKind;
  readonly details: Record<string, unknown> | undefined;

  constructor(kind: CliErrorKind, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "CliError";
    this.kind = kind;
    this.details = details;
  }

  get exitCode(): number {
    switch (this.kind) {
      case "usage":
        return EXIT.usage;
      case "pairing":
        return EXIT.pairing;
      case "unreachable":
        return EXIT.unreachable;
      default:
        return EXIT.failure;
    }
  }
}

/** Gateway error codes that mean "this Gateway does not offer the method yet". */
export function isUnavailable(err: unknown): boolean {
  return (
    err instanceof PsycheError && (err.code === "unknown_method" || err.code === "not_implemented")
  );
}

export interface ErrorReport {
  code: string;
  message: string;
  details?: unknown;
}

export function toReport(err: unknown): ErrorReport {
  if (err instanceof CliError) {
    return {
      code: err.kind,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
    };
  }
  if (err instanceof PsycheError) {
    return {
      code: err.code,
      message: err.message,
      ...(err.details !== undefined ? { details: err.details } : {}),
    };
  }
  return { code: "internal", message: err instanceof Error ? err.message : String(err) };
}

export function exitCodeOf(err: unknown): number {
  if (err instanceof CliError) return err.exitCode;
  if (err instanceof PsycheError) {
    if (err.code === "not_paired" || err.code === "pairing_pending") return EXIT.pairing;
    if (err.code === "invalid_params") return EXIT.usage;
  }
  return EXIT.failure;
}
