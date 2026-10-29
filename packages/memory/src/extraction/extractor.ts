import type { ModelEvent, ModelProvider, ModelRef, ModelRequest } from "@psyche/protocol";
import { buildExtractPrompt } from "./prompt.ts";
import {
  type ExtractionOutput,
  extractionText,
  type ParseFailure,
  parseExtraction,
} from "./schema.ts";
import type { BatchItem } from "./validate.ts";

/**
 * The extractor call site (docs/design/everything-memory-2026.md §5.1 stage 2). The ONE place in
 * the codebase where item text reaches a model for extraction, and the one place the lint test
 * (`extractor-lint.test.ts`) pins: `tools` is the empty list, `toolChoice` is `none`, there is no
 * session, memory, MEMORY.md, USER.md or vault, and the only thing returned is the parsed closed
 * form or a failure reason. Nothing here executes anything the model says.
 */

export interface ExtractorCall {
  provider: ModelProvider;
  model: ModelRef;
  items: readonly BatchItem[];
  people: readonly { handle: string; name: string; isOwner: boolean }[];
  signal?: AbortSignal;
}

export type ExtractorResult =
  | { ok: true; output: ExtractionOutput; tokensIn: number; tokensOut: number }
  | { ok: false; reason: ParseFailure; tokensIn: number; tokensOut: number };

export async function callExtractor(call: ExtractorCall): Promise<ExtractorResult> {
  const prompt = buildExtractPrompt(call.items, call.people);
  const request: ModelRequest = {
    model: call.model,
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
    for await (const e of call.provider.stream(
      request,
      call.signal === undefined ? {} : { signal: call.signal },
    )) {
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
  const parsed = parseExtraction(text.text);
  return parsed.ok
    ? { ok: true, output: parsed.output, tokensIn, tokensOut }
    : { ok: false, reason: parsed.reason, tokensIn, tokensOut };
}
