import type { Message } from "@psyche/protocol";

/**
 * Who wrote a chat message, for `from:` (see `messageSender`). The owner's messages carry the
 * alias `me`, so `from:me` finds them whatever the owner's name is.
 */
export const OWNER_ALIAS = "me";
/** The sender of an assistant message. The persona carries no name yet, so it is the product's. */
export const AGENT_SENDER = "Psyche";
const OWNER_FALLBACK = "Me";
/**
 * Marks an alias inside `sender_key`. A control character no name contains, so `from:me` matches
 * the alias only and not every name with the letters "me" in it ("Emerson", "Melissa").
 */
const ALIAS_MARK = "\u001f";

export interface MessageSender {
  /** Shown as the document's sender, and matched by `from:`. */
  name: string;
  /** Extra names the sender answers to (`me`, a peer id), matched as marked aliases. */
  aliases?: string[];
}

/** The owner's name from the profile (`USER.md`), when there is one. */
export interface SenderNames {
  owner?: string;
}

/**
 * The text `sender_key` stores for a document: its sender's name and each alias marked, all
 * NFC-normalised and lower-cased. Without aliases it is the plain name, as before.
 */
export function senderKeyOf(
  from: string | undefined,
  aliases: readonly string[] = [],
): string | null {
  if (from === undefined) return null;
  return [from, ...aliases.map((a) => `${ALIAS_MARK}${a}`)]
    .join(" ")
    .normalize("NFC")
    .toLowerCase();
}

/**
 * The `instr` needle for one `from:` term. `me` becomes the marked alias, so it cannot match a
 * name that merely contains the letters; any other term is a case-insensitive substring.
 */
export function senderNeedle(term: string): string {
  const t = term.normalize("NFC").toLowerCase();
  return t === OWNER_ALIAS ? `${ALIAS_MARK}${OWNER_ALIAS}` : t;
}

/**
 * Who sent a chat message, or undefined when it has no sender (system and tool turns). Assistant
 * turns are the agent. The owner's own turns (trusted provenance) are the owner, by name when the
 * profile has one. An untrusted turn in an old channel chat (`<channel>:peer:12345`) is the peer: the
 * chat's title as the name, the peer id as an alias. Other untrusted turns (an imported export)
 * are left without a sender rather than guessed at.
 */
export function messageSender(
  message: Pick<Message, "role" | "provenance">,
  thread: { title: string; sessionKey: string } | undefined,
  names: SenderNames = {},
): MessageSender | undefined {
  if (message.role === "agent") return { name: AGENT_SENDER };
  if (message.role !== "user") return undefined;
  if (message.provenance !== "untrusted") {
    return { name: names.owner?.trim() || OWNER_FALLBACK, aliases: [OWNER_ALIAS] };
  }
  const handle = /^[^:]+:peer:(.+)$/.exec(thread?.sessionKey ?? "")?.[1];
  if (handle === undefined) return undefined;
  const title = thread?.title.trim() ?? "";
  return title === "" ? { name: handle } : { name: title, aliases: [handle] };
}
