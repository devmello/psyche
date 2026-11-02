/**
 * A run that ended without the evidence its steps happened says so as
 * `not_verified: <reason>\nEvidence:\n- <line>…` (agent-core evidence.ts). `undefined` for any
 * other failure text.
 */
export function parseNotVerified(
  message: string | null | undefined,
): { reason: string; evidence: string[] } | undefined {
  if (!message) return undefined;
  const m = /not_verified:\s*/.exec(message);
  if (m === null) return undefined;
  const [reason = "", list = ""] = message.slice(m.index + m[0].length).split(/\nEvidence:\n/);
  const evidence = list
    .split("\n")
    .map((l) => l.replace(/^-\s*/, "").trim())
    .filter((l) => l !== "");
  return { reason: reason.trim(), evidence };
}
