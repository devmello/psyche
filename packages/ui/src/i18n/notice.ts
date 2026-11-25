import type { NoticeMessage } from "@psyche/protocol";
import { activeI18n, type I18n, isMessageId, type MessageValues } from "./core.ts";
import { codeSentence } from "./errors.ts";

/** What a Gateway-authored notice says, in the active language when the client knows its ids. */
export interface NoticeText {
  title: string;
  body: string;
}

/**
 * Words a notification the Gateway authored. The Gateway sends English `title` and `body` and,
 * for notices it has ids for, a `message` (title id, body id, values). A client that knows both
 * ids renders them in its own language; an older client never reads `message` and shows the
 * English text, and so does this one when an id is unknown (a newer Gateway) or a value is
 * missing. Values are shown as plain text: the formatter never reads them as markup.
 */
export function noticeText(
  n: { title: string; body: string; message?: NoticeMessage | null | undefined },
  i18n: I18n = activeI18n(),
): NoticeText {
  const m = n.message;
  if (m === undefined || m === null) return { title: n.title, body: n.body };
  if (!isMessageId(m.titleKey) || !isMessageId(m.bodyKey)) return { title: n.title, body: n.body };
  try {
    const values = { ...(m.params ?? {}) } as Record<string, unknown>;
    // A bare code the Gateway kept (a connector's `internal`, a helper's `automation_denied`) is
    // said in words; anything that is not a code with a sentence stays as the Gateway sent it.
    if (typeof values.reason === "string") {
      values.reason = codeSentence(values.reason, i18n) ?? values.reason;
    }
    return {
      title: i18n.t(m.titleKey, values as MessageValues),
      body: i18n.t(m.bodyKey, values as MessageValues),
    };
  } catch {
    return { title: n.title, body: n.body };
  }
}
