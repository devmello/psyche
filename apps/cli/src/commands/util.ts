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

export function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
