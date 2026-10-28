import { createHash } from "node:crypto";
import type { JsonObject } from "@psyche/protocol";
import { bindingFor } from "./binding.ts";

/**
 * The `messages_send` compose card: a `message_send` approval the agent's tool issues with the
 * draft text and the candidate recipients in `details.compose`. The owner may pick a candidate and
 * edit the text before Allow; the broker then re-binds the approval to the final recipient and
 * text (`details.final`), so `verifiedMessagesSends` accepts exactly that send and nothing else.
 */

export const MAX_COMPOSE_TEXT = 20000;

export interface ComposeCandidate {
  /** Stable id within this card; what `recipientChoice` carries. */
  id: string;
  /** What `messages.send` gets: a handle (`to`) or a chat guid (`chatId`). */
  kind: "handle" | "chat";
  recipient: string;
  /** Contact name, handle or group name, as shown. */
  label: string;
  service: "imessage" | "sms" | "rcs" | "unknown";
  /** SMS / RCS identities are carrier-asserted and weak (review design-21). */
  weak: boolean;
  participants?: string[];
}

export interface ComposeDetails {
  channel: "imessage";
  account: string;
  candidates: ComposeCandidate[];
  /**
   * The draft as the card shows it (display-sanitized, line breaks as ⏎). The card pre-fills the
   * editor from it, and the answer always carries the final text, so what is shown is what is sent.
   */
  text: string;
  /** Digest of the agent's exact draft, so the tool can tell whether the owner edited it. */
  draftSha256: string;
  /** Where the candidates came from, so the card can say a recipient came from untrusted text. */
  recipientSource: "owner" | "untrusted";
}

export interface ComposeFinal {
  id: string;
  kind: "handle" | "chat";
  recipient: string;
  service: ComposeCandidate["service"];
  text: string;
  edited: boolean;
  bodySha256: string;
}

export function bodySha256(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

export function composeBindingHash(account: string, recipient: string, text: string): string {
  return bindingFor("message_send", {
    channel: "imessage",
    account,
    recipient,
    bodySha256: bodySha256(text),
  }).bindingHash;
}

export function readCompose(details: unknown): ComposeDetails | undefined {
  const c = (details as { compose?: unknown } | null)?.compose;
  if (typeof c !== "object" || c === null) return undefined;
  const v = c as Partial<ComposeDetails>;
  if (v.channel !== "imessage" || typeof v.account !== "string" || !Array.isArray(v.candidates)) {
    return undefined;
  }
  return v as ComposeDetails;
}

export function readFinal(details: unknown): ComposeFinal | undefined {
  const f = (details as { final?: unknown } | null)?.final;
  if (typeof f !== "object" || f === null) return undefined;
  const v = f as Partial<ComposeFinal>;
  return typeof v.recipient === "string" && typeof v.text === "string"
    ? (v as ComposeFinal)
    : undefined;
}

/** The owner's choice resolved against the card: undefined when it names nothing on the card. */
export function resolveCompose(
  compose: ComposeDetails,
  answer: { editedText?: string; recipientChoice?: string },
): ComposeFinal | undefined {
  const picked =
    answer.recipientChoice !== undefined
      ? compose.candidates.find((c) => c.id === answer.recipientChoice)
      : compose.candidates.length === 1
        ? compose.candidates[0]
        : undefined;
  if (picked === undefined) return undefined;
  const text = answer.editedText;
  if (
    text === undefined ||
    text.trim() === "" ||
    text.length > MAX_COMPOSE_TEXT ||
    text.includes("\u0000")
  ) {
    return undefined;
  }
  return {
    id: picked.id,
    kind: picked.kind,
    recipient: picked.recipient,
    service: picked.service,
    text,
    edited: bodySha256(text) !== compose.draftSha256,
    bodySha256: bodySha256(text),
  };
}

export type { JsonObject };
