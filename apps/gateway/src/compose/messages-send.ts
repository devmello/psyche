import { type AgentToolRegistration, defineTool, type ToolRunContext } from "@psyche/agent-core";
import {
  bodySha256,
  type ComposeCandidate,
  type ComposeDetails,
  composeBindingHash,
  readFinal,
} from "@psyche/permissions";
import {
  type MessagesChat,
  type MessagesService,
  type NodeClient,
  type PermissionBroker,
  PsycheError,
  type ToolResult,
} from "@psyche/protocol";
import { Type } from "@sinclair/typebox";

/**
 * `messages_send` (feature J7/N5, security §3.5, §3.12): the agent starts an iMessage from a
 * normal chat. The tool resolves who `to` means (the Mac's Contacts plus the chats Messages.app
 * already has), then raises ONE `message_send` compose card that shows the exact recipient (name,
 * handle and service, or the group and its participants) and the draft in an editable field. The
 * owner may pick among candidates and edit the text; the broker re-binds the approval to the final
 * recipient and text, and the send goes through `verifiedMessagesSends`, which spends that approval
 * once. The call waits for the answer and returns sent / edited_and_sent / cancelled to the model
 * in the same turn.
 *
 * Nothing is guessed: no match returns no card; several matches (two "Mom"s, a person with
 * several numbers) all go on the card and the owner picks. The card offers `once` only, always:
 * a tainted turn can draft but the card says why it is once only. No attachments in v1.
 */

export interface MessagesSendToolDeps {
  broker: PermissionBroker;
  surfaces: readonly string[];
  /** The iMessage account the sends are bound to (`verifiedMessagesSends`' account). */
  account: string;
  /** A live node with Messages (and, when it has them, Contacts); undefined when none is. */
  node(): NodeClient | undefined;
  /** The node wrapped in the executor's binding check (`verifiedMessagesSends`). */
  sender(client: NodeClient): NodeClient;
  /** Sends one turn may make before the tool refuses to ask again. */
  maxPerTurn?: number;
}

const DEFAULT_MAX_PER_TURN = 5;
const MAX_CANDIDATES = 8;
const CHAT_SCAN = 200;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

const PHONE = /^\+?[\d\s().-]{7,20}$/;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** A phone in the form chat.db stores it (digits with a leading +), else the email lowercased. */
export function normalizeHandle(raw: string): string | undefined {
  const s = raw.trim();
  if (EMAIL.test(s)) return s.toLowerCase();
  if (!PHONE.test(s)) return undefined;
  const digits = s.replace(/\D/g, "");
  if (digits.length < 7) return undefined;
  return s.startsWith("+") ? `+${digits}` : digits.length === 10 ? `+1${digits}` : `+${digits}`;
}

const weakService = (s: MessagesService) => s === "sms" || s === "rcs";

interface Resolved {
  candidates: ComposeCandidate[];
  /** True when the node could not search Contacts, so a name may simply be unknown to us. */
  contactsUnavailable: boolean;
}

async function listChats(node: NodeClient, query?: string): Promise<MessagesChat[]> {
  const res = await node.invoke("messages.chats", {
    limit: CHAT_SCAN,
    ...(query === undefined ? {} : { query: query.slice(0, 128) }),
  });
  const chats = res.ok && isObj(res.result) ? res.result.chats : undefined;
  return Array.isArray(chats) ? (chats as MessagesChat[]) : [];
}

async function searchContacts(
  node: NodeClient,
  query: string,
): Promise<{ name: string; handles: string[] }[] | undefined> {
  const res = await node.invoke("contacts.search", { query: query.slice(0, 200), limit: 10 });
  if (!res.ok) return undefined;
  const list = isObj(res.result) ? res.result.contacts : res.result;
  if (!Array.isArray(list)) return [];
  const out: { name: string; handles: string[] }[] = [];
  for (const c of list) {
    if (!isObj(c) || typeof c.name !== "string") continue;
    const handles = [...strs(c.phones), ...strs(c.emails)]
      .map(normalizeHandle)
      .filter((h): h is string => h !== undefined);
    if (handles.length > 0) out.push({ name: c.name, handles: [...new Set(handles)] });
  }
  return out;
}

