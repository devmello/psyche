import type { Receipt } from "@psyche/protocol";

/**
 * The standing grant that let a receipt's call through, as its recorder wrote it: the loop,
 * the coding tools and the connector registry put `payload.grantId`; a connector receipt's
 * `payload.rule` is also `grant:<id>`. Undefined when the recorder cannot say (no payload).
 * `payload.bindingHash` next to it is the exact call's binding (`receiptGrantBinding`).
 */
export function receiptGrantId(r: Pick<Receipt, "payload">): string | undefined {
  const p = r.payload;
  if (p == null) return undefined;
  if (typeof p.grantId === "string" && p.grantId !== "") return p.grantId;
  const rule = p.rule;
  if (typeof rule === "string" && rule.startsWith("grant:") && rule.length > 6) {
    return rule.slice(6);
  }
  return undefined;
}

/**
 * The binding of the call a grant let through, as its recorder wrote it next to the grant id:
 * a grant covers a key, so only this says the call was the very action a card approved.
 */
export function receiptGrantBinding(r: Pick<Receipt, "payload">): string | undefined {
  const b = r.payload?.bindingHash;
  return typeof b === "string" && b !== "" ? b : undefined;
}
