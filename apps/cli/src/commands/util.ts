import { PsycheError } from "@psyche/protocol";
import type { CallOptions, GatewayClient } from "../client.ts";
import { CliError, isUnavailable } from "../errors.ts";

/** Calls a method and turns `unknown_method` / `not_implemented` into a clear CLI error. */
export async function callOrUnavailable(
  client: GatewayClient,
  method: string,
  params: unknown,
  opts?: CallOptions,
): Promise<unknown> {
  try {
    return await client.call(method, params, opts);
  } catch (err) {
    if (isUnavailable(err)) {
      throw new CliError("unavailable", `${method} is not available on this Gateway yet`, {
        available: false,
        method,
      });
    }
    if (err instanceof PsycheError && err.code === "forbidden") {
      throw new CliError(
        "failure",
        `${method} was refused: this CLI lacks the scope (${err.message}). An admin can widen it with \`psyched devices grant ${client.deviceId} <scopes>\`.`,
      );
    }
    throw err;
  }
}

/** Like `callOrUnavailable` but returns `undefined` when the method is missing (doctor, audit, export). */
export async function callIfAvailable<T>(
  client: GatewayClient,
  method: string,
  params: unknown,
): Promise<
  | { ok: true; value: T }
  | { ok: false; reason: "unavailable" | "forbidden" | "error"; message: string }
> {
  try {
    return { ok: true, value: (await client.call(method, params)) as T };
  } catch (err) {
    if (isUnavailable(err))
      return { ok: false, reason: "unavailable", message: `${method} not available` };
    if (err instanceof PsycheError && (err.code === "forbidden" || err.code === "unauthorized")) {
      return { ok: false, reason: "forbidden", message: `${method}: ${err.message}` };
    }
    return {
      ok: false,
      reason: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** How long and how often the CLI waits for an approval card (tests shorten it). */
export const approvalWait = { timeoutMs: 10 * 60_000, firstPollMs: 1000, maxPollMs: 5000 };

/**
 * Calls a method that may answer `approval_required` (a plain-tap card on a paired phone or
 * desktop: owner decision, approvals are a tap). On that answer it says so, waits for the card to
 * be decided (`approvals.get` with back-off, up to ten minutes; Ctrl-C ends the process), then
 * repeats the same call with the `approvalId`. Generic on purpose: any method that follows the
 * `approval_required` + `approvalId` convention works, so more calls can move to cards later.
 */
export async function callWithApproval(
  client: GatewayClient,
  method: string,
  params: Record<string, unknown>,
  say: (text: string) => void,
): Promise<unknown> {
  // Not `callOrUnavailable`: its "this CLI lacks the scope" rewrite of `forbidden` would hide the
  // Gateway's own reason, which the callers explain better.
  const plain = async (m: string, p: unknown): Promise<unknown> => {
    try {
      return await client.call(m, p);
    } catch (err) {
      if (isUnavailable(err)) {
        throw new CliError("unavailable", `${m} is not available on this Gateway yet`, {
          available: false,
          method: m,
        });
      }
      throw err;
    }
  };
  try {
    return await plain(method, params);
  } catch (err) {
    const approvalId =
      err instanceof PsycheError && err.code === "approval_required"
        ? (err.details as { approvalId?: unknown } | undefined)?.approvalId
        : undefined;
    if (typeof approvalId !== "string") throw err;
    say("Approve this on your paired phone or desktop (waiting… Ctrl-C to cancel)");
    const deadline = Date.now() + approvalWait.timeoutMs;
    let delay = approvalWait.firstPollMs;
    for (;;) {
      const got = (await plain("approvals.get", { approvalId })) as {
        approval: { status: string };
      };
      const status = got.approval.status;
      if (status === "approved") break;
      if (status !== "pending") {
        throw new CliError("failure", `The approval was ${status}; nothing was changed`);
      }
      if (Date.now() + delay > deadline) {
        throw new CliError(
          "failure",
          "Timed out waiting for the approval (10 minutes); nothing was changed",
        );
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, approvalWait.maxPollMs);
    }
    return plain(method, { ...params, approvalId });
  }
}

export function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
