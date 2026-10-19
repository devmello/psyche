import type {
  Block,
  FeedPost,
  Goal,
  Idea,
  LibraryItem,
  Message,
  Provenance,
  Task,
  TaskAction,
  Thread,
} from "@psyche/protocol";
import { OWNER_SCOPE, type SearchDoc } from "./types.ts";

/**
 * Per-type adapters: domain objects (protocol shapes) → `SearchDoc`. Pure functions; the
 * `SearchIndexer` calls them for Gateway events and the owners of other surfaces (library, feed,
 * ideas, goals, connectors) call them directly when they write.
 */

const ms = (iso: string | null | undefined): number | undefined =>
  iso == null ? undefined : Date.parse(iso);

/**
 * Scope of a thread. Designated-person threads (a persona overlay, architecture §4.10) are
 * scoped to their session key so a delegated search sees only its own conversation.
 */
export function threadScope(thread: Pick<Thread, "personaOverlay" | "sessionKey">): string {
  return thread.personaOverlay != null ? thread.sessionKey : OWNER_SCOPE;
}

export function isIncognito(thread: Pick<Thread, "kind">): boolean {
  return thread.kind === "incognito";
}

export function threadDoc(thread: Thread): SearchDoc {
  const updated = ms(thread.lastMessageAt) ?? ms(thread.updatedAt);
  return {
    id: thread.id,
    kind: "thread",
    title: thread.title,
    text: thread.title,
    provenance: "owner",
    threadId: thread.id,
    incognito: isIncognito(thread),
    scopeKey: threadScope(thread),
    createdAt: Date.parse(thread.createdAt),
    ...(updated === undefined ? {} : { updatedAt: updated }),
  };
}

/** Searchable text of message blocks: prose, tool lines, checklists, wrap-ups. */
export function blocksText(blocks: readonly Block[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case "text":
        parts.push(b.md);
        break;
      case "tool_call":
        parts.push(b.level1);
        break;
      case "checklist":
        for (const item of b.items) parts.push(item.text);
        break;
      case "wrap_up":
        parts.push(b.recap);
        if (b.ask !== undefined) parts.push(b.ask);
        break;
      case "artifact":
        if (b.preview !== undefined) parts.push(b.preview);
        break;
      default:
        break;
    }
  }
  return parts.join("\n");
}

export interface MessageContext {
  /** The message's thread; without it the message is indexed with owner scope. */
  thread?: Pick<Thread, "id" | "title" | "kind" | "personaOverlay" | "sessionKey">;
  /** Display name or address of the sender, for `from:`. */
  sender?: string;
}

export function messageDoc(message: Message, ctx: MessageContext = {}): SearchDoc {
  const t = ctx.thread;
  return {
    id: message.id,
    kind: "message",
    title: t?.title ?? "",
    text: blocksText(message.blocks),
    provenance: message.provenance,
    threadId: message.threadId,
    incognito: t !== undefined && isIncognito(t),
    scopeKey: t === undefined ? OWNER_SCOPE : threadScope(t),
    ...(ctx.sender === undefined ? {} : { from: ctx.sender }),
    createdAt: Date.parse(message.createdAt),
  };
}

/** True when a message carries a file (for `has:attachment`). */
export function hasAttachment(message: Pick<Message, "blocks">): boolean {
  return message.blocks.some((b) => b.type === "file" || b.type === "artifact");
}

export function taskDoc(
  task: Task,
  thread?: Pick<Thread, "kind" | "personaOverlay" | "sessionKey">,
): SearchDoc {
  const text = [
    task.goal,
    task.summary ?? "",
    ...(task.plan?.steps ?? []).map((s) => s.title),
    ...task.checklist.map((c) => c.text),
  ]
    .filter((s) => s.length > 0)
    .join("\n");
  return {
    id: task.id,
    kind: "task",
    title: task.title,
    text,
    provenance: task.taint === true ? "untrusted" : "owner",
    threadId: task.threadId,
    incognito: thread !== undefined && isIncognito(thread),
    scopeKey: thread === undefined ? OWNER_SCOPE : threadScope(thread),
    tags: [task.status],
    createdAt: Date.parse(task.createdAt),
    updatedAt: Date.parse(task.updatedAt),
  };
}

