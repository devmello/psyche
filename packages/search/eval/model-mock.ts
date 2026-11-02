import type { ModelProvider } from "@psyche/protocol";
import type { CorpusDoc, Question } from "./run.ts";

/**
 * A stand-in for the cheap query model (`--mode model`, no key needed). It is an *oracle upper
 * bound*, not a measurement of Haiku: for each question it answers with the date window of the
 * gold documents (padded by a day) and the question's own content words, so the numbers show how
 * much a perfect reading could add where the rules were unsure. A real run needs `--llm`.
 */
export function oracleQueryProvider(
  questions: readonly Question[],
  corpus: readonly CorpusDoc[],
): ModelProvider {
  const byId = new Map(corpus.map((d) => [d.id, d]));
  const byQuestion = new Map(questions.map((q) => [q.q.toLowerCase(), q]));
  return {
    async *stream(req: { messages: { parts: { text?: string }[] }[] }) {
      const text = req.messages[0]?.parts[0]?.text ?? "";
      const asked = /<question>\n([\s\S]*?)\n<\/question>/.exec(text)?.[1]?.toLowerCase() ?? "";
      const q = byQuestion.get(asked);
      const dates = (q?.gold ?? [])
        .flatMap((id) => byId.get(id)?.createdAt ?? [])
        .map((d) => Date.parse(d))
        .sort((a, b) => a - b);
      const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
      const first = dates[0];
      const last = dates[dates.length - 1];
      const plan =
        first === undefined || last === undefined
          ? { terms: [], intent: q?.intent ?? "find" }
          : {
              terms: [],
              after: day(first - 86_400_000),
              before: day(last + 86_400_000),
              intent: q?.intent ?? "find",
            };
      yield { type: "text_delta", text: JSON.stringify(plan) };
      yield { type: "finish", reason: "stop" };
    },
  } as unknown as ModelProvider;
}
