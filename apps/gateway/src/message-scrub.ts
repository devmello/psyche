import type { Message } from "@psyche/protocol";
import type { MessageScrub } from "./context.ts";

/** Who is reading a message: the paired client's kind and whether it is the desktop app on this Mac. */
export interface Reader {
  role: "client" | "node" | null;
  desktop: boolean;
}

export const readerOf = (
  identity: { role: "client" | "node"; desktopShell?: true } | null | undefined,
): Reader =>
  identity == null
    ? { role: null, desktop: false }
    : {
        role: identity.role,
        desktop: identity.role === "client" && identity.desktopShell === true,
      };

/** The `chat.message` payload for one subscriber, or undefined to send the shared frame as it is. */
export function personalizeMessageEvent(
  ctx: { messageScrub: MessageScrub },
  payload: { message: Message },
  who: Reader,
): { message: Message } | undefined {
  if (!payload.message.blocks.some((b) => b.type === "life_answer")) return undefined;
  // One publish asks for each subscriber in turn: read the answer once per kind of reader.
  const key = `${who.role}:${who.desktop}`;
  const byReader = memo.get(payload.message) ?? new Map<string, Message>();
  memo.set(payload.message, byReader);
  const out = byReader.get(key) ?? scrubMessage(ctx, payload.message, who);
  byReader.set(key, out);
  return { ...payload, message: out };
}

const memo = new WeakMap<Message, Map<string, Message>>();

/**
 * A message as `who` may read it. A life answer's citations are read again for each reader
 * (`compose/life-answer-chat.ts`); until the composition root has bound that, the block is left
 * out, so a half-started Gateway never shows one. Every path that hands a transcript to a client
 * goes through here: `chat.history`, `chat.export` and the `chat.message` event.
 */
export function scrubMessage(
  ctx: { messageScrub: MessageScrub },
  m: Message,
  who: Reader,
): Message {
  if (!m.blocks.some((b) => b.type === "life_answer")) return m;
  const scrub = ctx.messageScrub.scrub;
  // A part of the Gateway itself (no paired device behind it) never reads the answer.
  return scrub !== null && who.role !== null
    ? scrub(m, who)
    : { ...m, blocks: m.blocks.filter((b) => b.type !== "life_answer") };
}
