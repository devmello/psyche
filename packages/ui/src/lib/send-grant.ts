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

/** The account and recipient set a `send_email` grant key covers, or null for another key. */
export function parseSendGrantKey(grantKey: string): SendGrantKey | null {
  if (!grantKey.startsWith(SEND_PREFIX)) return null;
  const rest = grantKey.slice(SEND_PREFIX.length);
  const cut = rest.indexOf(":");
  if (cut <= 0) return null;
  return { account: rest.slice(0, cut), recipients: splitRecipients(rest.slice(cut + 1)) };
}
