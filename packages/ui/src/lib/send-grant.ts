/**
 * An email send grant is keyed `send_email:<account>:<recipients>`, the recipients being the
 * canonical (lowercased, sorted, deduped) to + cc + bcc set joined by `,` (connectors' sendBinding).
 */
const SEND_PREFIX = "send_email:";

export interface SendGrantKey {
  account: string;
  recipients: string[];
}

export function splitRecipients(value: string): string[] {
  return value
    .split(",")
    .map((a) => a.trim())
    .filter((a) => a !== "");
}

/**
 * The account and recipient set a `send_email` grant key covers, or null for another key.
 * Real keys arrive namespaced by the tool (`<tool>|send_email:…`, the loop's namespacedGrantKey),
 * and an account may itself contain `:` (`apple-mail:<connectorId>`), while a canonical address
 * never does, so the account ends at the last `:`.
 */
export function parseSendGrantKey(grantKey: string): SendGrantKey | null {
  const bar = grantKey.indexOf("|");
  const bare = grantKey.startsWith(SEND_PREFIX)
    ? grantKey
    : bar > 0 && grantKey.slice(bar + 1).startsWith(SEND_PREFIX)
      ? grantKey.slice(bar + 1)
      : null;
  if (bare === null) return null;
  const rest = bare.slice(SEND_PREFIX.length);
  const cut = rest.lastIndexOf(":");
  if (cut <= 0) return null;
  const recipients = splitRecipients(rest.slice(cut + 1));
  if (recipients.length === 0) return null;
  return { account: rest.slice(0, cut), recipients };
}
