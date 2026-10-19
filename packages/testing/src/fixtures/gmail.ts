import thread from "./gmail-thread.json" with { type: "json" };

/** Subset of the Gmail API `users.threads.get` (format=full) shape the fixtures use. */
export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailPart {
  partId: string;
  mimeType: string;
  filename: string;
  headers?: GmailHeader[];
  body: { size: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  historyId: string;
  internalDate: string;
  sizeEstimate: number;
  payload: GmailPart;
}

export interface GmailThread {
  id: string;
  historyId: string;
  snippet: string;
  messages: GmailMessage[];
}

/**
 * A three-message Gmail thread between fictional people at example.com (a school permission
 * slip with a PDF attachment). The last message carries an obvious prompt-injection line so
 * tests can assert it stays `untrusted` data.
 */
export const SAMPLE_GMAIL_THREAD: GmailThread = thread;

export function gmailHeader(message: GmailMessage, name: string): string | undefined {
  return message.payload.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

/** Decoded text/plain body of a message. */
export function gmailPlainText(message: GmailMessage): string {
  const part = message.payload.parts?.find((p) => p.mimeType === "text/plain") ?? message.payload;
  return part.body.data === undefined
    ? ""
    : Buffer.from(part.body.data, "base64url").toString("utf8");
}
