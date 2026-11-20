import { randomUUID } from "node:crypto";
import {
  fenceUntrustedText,
  isCheckedImagePart,
  isPartList,
  keepRecentToolImages,
  type ThreadState,
  type ThreadStateStore,
} from "@psyche/agent-core";
import {
  getAgentThreadState,
  listAllMessages,
  type PsycheDb,
  putAgentThreadState,
} from "@psyche/db";
import type { TaintSource } from "@psyche/permissions";
import type { ModelMessage } from "@psyche/protocol";
import { resolveAttachments } from "../session/attachments.ts";

/** Masks registered secret values in every string of a JSON value (`SecretRedactor.redact`). */
export interface StringMasker {
  redact(text: string): string;
}

function maskDeep(value: unknown, masker: StringMasker): unknown {
  if (typeof value === "string") return masker.redact(value);
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, masker));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, maskDeep(v, masker)]),
    );
  }
  return value;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** An image part with its `data` left as it is and every other field masked. */
function keepImageData(part: Record<string, unknown>, masker: StringMasker): unknown {
  const { data, ...rest } = part;
  return { ...(maskDeep(rest, masker) as Record<string, unknown>), data };
}

/**
 * `maskDeep` over a thread state, except image bytes in two places, and only there: images in a
 * part-list output of a loop-run tool result (a `tool` message; every one came through the
 * loop's image check and was re-encoded, so its bytes are a decoder's output, not tool text),
 * and image parts of the owner's own messages. Masking megabytes of base64 blocks the event
 * loop, and a mask written into it corrupts the image. An image-shaped object anywhere else
 * (a record a tool returned, a provider-run tool's result in an assistant message) is masked
 * like any other value.
 */
function maskState(state: ThreadState, masker: StringMasker): ThreadState {
  const { messages, ...rest } = state;
  const masked = (messages as unknown[]).map((m) => {
    if (!isRecord(m) || !Array.isArray(m.parts)) return maskDeep(m, masker);
    const { parts, ...fields } = m;
    return {
      ...(maskDeep(fields, masker) as Record<string, unknown>),
      parts: parts.map((p: unknown) => {
        if (m.role === "user" && isCheckedImagePart(p)) return keepImageData(p, masker);
        if (m.role === "tool" && isRecord(p) && p.type === "tool_result" && isPartList(p.output)) {
          const { output, ...head } = p;
          return {
            ...(maskDeep(head, masker) as Record<string, unknown>),
            output: (output as unknown[]).map((x) =>
              isCheckedImagePart(x) ? keepImageData(x, masker) : maskDeep(x, masker),
            ),
          };
        }
        return maskDeep(p, masker);
      }),
    };
  });
  return { ...(maskDeep(rest, masker) as object), messages: masked } as ThreadState;
}

/**
 * Durable `ThreadStateStore` over the Gateway database (issue #52): the loop's model-side history
 * (provider-native messages after compaction, summary, pinned checklist, carried taint) survives a
 * restart. The loop only ever holds `{{cred:…}}` placeholders; as defense in depth every string is
 * passed through the vault's redactor before it is written, so a resolved secret never lands on
 * disk even if one slipped into a tool result.
 */
export class SqliteThreadStateStore implements ThreadStateStore {
  readonly #db: PsycheDb;
  readonly #masker: StringMasker | null;
  readonly #home: string | null;
  readonly #refresh: ((threadId: string, state: ThreadState) => boolean) | null;

  constructor(
    db: PsycheDb,
    masker: StringMasker | null = null,
    home: string | null = null,
    /** Called with a saved thread before a turn; true when it edited the state (saved back). */
    refresh: ((threadId: string, state: ThreadState) => boolean) | null = null,
  ) {
    this.#db = db;
    this.#masker = masker;
    this.#home = home;
    this.#refresh = refresh;
  }

