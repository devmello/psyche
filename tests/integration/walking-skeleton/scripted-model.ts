import type {
  CallOptions,
  ModelCapabilities,
  ModelEvent,
  ModelProvider,
  ModelRequest,
} from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";

/**
 * The scenario's scripted model. Three lanes, each a `FakeModelProvider` script, so turns of
 * the chat, the background task and the utility model (memory flush, compaction summary) never
 * steal each other's steps however the worker pool and the chat interleave:
 * - `utility`: requests for the utility model ref;
 * - `task`: unattended task turns (their input carries the task marker);
 * - `chat`: everything else.
 */

export const MAIN = "fake/main";
export const UTILITY = "fake/utility";
export const TASK_MARKER = "BACKGROUND-RESEARCH";
export const FLUSH_FACT =
  "The owner keeps the grocery list in notes.md and shops at the corner shop.";

const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 };

export const say = (text: string, reason: "stop" | "tool_calls" = "stop"): ModelEvent[] => [
  { type: "text_delta", text },
  { type: "usage", usage },
  { type: "finish", reason },
];

export const calls = (...cs: [id: string, name: string, input: unknown][]): ModelEvent[] => [
  ...cs.map(([id, name, input]): ModelEvent => ({ type: "tool_call", id, name, input })),
  { type: "usage", usage },
  { type: "finish", reason: "tool_calls" },
];

function mentions(req: ModelRequest, marker: string): boolean {
  return req.messages.some((m) =>
    m.parts.some((p) => p.type === "text" && p.text.includes(marker)),
  );
}

export class ScriptedModel implements ModelProvider {
  readonly id = "fake";
  readonly chat = new FakeModelProvider({ capabilities: { contextWindow: 200_000 } });
  readonly task = new FakeModelProvider();
  readonly utilityRequests: ModelRequest[] = [];

  stream(req: ModelRequest, opts?: CallOptions): AsyncIterable<ModelEvent> {
    if (req.model === UTILITY) return this.#utility(req);
    return (mentions(req, TASK_MARKER) ? this.task : this.chat).stream(req, opts);
  }

  async *#utility(req: ModelRequest): AsyncIterable<ModelEvent> {
    this.utilityRequests.push(req);
    const flush = (req.system ?? "").includes("daily notes");
    yield* say(flush ? `- ${FLUSH_FACT}` : "The owner asked to add eggs to notes.md; done.");
  }

  async capabilities(): Promise<ModelCapabilities> {
    return {
      toolCalling: true,
      vision: false,
      reasoning: false,
      embeddings: false,
      contextWindow: 200_000,
    };
  }
}