/** An Activity line; collapses onto its task in grouped results. */
export function taskActionDoc(
  action: TaskAction,
  task?: Pick<Task, "title" | "threadId">,
  scopeKey = OWNER_SCOPE,
): SearchDoc {
  const l2 = action.level2;
  return {
    id: action.id,
    kind: "task",
    title: task?.title ?? "",
    text: [action.level1, l2.tool, l2.target ?? "", l2.outcome ?? ""].join("\n").trim(),
    provenance: "agent",
    parentId: action.taskId,
    ...(task === undefined ? {} : { threadId: task.threadId }),
    scopeKey,
    createdAt: Date.parse(action.createdAt),
  };
}

/** Downloads, connector and channel files come from third parties. */
const LIBRARY_PROVENANCE: Record<LibraryItem["origin"], Provenance> = {
  upload: "owner",
  agent: "agent",
  download: "untrusted",
  connector: "untrusted",
  channel: "untrusted",
};

/** A Library item with its extracted text (PDF text, OCR, sheet cells; S13 extracts). */
export function libraryDoc(
  item: LibraryItem,
  extractedText = "",
  provenance: Provenance = LIBRARY_PROVENANCE[item.origin],
): SearchDoc {
  return {
    id: item.id,
    kind: "library",
    title: item.name,
    text: extractedText,
    provenance,
    mime: item.mime,
    tags: item.tags,
    ...(item.threadId === null ? {} : { threadId: item.threadId }),
    source: "library",
    createdAt: Date.parse(item.createdAt),
  };
}

/** Feed posts are written by the agent from network sources: provenance `untrusted`. */
export function feedDoc(post: FeedPost): SearchDoc {
  return {
    id: post.id,
    kind: "feed",
    title: post.title,
    text: [post.bodyMd, ...post.citations.map((c) => `${c.title} ${c.url}`)].join("\n"),
    provenance: "untrusted",
    tags: post.reasons,
    source: "feed",
    createdAt: Date.parse(post.createdAt),
  };
}

export function ideaDoc(idea: Idea): SearchDoc {
  return {
    id: idea.id,
    kind: "idea",
    title: idea.title,
    text: [idea.bodyMd, idea.effort].join("\n"),
    provenance: "agent",
    tags: [idea.kind, idea.status],
    source: "ideas",
    createdAt: Date.parse(idea.createdAt),
  };
}

export function goalDoc(goal: Goal): SearchDoc {
  return {
    id: goal.id,
    kind: "goal",
    title: goal.title,
    text: [goal.cadence ?? "", JSON.stringify(goal.plan ?? {})].join("\n"),
    provenance: goal.inferred ? "agent" : "owner",
    tags: [goal.category, goal.status],
    source: "goals",
    createdAt: Date.parse(goal.createdAt),
    updatedAt: Date.parse(goal.updatedAt),
  };
}

/** One cached connector record (an email, an event, a Drive file) the owner opted to index. */
export interface ConnectorItem {
  id: string;
  title: string;
  text: string;
  from?: string;
  mime?: string;
  tags?: string[];
  /** Epoch ms. */
  createdAt: number;
}

/** Connector content comes from third parties: provenance `untrusted`. */
export function connectorDoc(connectorId: string, item: ConnectorItem): SearchDoc {
  return {
    id: `${connectorId}:${item.id}`,
    kind: "connector",
    title: item.title,
    text: item.text,
    provenance: "untrusted",
    ...(item.from === undefined ? {} : { from: item.from }),
    ...(item.mime === undefined ? {} : { mime: item.mime }),
    tags: item.tags ?? [],
    source: `connector:${connectorId}`,
    createdAt: item.createdAt,
  };
}
