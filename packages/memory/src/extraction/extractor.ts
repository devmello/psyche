import type { ModelEvent, ModelProvider, ModelRef, ModelRequest } from "@psyche/protocol";
import { type BatchPrompt, buildExtractPrompt, buildWorkPrompt } from "./prompt.ts";
import {
  type ExtractionOutput,
  extractionText,
  type ParseFailure,
  parseExtraction,
  parseWorkLane,
  type WorkLaneOutput,
} from "./schema.ts";
import type { BatchItem } from "./validate.ts";

/**
 * The extractor call site (docs/design/everything-memory-2026.md §5.1 stage 2). The ONE place in
 * the codebase where item text reaches a model for extraction, and the one place the lint test
 * (`extractor-lint.test.ts`) pins: `tools` is the empty list, `toolChoice` is `none`, there is no
 * session, memory, MEMORY.md, USER.md or vault, and the only thing returned is the parsed closed
 * form or a failure reason. Nothing here executes anything the model says. The work lane (MW7)
 * is the same call with a different prompt and closed form, through the same `run`.
 */

export interface ExtractorCall {
  provider: ModelProvider;
  model: ModelRef;
  items: readonly BatchItem[];
  people: readonly { handle: string; name: string; isOwner: boolean }[];
  /** Allow what a sender says about someone else (third-party batches only). */
  aboutOthers?: boolean;
  /** Open work items by opaque handle (`w1`): owner-authored batches may report progress on them. */
  work?: readonly { handle: string; name: string }[];
  signal?: AbortSignal;
}

export type ExtractorResult =
  | { ok: true; output: ExtractionOutput; tokensIn: number; tokensOut: number }
  | { ok: false; reason: ParseFailure; tokensIn: number; tokensOut: number };

export interface WorkExtractorCall {
  provider: ModelProvider;
  model: ModelRef;
  items: readonly BatchItem[];
  signal?: AbortSignal;
}

export type WorkExtractorResult =
  | { ok: true; output: WorkLaneOutput; tokensIn: number; tokensOut: number }
  | { ok: false; reason: ParseFailure; tokensIn: number; tokensOut: number };

type Raw =
  | { ok: true; text: string; tokensIn: number; tokensOut: number }
  | { ok: false; reason: ParseFailure; tokensIn: number; tokensOut: number };

async function run(
  provider: ModelProvider,
  model: ModelRef,
  prompt: BatchPrompt,
  signal: AbortSignal | undefined,
): Promise<Raw> {
  const request: ModelRequest = {
    model,
    system: prompt.system,
    messages: [{ role: "user", parts: [{ type: "text", text: prompt.user }] }],
    tools: [],
    toolChoice: "none",
    maxOutputTokens: 2000,
    temperature: 0,
  };
  const events: ModelEvent[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  try {
    for await (const e of provider.stream(request, signal === undefined ? {} : { signal })) {
      events.push(e);
      if (e.type === "usage") {
        tokensIn += e.usage.input;
        tokensOut += e.usage.output;
      }
      // A tool call from a model that was offered none: stop reading, the batch is rejected.
      if (e.type === "tool_call" || e.type === "tool_result") break;
    }
  } catch {
    return { ok: false, reason: "not_finished", tokensIn, tokensOut };
  }
  const text = extractionText(events);
  if (!text.ok) return { ok: false, reason: text.reason, tokensIn, tokensOut };
  return { ok: true, text: text.text, tokensIn, tokensOut };
}

export async function callExtractor(call: ExtractorCall): Promise<ExtractorResult> {
  const prompt = buildExtractPrompt(call.items, call.people, {
    ...(call.aboutOthers === undefined ? {} : { aboutOthers: call.aboutOthers }),
    ...(call.work === undefined ? {} : { work: call.work }),
  });
  const raw = await run(call.provider, call.model, prompt, call.signal);
  if (!raw.ok) return raw;
  const { tokensIn, tokensOut } = raw;
  const parsed = parseExtraction(raw.text);
  return parsed.ok
    ? { ok: true, output: parsed.output, tokensIn, tokensOut }
    : { ok: false, reason: parsed.reason, tokensIn, tokensOut };
}

/** The work lane: third-party notices from opted-in work senders, the closed assignment form. */
export async function callWorkExtractor(call: WorkExtractorCall): Promise<WorkExtractorResult> {
  const raw = await run(call.provider, call.model, buildWorkPrompt(call.items), call.signal);
  if (!raw.ok) return raw;
  const { tokensIn, tokensOut } = raw;
  const parsed = parseWorkLane(raw.text);
  return parsed.ok
    ? { ok: true, output: parsed.output, tokensIn, tokensOut }
    : { ok: false, reason: parsed.reason, tokensIn, tokensOut };
}
