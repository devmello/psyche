import { createHash } from "node:crypto";
import { asRecord, preview, stable, str, strList } from "./common.ts";
import type {
  Adapter,
  CheckResult,
  Json,
  MailDraftInfo,
  MailThreadInfo,
  ReadRegistry,
} from "./types.ts";

/**
 * Mail drafts (§2.3). Recipients must be the thread's participants; a draft that adds a recipient
 * or forwards is refused; a draft with no thread cannot be judged and is refused. Stale when a new
 * message arrived in the thread or the thread is gone. There is no inverse: no draft-delete tool.
 */

const DRAFT_TOOLS = [
  "mail_reply_draft",
  "mail_draft",
  "gmail_create_draft",
  "mail_create_draft",
] as const;

/** `Name <a@b.c>` or `a@b.c` to a lowercased address. */
export function address(raw: string): string {
  const m = /<([^<>]+)>/.exec(raw);
  return (m?.[1] ?? raw).trim().toLowerCase();
}

const FORWARD_SUBJECT = /^\s*(fwd?|fw|wg|tr|rv)\s*:/i;

async function readThread(
  registry: ReadRegistry,
  ref: Parameters<ReadRegistry["mailThread"]>[0],
): Promise<MailThreadInfo | null | "unreadable"> {
  try {
    return await registry.mailThread(ref);
  } catch {
    return "unreadable";
  }
}

export function mailAdapter(registry: ReadRegistry): Adapter {
  return {
    tools: DRAFT_TOOLS,

    async capture(call) {
      const a = call.args;
      // Forwards are an exfiltration path. Refuse by tool name, subject, flag and any attachment.
      if (/forward/i.test(call.tool)) return { ok: false, reason: "forward_refused" };
      if (typeof a.subject === "string" && FORWARD_SUBJECT.test(a.subject)) {
        return { ok: false, reason: "forward_refused" };
      }
      if (a.forward !== undefined && a.forward !== false) {
        return { ok: false, reason: "forward_refused" };
      }
      if (
        a.attachments !== undefined &&
        !(Array.isArray(a.attachments) && a.attachments.length === 0)
      ) {
        return { ok: false, reason: "attachments_refused" };
      }

      const to = strList(a.to);
      const cc = strList(a.cc);
      const bcc = strList(a.bcc);
      if (!to || !cc || !bcc) return { ok: false, reason: "bad_recipients" };

      const reply = call.tool === "mail_reply_draft";
      const ref = reply
        ? { messageId: str(a.id), mailbox: str(a.mailbox), account: str(a.account) }
        : { threadId: str(a.threadId) };
      if (!ref.messageId && !(ref as { threadId?: string }).threadId) {
        return { ok: false, reason: "no_thread" };
      }
      const thread = await readThread(registry, ref);
      if (thread === "unreadable") return { ok: false, reason: "thread_unreadable" };
      if (!thread) return { ok: false, reason: "thread_gone" };

      // A reply derives its `to` from the thread, so only the explicit recipients are judged.
      const participants = new Set(thread.participants.map(address));
      const explicit = [...to, ...cc, ...bcc].map(address);
      if (explicit.some((r) => !participants.has(r))) {
        return { ok: false, reason: "recipient_added" };
      }
      if (!reply && to.length === 0) return { ok: false, reason: "bad_recipients" };

      return {
        ok: true,
        target: thread.threadId,
        precondition: { newestMessageId: thread.newestMessageId, count: thread.count },
        before: { participants: [...participants].sort(), recipients: explicit },
      };
    },

    async check(call, capture): Promise<CheckResult> {
      const pre = asRecord(capture.precondition);
      const thread = await readThread(registry, { threadId: capture.target });
      if (thread === "unreadable") return { fresh: false, reason: "thread_unreadable" };
      if (!thread) return { fresh: false, reason: "thread_gone" };
      if (thread.newestMessageId !== pre.newestMessageId || thread.count !== pre.count) {
        return { fresh: false, reason: "new_message" };
      }
      // Recipients are judged against the thread as it is now, not as it was.
      const participants = new Set(thread.participants.map(address));
      const all = [call.args.to, call.args.cc, call.args.bcc].flatMap((v) => strList(v) ?? ["?"]);
      if (all.some((r) => !participants.has(address(r)))) {
        return { fresh: false, reason: "recipient_added" };
      }
      return { fresh: true };
    },

    preview(call, capture) {
      const a = call.args;
      return preview("mail", "Draft a reply", [
        ["Thread", capture.target],
        ["To", (strList(a.to) ?? []).join(", ")],
        ["Cc", (strList(a.cc) ?? []).join(", ")],
        ["Subject", a.subject],
        ["Body", a.body],
      ]);
    },
  };
}

// --- Send recipe ----------------------------------------------------------------------------------

/** The content a send is bound to (§2.3, §3.2): everything that reaches a recipient. */
export function draftContent(d: MailDraftInfo): Json {
  const norm = (xs: string[]) => xs.map(address).sort();
  return {
    to: norm(d.to),
    cc: norm(d.cc),
    bcc: norm(d.bcc),
    subject: d.subject,
    body: d.body,
    inReplyTo: d.inReplyTo,
    attachments: [...d.attachments].sort(),
  };
}

/** Hash over to, cc, bcc, subject, body, in-reply-to and attachments. */
export function draftContentHash(d: MailDraftInfo): string {
  return createHash("sha256")
    .update(stable(draftContent(d)))
    .digest("hex");
}

export type SendCheck = { ok: true; recipients: string[] } | { ok: false; reason: string };

/**
 * Before `mail_send_draft` / `gmail_send` runs: read the saved draft back and compare its content
 * hash with the one recorded when the draft was saved. A missing draft, an unreadable one or any
 * difference refuses the send. Recipients are listed for the approval's "Send to a@x, b@y" row.
 * The thread's participants are re-checked too, so a draft edited to add someone is refused even
 * if its hash was re-recorded. No inverse: a send is final.
 */
export async function checkSendRecipe(
  registry: ReadRegistry,
  input: { draftId: string; expectedHash: string; threadId: string },
): Promise<SendCheck> {
  let draft: MailDraftInfo | null;
  try {
    draft = await registry.mailDraft(input.draftId);
  } catch {
    return { ok: false, reason: "draft_unreadable" };
  }
  if (!draft) return { ok: false, reason: "draft_gone" };
  const thread = await readThread(registry, { threadId: input.threadId });
  if (thread === "unreadable") return { ok: false, reason: "thread_unreadable" };
  if (!thread) return { ok: false, reason: "thread_gone" };
  if (draftContentHash(draft) !== input.expectedHash) return { ok: false, reason: "draft_changed" };
  const participants = new Set(thread.participants.map(address));
  const recipients = [...draft.to, ...draft.cc, ...draft.bcc].map(address);
  if (recipients.some((r) => !participants.has(r))) return { ok: false, reason: "recipient_added" };
  return { ok: true, recipients };
}

export function previewSend(recipients: string[]) {
  return preview("mail", "Send it too", [["Send to", recipients.join(", ")]]);
}
