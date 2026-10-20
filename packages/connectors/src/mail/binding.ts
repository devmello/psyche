import type { ToolCallDescription } from "@psyche/protocol";
import { canonicalJSON, sha256 } from "../framework/binding.ts";
import { asObject, schema, strArray } from "../framework/params.ts";
import { canonicalAddress, type OutgoingMail } from "../google/mime.ts";

/**
 * Outgoing-mail parameters and bindings shared by every mail connector (Gmail, IMAP / SMTP,
 * JMAP), so the owner approves the same card and the same hash whatever the provider.
 */

export const mailSchema = schema.obj(
  {
    to: schema.strs,
    cc: schema.strs,
    bcc: schema.strs,
    subject: schema.str,
    body: schema.str,
    threadId: schema.str,
    inReplyTo: schema.str,
    references: schema.strs,
  },
  ["to", "subject", "body"],
);

export interface MailParams {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string[];
}

export function mailParams(params: unknown): MailParams {
  const p = asObject(params);
  const out: MailParams = {
    to: strArray(p.to, "to"),
    cc: strArray(p.cc, "cc"),
    bcc: strArray(p.bcc, "bcc"),
    subject: typeof p.subject === "string" ? p.subject : "",
    body: typeof p.body === "string" ? p.body : "",
  };
  if (typeof p.threadId === "string") out.threadId = p.threadId;
  if (typeof p.inReplyTo === "string") out.inReplyTo = p.inReplyTo;
  if (p.references !== undefined) out.references = strArray(p.references, "references");
  return out;
}

export function toMail(m: MailParams, from?: string): OutgoingMail {
  const mail: OutgoingMail = {
    to: m.to,
    cc: m.cc ?? [],
    bcc: m.bcc ?? [],
    subject: m.subject,
    text: m.body,
  };
  if (from !== undefined) mail.from = from;
  if (m.inReplyTo !== undefined) mail.inReplyTo = m.inReplyTo;
  if (m.references !== undefined) mail.references = m.references;
  return mail;
}

const sortedLower = (xs: string[] | undefined) => [...(xs ?? [])].map(canonicalAddress).sort();

/** Security §3.5 `email.send`: account, recipients (lowercased, sorted), subject, body hash, attachment hashes. */
export function sendBinding(account: string, params: unknown): ToolCallDescription {
  const m = mailParams(params);
  const to = sortedLower(m.to);
  const cc = sortedLower(m.cc);
  const bcc = sortedLower(m.bcc);
  const recipients = [...new Set([...to, ...cc, ...bcc])].sort();
  return {
    kind: "send_email",
    target: { kind: "recipient", value: recipients.join(","), display: recipients.join(", ") },
    bindingFields: {
      account,
      to,
      cc,
      bcc,
      subject: m.subject,
      bodyHash: sha256(m.body),
      attachmentHashes: [],
      threadId: m.threadId ?? null,
      inReplyTo: m.inReplyTo ?? null,
      references: m.references ?? [],
    },
    grantKey: `send_email:${account}:${recipients.join(",")}`,
    summary: `Sent "${m.subject.slice(0, 60)}" to ${recipients.join(", ").slice(0, 120)}`,
  };
}

/** Other writes (labels, drafts, uploads): connector id, tool, params hash. */
export function actionBinding(
  connectorId: string,
  tool: string,
  params: unknown,
): ToolCallDescription {
  return {
    kind: "connector_action",
    target: { kind: "account", value: connectorId },
    bindingFields: { connectorId, tool, paramsHash: sha256(canonicalJSON(params ?? {})) },
    grantKey: `connector_action:${connectorId}:${tool}`,
  };
}
