import { type ErrorCode, type NodeClient, PsycheError } from "@psyche/protocol";

/**
 * Mac-helper item capabilities for system keychain mode (G9), as specified in
 * `apps/mac-helper/Sources/PsycheHelperSystem/Keychain/KeychainCapabilities.swift` (`store`,
 * `retrieve`). They are defined there but not yet registered in `KeychainCapabilities.make`; the
 * item delete needs its own name because `keychain.delete` is the vault-key delete. Byte values
 * travel base64url. `retrieve` returns a secret: callers keep it in memory only. The agent has no
 * tool for any of these (`nodes.invoke` must not reach them).
 */
export const KEYCHAIN_ITEM_CAPABILITIES = {
  store: "keychain.store",
  retrieve: "keychain.retrieve",
  deleteItem: "keychain.delete_item",
  status: "keychain.status",
} as const;

/** `^[a-z0-9._-]{1,64}$` for slot and item names (S14 `KeychainNames`). */
export const KEYCHAIN_NAME_RE = /^[a-z0-9._-]{1,64}$/;

/** Prompt text: one line, at most 120 characters (S14 `KeychainNames.reasonMaxLength`). */
export function promptReason(text: string): string {
  const line = text.replace(/[\r\n\u2028\u2029\p{Cc}]+/gu, " ").trim();
  const chars = [...(line.length > 0 ? line : "Psyche needs your approval")];
  return chars.length <= 120 ? chars.join("") : `${chars.slice(0, 119).join("")}…`;
}

export interface KeychainStatus {
  dataProtectionKeychain: "available" | "missing_entitlement" | "error";
  accessGroup: string | null;
  biometry?: unknown;
}

/** Invoke a helper capability; a failure becomes a `PsycheError` carrying the helper's reason. */
export async function invokeHelper<T>(
  node: NodeClient,
  capability: string,
  params: object,
): Promise<T> {
  const res = await node.invoke(capability, params);
  if (res.ok) return (res.result ?? {}) as T;
  const code = (res.error?.code ?? "internal") as ErrorCode;
  const details = res.error?.details as { reason?: unknown } | undefined;
  const reason = typeof details?.reason === "string" ? details.reason : code;
  // Never copy the helper's message verbatim into ours: keep code + reason only.
  throw new PsycheError(code, `${capability} failed (${reason})`, { details: { reason } });
}

export async function helperUnavailable(
  node: NodeClient,
  needs: readonly string[],
): Promise<string | null> {
  const caps = new Set((await node.capabilities()).map((c) => c.name));
  for (const cap of needs) if (!caps.has(cap)) return `helper lacks ${cap}`;
  try {
    const status = await invokeHelper<KeychainStatus>(node, KEYCHAIN_ITEM_CAPABILITIES.status, {});
    if (status.dataProtectionKeychain !== "available") {
      return `data-protection keychain is ${status.dataProtectionKeychain}`;
    }
  } catch {
    return "keychain.status failed";
  }
  return null;
}

export const toB64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
export const fromB64url = (s: string) => Buffer.from(s, "base64url");
