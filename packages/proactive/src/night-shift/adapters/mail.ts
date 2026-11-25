import { createHash } from "node:crypto";
import { canonicalAddress } from "@psyche/connectors";
import { asRecord, bareTool, preview, type RowInput, stable, str, strList } from "./common.ts";
import type {
  Adapter,
  CaptureResult,
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
 *
 * Connector tools skip schema validation, so every model-supplied value is judged here:
 * - a recipient is exactly one strict address (`canonicalAddress` throws otherwise: a list in one
 *   string, an address inside a display name, a line break), and the hash covers canonical ones;
 * - for `mail_reply_draft` the recipients are the ones the reply really goes to (Reply-To, else
 *   From, plus To and Cc with reply-all), read through the registry, and all must be thread
 *   participants. The exact set is recorded and the send recipe compares it by set equality;
 * - subject and body must not carry hidden characters.
 */

const DRAFT_TOOLS = [
  "mail_reply_draft",
  "mail_draft",
  "gmail_create_draft",
  "mail_create_draft",
] as const;

/** One strict, lowercase address, or undefined when `raw` is not exactly one address. */
export function strictAddress(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    return canonicalAddress(raw);
  } catch {
    return undefined;
  }
}

/** Every entry must be one strict address. `undefined` when any is not. */
function strictList(v: unknown): string[] | undefined {
  const xs = strList(v);
  if (!xs) return undefined;
  const out: string[] = [];
  for (const x of xs) {
    const a = strictAddress(x);
    if (a === undefined) return undefined;
    out.push(a);
  }
  return out;
}

/**
 * Hidden or invisible characters in text a recipient will read. Anything that is a
 * `Default_Ignorable_Code_Point` (zero width and joiner characters, soft hyphen, variation
 * selectors, tag characters, the combining grapheme joiner, the Hangul filler, bidi controls) or a
 * format character (`\p{Cf}`) is refused, wherever it sits. The one exception is what emoji need:
 * a zero width joiner or VS16 directly after an `Extended_Pictographic` character, so a thumbs up
 * with VS16 and a family sequence pass while a variation selector after a letter does not.
 */
const VISIBLE_ONLY =
  /^(?:[^\p{Default_Ignorable_Code_Point}\p{Cf}]|(?<=\p{Extended_Pictographic})[\u200D\uFE0F])*$/u;