function groupCandidate(chat: MessagesChat): ComposeCandidate {
  const participants = chat.participants.map((p) => p.handle);
  return {
    id: `chat:${chat.chatId}`,
    kind: "chat",
    recipient: chat.chatId,
    label: chat.displayName ?? participants.join(", "),
    service: chat.service,
    weak: weakService(chat.service),
    participants,
  };
}

/** Who `to` means. Never picks for the owner: every plausible match is a candidate. */
export async function resolveRecipients(
  node: NodeClient,
  to: string,
  service: "imessage" | "sms" | undefined,
): Promise<Resolved> {
  const query = to.trim();
  const out = new Map<string, ComposeCandidate>();
  const add = (c: ComposeCandidate) => {
    if (!out.has(c.id) && out.size < MAX_CANDIDATES) out.set(c.id, c);
  };
  // Existing 1:1 chats say which service a handle really uses; iMessage unless one says SMS.
  const chats = await listChats(node).catch(() => [] as MessagesChat[]);
  const serviceOf = (handle: string): MessagesService => {
    if (service === "sms") return "sms";
    const known = chats.find(
      (c) => !c.isGroup && c.participants.length === 1 && c.participants[0]?.handle === handle,
    );
    return known?.service ?? "imessage";
  };
  const handleCandidate = (handle: string, name: string | null): ComposeCandidate => {
    const svc = serviceOf(handle);
    return {
      id: `handle:${handle}:${svc}`,
      kind: "handle",
      recipient: handle,
      label: name === null ? handle : `${name} · ${handle}`,
      service: svc,
      weak: weakService(svc),
    };
  };

  const direct = normalizeHandle(query);
  if (direct !== undefined) {
    add(handleCandidate(direct, null));
    return { candidates: [...out.values()], contactsUnavailable: false };
  }

  const lower = query.toLowerCase();
  const contacts = await searchContacts(node, query).catch(() => undefined);
  const handlesOfMatches = new Set<string>();
  for (const c of contacts ?? []) {
    for (const h of c.handles) {
      handlesOfMatches.add(h);
      add(handleCandidate(h, c.name));
    }
  }
  // Existing groups: by the name the participants gave it, else any group a matched person is in.
  for (const chat of chats) {
    if (!chat.isGroup) continue;
    const named = chat.displayName?.toLowerCase().includes(lower) === true;
    const withMatch =
      handlesOfMatches.size > 0 && chat.participants.some((p) => handlesOfMatches.has(p.handle));
    if (named || withMatch) add(groupCandidate(chat));
  }
  // A chat whose display name or handle matches, for people Contacts does not know.
  for (const chat of chats) {
    if (chat.isGroup) continue;
    const p = chat.participants[0];
    if (p?.handle.toLowerCase().includes(lower)) {
      add(handleCandidate(p.handle, null));
    }
  }
  return { candidates: [...out.values()], contactsUnavailable: contacts === undefined };
}

function describeCandidate(c: ComposeCandidate): Record<string, unknown> {
  return {
    id: c.id,
    label: c.label,
    service: c.service,
    ...(c.participants === undefined ? {} : { participants: c.participants }),
  };
}

export function messagesSendTool(deps: MessagesSendToolDeps): AgentToolRegistration {
  const max = deps.maxPerTurn ?? DEFAULT_MAX_PER_TURN;
  const sentThisRun = new Map<string, number>();
  return defineTool({
    name: "messages_send",
    description:
      'Send an iMessage from the owner\'s Mac. `to` is a contact name, a phone number, an email, or the name of an existing group chat; `text` is the message. The owner sees a card with the exact recipient and the text in an editable field, and may pick between candidates or edit the text before sending; the call waits for the answer and returns in the same turn: `status: sent` or `edited_and_sent` (with the text that went out), or `cancelled`. If nobody matches, it returns `no_match` without asking: tell the owner and ask who they meant, never invent a number. Several matches go on the card for the owner to pick. iMessage is preferred; pass `service: "sms"` only if the owner asked for SMS. No attachments. Do not call it more than once per message the owner asked for.',
    input: Type.Object({
      to: Type.String({ minLength: 1, maxLength: 320 }),
      text: Type.String({ minLength: 1, maxLength: 20000 }),
      service: Type.Optional(Type.Union([Type.Literal("imessage"), Type.Literal("sms")])),
    }),
    // The tool raises its own compose card; a plain write card on top would ask twice.
    sideEffect: "none",
    run: (p, ctx) => send(deps, max, sentThisRun, ctx, p),
  });
}

