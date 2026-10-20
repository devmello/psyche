import { type Static, Type } from "@sinclair/typebox";
import { StringEnum } from "./common.ts";

/**
 * Error codes carried by `res` frames (`ok: false`) and thrown as `PsycheError` inside the Gateway.
 * Additive: new codes may be appended; existing ones are never renamed before v1.
 */
export const ErrorCode = StringEnum(
  [
    "not_implemented",
    "invalid_frame",
    "invalid_params",
    "unknown_method",
    "protocol_version_mismatch",
    "unauthorized",
    "forbidden",
    "not_paired",
    "pairing_pending",
    "origin_rejected",
    "not_found",
    "conflict",
    "idempotency_conflict",
    "rate_limited",
    "timeout",
    "cancelled",
    "unavailable",
    "approval_required",
    "approval_expired",
    "approval_invalidated",
    "approval_not_armed",
    "answer_late",
    "answer_replayed",
    "binding_mismatch",
    "taint_blocked",
    "policy_denied",
    "internal",
    // Browser bridge (spike 01): the desktop refuses agent input while the user holds the tab,
    // reports a lost debugger session, an unknown tab and a CDP method outside its allowlist.
    "user_in_control",
    "debugger_detached",
    "tab_not_found",
    "method_not_allowed",
    // M3 hardening: a security change needs fresh presence, and no verifier on this Gateway can
    // provide one (presence was enrolled, then every passkey / helper key was lost or revoked).
    "presence_required",
  ],
  { $id: "ErrorCode", description: "Machine-readable error code" },
);
export type ErrorCode = Static<typeof ErrorCode>;

/** Wire shape of an error inside a `res` frame. */
export const ErrorPayload = Type.Object(
  {
    code: ErrorCode,
    message: Type.String(),
    details: Type.Optional(Type.Unknown()),
    retryable: Type.Optional(Type.Boolean()),
  },
  { $id: "ErrorPayload" },
);
export type ErrorPayload = Static<typeof ErrorPayload>;

/** Base error for everything that crosses a package boundary. */
export class PsycheError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: unknown; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "PsycheError";
    this.code = code;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
  }

  toPayload(): ErrorPayload {
    const payload: ErrorPayload = { code: this.code, message: this.message };
    if (this.details !== undefined) payload.details = this.details;
    if (this.retryable) payload.retryable = true;
    return payload;
  }

  static from(err: unknown): PsycheError {
    if (err instanceof PsycheError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new PsycheError("internal", message, { cause: err });
  }
}

/** Thrown by every package placeholder until the owning session lands the implementation. */
export class NotImplementedError extends PsycheError {
  constructor(pkg: string, member?: string) {
    super(
      "not_implemented",
      member === undefined
        ? `${pkg} is not implemented yet`
        : `${pkg}: ${member} is not implemented yet`,
    );
    this.name = "NotImplementedError";
  }
}