export function hasHiddenContent(text: string): boolean {
  return !VISIBLE_ONLY.test(text);
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

const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();

export function mailAdapter(registry: ReadRegistry): Adapter {
  async function capture(call: {
    tool: string;
    args: Record<string, unknown>;
  }): Promise<CaptureResult> {
    const a = call.args;
    const bare = bareTool(call);
    // Forwards are an exfiltration path. Refuse by tool name, subject, flag and any attachment.
    if (/forward/i.test(bare)) return { ok: false, reason: "forward_refused" };
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
    for (const k of ["subject", "body"] as const) {
      const v = a[k];
      if (v !== undefined && (typeof v !== "string" || hasHiddenContent(v))) {
        return { ok: false, reason: "hidden_content" };
      }
    }

    const to = strictList(a.to);
    const cc = strictList(a.cc);
    const bcc = strictList(a.bcc);
    if (!to || !cc || !bcc) return { ok: false, reason: "bad_recipients" };

    const reply = bare === "mail_reply_draft";
    const ref = reply
      ? { messageId: str(a.id), mailbox: str(a.mailbox), account: str(a.account) }
      : { threadId: str(a.threadId) };
    if (!ref.messageId && !(ref as { threadId?: string }).threadId) {
      return { ok: false, reason: "no_thread" };
    }
    const thread = await readThread(registry, ref);
    if (thread === "unreadable") return { ok: false, reason: "thread_unreadable" };
    if (!thread) return { ok: false, reason: "thread_gone" };

    // Who the draft really goes to. A reply derives its recipients from the message (Reply-To
    // first), so ask the registry rather than trust the thread's From.
    const replyAll = reply && a.replyAll === true;
    let resolved: string[] = [];
    if (reply) {
      try {
        const r = await registry.mailReplyRecipients({
          messageId: ref.messageId as string,
          mailbox: ref.mailbox,
          account: ref.account,
          replyAll,
        });
        if (!r) return { ok: false, reason: "reply_recipients_unknown" };
        const rs = r.map(strictAddress);
        if (rs.some((x) => x === undefined)) return { ok: false, reason: "bad_recipients" };
        resolved = rs as string[];
      } catch {
        return { ok: false, reason: "reply_recipients_unreadable" };
      }
    } else if (to.length === 0) {
      return { ok: false, reason: "bad_recipients" };
    }
    const recipients = sorted([...resolved, ...to, ...cc, ...bcc]);
    if (recipients.length === 0) return { ok: false, reason: "bad_recipients" };

    const participantList = sorted(
      thread.participants.map(strictAddress).filter((x): x is string => !!x),
    );
    const participants = new Set(participantList);
    if (recipients.some((r) => !participants.has(r))) {
      return { ok: false, reason: "recipient_added" };
    }

    // Participants can be widened by someone mailing the owner: mark who the owner never wrote to.
    let sentTo: Set<string>;
    try {
      sentTo = new Set(await registry.mailSentTo(recipients));
    } catch {
      return { ok: false, reason: "sent_history_unreadable" };
    }

    return {
      ok: true,
      target: thread.threadId,
      precondition: {
        newestMessageId: thread.newestMessageId,
        count: thread.count,
        replyAll,
        recipients,
        ...(reply
          ? {
              replyRef: {
                messageId: ref.messageId ?? null,
                mailbox: ref.mailbox ?? null,
                account: ref.account ?? null,
              },
            }
          : {}),
      },
      before: {
        participants: participantList,
        recipients: recipients.map((address) => ({ address, newRecipient: !sentTo.has(address) })),
        replyAll,
      },
    };
  }

  return {
    tools: DRAFT_TOOLS,
    capture,

    async check(call, cap): Promise<CheckResult> {
      const pre = asRecord(cap.precondition);
      const thread = await readThread(registry, { threadId: cap.target });
      if (thread === "unreadable") return { fresh: false, reason: "thread_unreadable" };
      if (!thread) return { fresh: false, reason: "thread_gone" };
      if (thread.newestMessageId !== pre.newestMessageId || thread.count !== pre.count) {
        return { fresh: false, reason: "new_message" };
      }
      // Re-judge the call against the thread and the reply recipients as they are now, and require
      // the exact recorded set.
      const again = await capture(call);
      if (!again.ok) return { fresh: false, reason: again.reason };
      const was = stable((pre.recipients ?? []) as Json);
      const now = stable(asRecord(again.precondition).recipients ?? []);
      if (was !== now) return { fresh: false, reason: "recipients_changed" };
      return { fresh: true };
    },

    preview(call, cap) {
      const a = call.args;
      const before = asRecord(cap.before);
      const replyAll = before.replyAll === true;
      const people = Array.isArray(before.recipients) ? before.recipients : [];
      return preview("mail", replyAll ? "Draft a reply to all" : "Draft a reply", [
        ["Thread", cap.target],
        ...(replyAll ? [["Reply all", "yes", { badge: "reply_all" }] as RowInput] : []),
        ...people.map((p): [string, unknown, { full: true; badge?: "new_recipient" }] => {
          const r = asRecord(p as Json);
          return [
            "Recipient",
            r.address,
            r.newRecipient === true ? { full: true, badge: "new_recipient" } : { full: true },
          ];
        }),
        ["Subject", a.subject, { full: true }],
        ["Body", a.body, { full: true }],
      ]);
    },
  };
}

// --- Send recipe ----------------------------------------------------------------------------------

/** The content a send is bound to (§2.3, §3.2): everything that reaches a recipient. Throws on a
 * recipient that is not exactly one strict address. */
export function draftContent(d: MailDraftInfo): Json {
  const norm = (xs: string[]) => xs.map((x) => canonicalAddress(x)).sort();
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

/** Hash over canonical to, cc, bcc, subject, body, in-reply-to and attachments. */
export function draftContentHash(d: MailDraftInfo): string {
  return createHash("sha256")
    .update(stable(draftContent(d)))
    .digest("hex");
}

export type SendCheck = { ok: true; recipients: string[] } | { ok: false; reason: string };

/**
 * Before `mail_send_draft` / `gmail_send` runs: read the saved draft back and compare its content
 * hash with the one recorded when the draft was saved. A missing draft, an unreadable one, hidden
 * characters or any difference refuses the send. The draft's recipients must equal the set
 * recorded at capture (`expectedRecipients`, the item's `precondition.recipients`) exactly, and
 * lie inside the thread's participants. No inverse: a send is final.
 */
export async function checkSendRecipe(
  registry: ReadRegistry,
  input: {
    draftId: string;
    expectedHash: string;
    threadId: string;
    expectedRecipients: string[];
    /** The staged body: the owner's own text. The draft's body also holds the quoted original. */
    stagedBody: string;
  },
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

  let hash: string;
  let recipients: string[];
  try {
    hash = draftContentHash(draft);
    recipients = sorted([...draft.to, ...draft.cc, ...draft.bcc].map((x) => canonicalAddress(x)));
  } catch {
    return { ok: false, reason: "bad_recipients" };
  }
  // Only the owner's part is judged: quoted mail may carry joiners we did not write and cannot
  // change. The hash still binds the whole draft.
  if (hasHiddenContent(draft.subject) || hasHiddenContent(input.stagedBody)) {
    return { ok: false, reason: "hidden_content" };
  }
  if (hash !== input.expectedHash) return { ok: false, reason: "draft_changed" };
  const expected = sorted(input.expectedRecipients.map((x) => canonicalAddress(x)));
  if (stable(expected) !== stable(recipients)) return { ok: false, reason: "recipients_changed" };
  const participants = new Set(thread.participants.map(strictAddress));
  if (recipients.some((r) => !participants.has(r))) return { ok: false, reason: "recipient_added" };
  return { ok: true, recipients };
}

export function previewSend(recipients: string[]) {
  return preview("mail", "Send it too", [["Send to", recipients.join(", "), { full: true }]]);
}
