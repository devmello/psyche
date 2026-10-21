import type { ModelMessage, ModelPart } from "@psyche/protocol";

/**
 * What a subscription-CLI run is told. The CLI keeps the conversation in its own session, so a
 * thread resumes it (`--resume` / `exec resume`) and sends only what is new since the last turn
 * that CLI answered. Without such a turn (first turn, or the thread came from another model),
 * earlier turns are rendered as a transcript in the first user message.
 */

/** Opaque `reasoning` data a CLI turn stores so the next turn can resume its session. */
export interface CliSessionEnvelope {
  v: 1;
  kind: "cli-session";
  model: string;
  sessionId: string;
  /** Codex: the thread's running usage totals at the end of this turn (its events are cumulative). */
  totals?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
  };
}

export function isCliSessionEnvelope(data: unknown): data is CliSessionEnvelope {
  const d = data as Partial<CliSessionEnvelope> | null;
  return (
    typeof d === "object" &&
    d !== null &&
    d.v === 1 &&
    d.kind === "cli-session" &&
    typeof d.sessionId === "string" &&
    d.sessionId.length > 0
  );
}

export interface PromptImage {
  mime: string;
  /** Base64. */
  data: string;
}

export interface CliPrompt {
  /** The CLI session to resume, when an earlier turn of this thread ran on this provider. */
  resume?: string;
  /** Usage totals the resumed session had reached (Codex). */
  resumeTotals?: CliSessionEnvelope["totals"];
  text: string;
  images: PromptImage[];
}

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function renderPart(p: ModelPart): string | undefined {
  switch (p.type) {
    case "text":
      return p.text;
    case "image":
      return "[image]";
    case "tool_call":
      return `[called ${p.name} ${outputText(p.input)}]`;
    case "tool_result":
      return `[${p.name ?? "tool"} result${p.isError === true ? " (error)" : ""}: ${outputText(p.output)}]`;
    default:
      return undefined;
  }
}

function render(messages: readonly ModelMessage[]): string {
  return messages
    .map((m) => {
      const body = m.parts
        .map(renderPart)
        .filter((t): t is string => t !== undefined && t.length > 0)
        .join("\n");
      return body.length === 0 ? "" : `${m.role}: ${body}`;
    })
    .filter((t) => t.length > 0)
    .join("\n\n");
}

/** Build the prompt for a new CLI run of provider `providerId`. */
export function cliPrompt(messages: readonly ModelMessage[], providerId: string): CliPrompt {
  let k = -1;
  let resume: string | undefined;
  let totals: CliSessionEnvelope["totals"];
  for (let i = messages.length - 1; i >= 0 && k < 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    for (const p of m.parts) {
      if (p.type === "reasoning" && p.provider === providerId && isCliSessionEnvelope(p.data)) {
        k = i;
        resume = p.data.sessionId;
        totals = p.data.totals;
      }
    }
  }
  const fresh = messages.slice(k + 1);
  // The images of the newest user message go along as images; older ones are mentioned.
  let lastUser = -1;
  for (const [i, m] of fresh.entries()) if (m.role === "user") lastUser = i;
  const images: PromptImage[] = [];
  for (const p of fresh[lastUser]?.parts ?? []) {
    if (p.type === "image" && p.data !== undefined) images.push({ mime: p.mime, data: p.data });
  }
  const onlyUser = fresh.every((m) => m.role === "user");
  let text: string;
  if (onlyUser) {
    text = fresh
      .flatMap((m) => m.parts)
      .flatMap((p) => (p.type === "text" ? [p.text] : []))
      .join("\n\n");
  } else {
    // Only a trailing run of user messages is "the new message"; everything before it, tool
    // calls and their results included, goes in the transcript (#538: a history that ends with a
    // tool result used to lose the tool exchange, so the CLI asked for the tool again).
    let start = fresh.length;
    while (start > 0 && fresh[start - 1]?.role === "user") start -= 1;
    const before = fresh.slice(0, start);
    const latest = fresh.slice(start);
    const intro =
      resume === undefined
        ? "The conversation so far (earlier turns, for context):"
        : "Since your last reply in this conversation:";
    const latestText = latest
      .flatMap((m) => m.parts)
      .flatMap((p) => (p.type === "text" ? [p.text] : []))
      .join("\n\n");
    const endsWithResults = before.at(-1)?.role === "tool";
    const closing =
      latestText.length > 0
        ? latestText
        : endsWithResults
          ? "The tool calls above already ran and their results are shown. Answer the last request using those results; do not call the tools again for it."
          : "Continue.";
    text = `${intro}\n\n<transcript>\n${render(before)}\n</transcript>\n\n${closing}`;
  }
  return {
    ...(resume === undefined ? {} : { resume }),
    ...(totals === undefined ? {} : { resumeTotals: totals }),
    text,
    images,
  };
}