  async load(threadId: string): Promise<ThreadState | undefined> {
    const stored = getAgentThreadState(this.#db, threadId) as ThreadState | undefined;
    if (stored !== undefined && (stored.messages.length > 0 || stored.summary !== undefined)) {
      if (this.#refresh?.(threadId, stored) === true) await this.save(threadId, stored);
      return stored;
    }
    return (await this.#rebuild(threadId)) ?? stored;
  }

  /**
   * A thread whose transcript exists but whose model-side state does not (a fork or an edited
   * resend copies the transcript rows only; a restored backup or an older database has no state
   * row): the model must still see what the owner sees. Rebuilt from the persisted messages as
   * plain text turns, with each attachment re-read from the Library. The newest user message is
   * left out: it is the turn being started, and the loop appends it itself.
   */
  async #rebuild(threadId: string): Promise<ThreadState | undefined> {
    const rows = listAllMessages(this.#db, threadId);
    const last = rows.at(-1);
    const history = last?.role === "user" ? rows.slice(0, -1) : rows;
    const out: ModelMessage[] = [];
    const taint: TaintSource[] = [];
    for (const m of history) {
      if (m.role !== "user" && m.role !== "agent") continue;
      const text = m.blocks.flatMap((b) => (b.type === "text" ? [b.md] : [])).join("\n\n");
      const files = m.blocks.flatMap((b) => (b.type === "file" ? [b.libraryItemId] : []));
      let images: { mime: string; data: string }[] = [];
      // Extracted file text is the file's, in its own part ahead of the words, as it was live:
      // untrusted (and tainting) for someone else's files, `ownerFile` for the owner's own.
      let attachedText = "";
      let notesText = "";
      let thirdParty = false;
      if (m.role === "user" && files.length > 0) {
        if (this.#home === null) {
          notesText = `[attached library items: ${files.join(", ")}]`;
        } else {
          const attached = await resolveAttachments(this.#db, this.#home, files);
          attachedText = attached.body;
          notesText = attached.notes;
          images = attached.images;
          thirdParty = attached.taint.length > 0;
          taint.push(...attached.taint);
        }
      }
      const nonOwner = m.provenance === "untrusted";
      if (text.trim() === "" && attachedText === "" && notesText === "" && images.length === 0) {
        continue;
      }
      const role = m.role === "user" ? "user" : "assistant";
      const prev = out.at(-1);
      const fence = randomUUID().replaceAll("-", "").slice(0, 16);
      // Only the owner's own typed rows are owner-marked: not an agent's message
      // (`thread_message`), not a widget act, not a non-owner's.
      const ownerTyped = m.role === "user" && m.provenance === "owner" && m.via !== "widget";
      const typedPart: ModelMessage["parts"] =
        text.trim() === ""
          ? []
          : nonOwner
            ? [
                {
                  type: "text",
                  text: fenceUntrustedText("Message from a non-owner", text, fence),
                  provenance: "untrusted",
                },
              ]
            : [ownerTyped ? { type: "text", text, author: "owner" } : { type: "text", text }];
      // Images stay images (resized, never base64 text): the estimator charges them by size.
      const parts: ModelMessage["parts"] = [
        ...(attachedText === ""
          ? []
          : [
              {
                type: "text" as const,
                text: fenceUntrustedText(
                  "Attached file text",
                  attachedText,
                  fence,
                  thirdParty || nonOwner ? "third_party" : "owner",
                ),
                ...(thirdParty || nonOwner
                  ? { provenance: "untrusted" as const }
                  : { ownerFile: true as const }),
              },
            ]),
        ...(notesText === "" ? [] : [{ type: "text" as const, text: notesText }]),
        ...typedPart,
        // A third party's images are untrusted, as they were live (the turn's input taint).
        ...images.map((i) => ({
          type: "image" as const,
          mime: i.mime,
          data: i.data,
          ...(thirdParty || nonOwner ? { provenance: "untrusted" as const } : {}),
        })),
      ];
      const untrusted = role === "user" && (thirdParty || nonOwner);
      if (prev?.role === role) {
        prev.parts.push(...parts);
        if (untrusted) prev.untrusted = true;
      } else out.push({ role, parts, ...(untrusted ? { untrusted: true as const } : {}) });
    }
    if (out.length === 0) return undefined;
    // Third-party files re-read into the context keep the thread tainted, as they did live.
    return {
      messages: out,
      checklist: [],
      ...(taint.length === 0 ? {} : { taint: { sources: taint } }),
    };
  }

  async save(threadId: string, state: ThreadState): Promise<void> {
    // Older tool images are saved as their note: the stored thread holds at most a dozen.
    const messages = keepRecentToolImages(state.messages);
    const trimmed = messages === state.messages ? state : { ...state, messages };
    const safe = this.#masker === null ? trimmed : maskState(trimmed, this.#masker);
    putAgentThreadState(this.#db, threadId, safe as unknown as Record<string, unknown>);
  }
}