async function send(
  deps: MessagesSendToolDeps,
  max: number,
  sentThisRun: Map<string, number>,
  ctx: ToolRunContext,
  p: { to: string; text: string; service?: "imessage" | "sms" },
): Promise<ToolResult> {
  if (ctx.requester !== undefined && ctx.requester.role !== "owner") {
    throw new PsycheError("forbidden", "only the owner can send messages");
  }
  if (ctx.mode === "unattended") {
    throw new PsycheError(
      "approval_required",
      "sending a message needs the owner; ask again in a chat turn",
    );
  }
  const done = (output: Record<string, unknown>, isError = false): ToolResult => ({
    output,
    provenance: "trusted",
    ...(isError ? { isError: true } : {}),
  });
  if ((sentThisRun.get(ctx.runId) ?? 0) >= max) {
    return done({
      status: "limit",
      why: `already sent ${max} messages this turn; ask the owner before sending more`,
    });
  }
  const node = deps.node();
  if (node === undefined) {
    return done(
      { status: "unavailable", why: "no Mac with Messages is connected right now" },
      true,
    );
  }
  const { candidates, contactsUnavailable } = await resolveRecipients(node, p.to, p.service);
  if (candidates.length === 0) {
    return done({
      status: "no_match",
      to: p.to,
      why: contactsUnavailable
        ? "Contacts could not be searched and no chat matches; ask the owner for the number or email"
        : "no contact or chat matches; ask the owner who they meant or for the number or email",
    });
  }

  const compose: ComposeDetails = {
    channel: "imessage",
    account: deps.account,
    candidates,
    text: p.text,
    draftSha256: bodySha256(p.text),
    recipientSource: ctx.taint ? "untrusted" : "owner",
  };
  const first = candidates[0] as ComposeCandidate;
  const only = candidates.length === 1 ? first : undefined;
  const issued = await deps.broker.requestApproval({
    kind: "message_send",
    summary: `Send a message to ${only?.label ?? p.to}`.slice(0, 300),
    details: {
      channel: "imessage",
      account: deps.account,
      recipient: only?.label ?? "choose below",
      compose: compose as never,
      ...(ctx.taint
        ? { reason: "This turn read untrusted content, so this send is once only." }
        : {}),
    },
    bindingHash: composeBindingHash(deps.account, first.recipient, p.text),
    grantKey: `message_send|imessage|${deps.account}`,
    requestedBy: {
      runId: ctx.runId,
      taskId: ctx.taskId ?? null,
      threadId: ctx.threadId,
      toolCallId: ctx.callId,
    },
    sideEffect: "destructive",
    surfaces: [...deps.surfaces],
    scopesOffered: ["once"],
    taint: ctx.taint,
    ...(ctx.taint && ctx.taintSources !== undefined ? { taintSources: [...ctx.taintSources] } : {}),
  });
  const decision = await deps.broker.awaitDecision(issued.approval.id, ctx.signal);
  if (decision.status !== "approved") {
    return done({ status: "cancelled", sent: false, decision: decision.status });
  }
  const final = readFinal(decision.details);
  if (final === undefined) {
    return done({ status: "failed", sent: false, why: "the approval carries no final send" }, true);
  }
  const res = await deps.sender(node).invoke(
    "messages.send",
    {
      text: final.text,
      ...(final.kind === "chat" ? { chatId: final.recipient } : { to: final.recipient }),
      ...(final.service === "sms" ? { service: "sms" } : {}),
    },
    { approvalId: decision.id, signal: ctx.signal },
  );
  const label = candidates.find((c) => c.id === final.id)?.label ?? final.recipient;
  if (!res.ok) {
    return done(
      {
        status: "failed",
        sent: false,
        to: label,
        why: res.error?.message ?? "the Mac could not send it",
      },
      true,
    );
  }
  sentThisRun.set(ctx.runId, (sentThisRun.get(ctx.runId) ?? 0) + 1);
  return done({
    status: final.edited ? "edited_and_sent" : "sent",
    sent: true,
    to: label,
    service: final.service,
    ...(final.edited ? { text: final.text } : {}),
    ...(res.receipt === undefined ? {} : { receipt: res.receipt.summary }),
    ...(candidates.length > 1
      ? { chose: describeCandidate(candidates.find((c) => c.id === final.id) ?? first) }
      : {}),
  });
}
