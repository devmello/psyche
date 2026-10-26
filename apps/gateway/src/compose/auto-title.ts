import { getSetting, getThread, listAllMessages, type PsycheDb, updateThread } from "@psyche/db";
import type { Message, ModelProvider, ModelRef, Run, Thread } from "@psyche/protocol";
import type { SecretRedactor } from "@psyche/vault";
import type { Logger } from "../log.ts";
import type { ComposedPart } from "./services.ts";

/**
 * Auto-naming new chats. After a chat's first finished reply the thread gets a title in two
 * steps, neither of which blocks the reply:
 *  1. at once, a free heuristic title (the first message cleaned and cut at a word boundary);
 *  2. then one tiny utility-model call (`maxOutputTokens` 24, ~120 input tokens) that replaces
 *     it with a 3–6 word title. The utility role can be a local model (Ollama, llama.cpp,
 *     LM Studio), so the call can cost nothing.
 * If the call fails, times out or returns junk, the heuristic title stays. An owner rename
 * (`titleSource: "user"`) is never overwritten.
 *
 * Setting `chat.autoTitle`: `"model"` (default), `"heuristic"` (never call a model) or `"off"`
 * (threads stay untitled; `false` also means off).
 */

export const AUTO_TITLE_SETTING = "chat.autoTitle";
export type AutoTitleMode = "model" | "heuristic" | "off";

const HEURISTIC_MAX = 48;
const MODEL_TITLE_MAX = 60;
const SNIPPET_MAX = 400;
const MODEL_TIMEOUT_MS = 8_000;

export const TITLE_SYSTEM = `You name a chat. Reply with a title of 3 to 6 words for the conversation below: no quotes, no trailing punctuation, no prefix like "Title:". Use the language the owner wrote in.`;

export function autoTitleMode(db: PsycheDb): AutoTitleMode {
  const v = getSetting(db, AUTO_TITLE_SETTING)?.value;
  if (v === false || v === "off") return "off";
  return v === "heuristic" ? "heuristic" : "model";
}

/** The first message as a short title: no markdown, links or code; cut at a word boundary. */
export function heuristicTitle(text: string): string {
  const cleaned = text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/[*_#>~[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned === "") return "";
  const firstSentence = /^(.+?[.!?])(\s|$)/.exec(cleaned)?.[1] ?? cleaned;
  const base = firstSentence.length >= 8 ? firstSentence : cleaned;
  const stripped = base.replace(/[.!?:,;\s]+$/, "");
  if (stripped.length <= HEURISTIC_MAX) return upperFirst(stripped);
  const cut = stripped.slice(0, HEURISTIC_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  const trimmed = (lastSpace > HEURISTIC_MAX / 2 ? cut.slice(0, lastSpace) : cut).replace(
    /[.!?:,;\s]+$/,
    "",
  );
  return `${upperFirst(trimmed)}…`;
}

const upperFirst = (s: string) => (s === "" ? s : s.charAt(0).toUpperCase() + s.slice(1));

/** A model's answer as a title, or `undefined` when it is not usable. */
export function cleanModelTitle(raw: string): string | undefined {
  const line = raw.split("\n").find((l) => l.trim() !== "") ?? "";
  const title = line
    .replace(/^\s*(title|chat title|name)\s*[:\-–]\s*/i, "")
    .replace(/^["'“”‘’`*#\s]+|["'“”‘’`*\s]+$/g, "")
    .replace(/[.!?:,;]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (title === "" || title.length > MODEL_TITLE_MAX || title.split(" ").length > 12) {
    return undefined;
  }
  return title;
}

function textOf(m: Message): string {
  return m.blocks
    .flatMap((b) => (b.type === "text" ? [b.md] : []))
    .join("\n")
    .trim();
}

export interface AutoTitleDeps {
  db: PsycheDb;
  provider: ModelProvider;
  /** The utility model (or the primary when none is configured). */
  model: ModelRef;
  redactor: Pick<SecretRedactor, "redact">;
  publish(event: "thread.updated", payload: { thread: Thread }, threadId: string): void;
  logger?: Logger;
  /** Test hook: how long the model call may take. */
  timeoutMs?: number;
}

export function createAutoTitler(deps: AutoTitleDeps) {
  const { db } = deps;
  const inFlight = new Set<string>();

  const apply = (threadId: string, title: string, expectCurrent: string) => {
    const now = getThread(db, threadId);
    if (now === undefined || now.titleSource !== "auto" || now.title !== expectCurrent) return;
    const updated = updateThread(db, threadId, { title });
    if (updated !== undefined) deps.publish("thread.updated", { thread: updated }, threadId);
  };

  const nameWithModel = async (owner: string, agent: string): Promise<string | undefined> => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), deps.timeoutMs ?? MODEL_TIMEOUT_MS);
    try {
      const body = [`Owner: ${owner}`, ...(agent === "" ? [] : [`Assistant: ${agent}`])].join("\n");
      let out = "";
      for await (const e of deps.provider.stream(
        {
          model: deps.model,
          system: TITLE_SYSTEM,
          messages: [{ role: "user", parts: [{ type: "text", text: body }] }],
          maxOutputTokens: 24,
          temperature: 0,
        },
        { signal: ctl.signal },
      )) {
        if (e.type === "text_delta") out += e.text;
        if (e.type === "finish" && e.reason !== "stop" && e.reason !== "length") return undefined;
      }
      return cleanModelTitle(out);
    } finally {
      clearTimeout(timer);
    }
  };

  /** Called when a run finishes; names the thread the first time only. */
  const onRunFinished = async (run: Pick<Run, "threadId" | "status">): Promise<void> => {
    if (run.status !== "done") return;
    const threadId = run.threadId;
    const mode = autoTitleMode(db);
    if (mode === "off" || inFlight.has(threadId)) return;
    const thread = getThread(db, threadId);
    // The main thread is the one standing conversation; only chats the owner starts get names (incognito
    // chats never reach a model for housekeeping).
    if (thread === undefined || thread.kind !== "side" || thread.titleSource !== "auto") return;
    if (thread.title !== "") return;
    inFlight.add(threadId);
    try {
      const messages = listAllMessages(db, threadId);
      const first = messages.find((m) => m.role === "user");
      const ownerText = first === undefined ? "" : deps.redactor.redact(textOf(first)).trim();
      if (ownerText === "") return;
      const quick = heuristicTitle(ownerText);
      if (quick === "") return;
      apply(threadId, quick, "");
      if (mode !== "model") return;
      const reply = messages.find((m) => m.role === "agent");
      const agentText = reply === undefined ? "" : deps.redactor.redact(textOf(reply)).trim();
      try {
        const better = await nameWithModel(
          ownerText.slice(0, SNIPPET_MAX),
          agentText.slice(0, SNIPPET_MAX),
        );
        if (better !== undefined) apply(threadId, better, quick);
      } catch (err) {
        deps.logger?.log(
          "debug",
          "chat auto-title model call failed; keeping the first-message title",
          {
            threadId,
            error: err instanceof Error ? err.name : "error",
          },
        );
      }
    } finally {
      inFlight.delete(threadId);
    }
  };

  const part = (): ComposedPart => {
    let unsubscribe: (() => void) | undefined;
    return {
      start: (gw) => {
        unsubscribe = gw.bus.subscribe(["operator.read"], (frame) => {
          const f = JSON.parse(frame) as { event?: string; payload?: { run?: Run } };
          if (f.event !== "run.updated" || f.payload?.run === undefined) return;
          // Fire and forget: naming never holds up a reply or a queued turn.
          void onRunFinished(f.payload.run).catch(() => undefined);
        });
      },
      stop: () => {
        unsubscribe?.();
        unsubscribe = undefined;
      },
    };
  };

  return { onRunFinished, part };
}
