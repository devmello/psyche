import { type Static, Type } from "@sinclair/typebox";
import { StringEnum } from "../common.ts";

/**
 * Typed progress of a deep-research run (`research_run` / `research_followup`), streamed as the
 * `research.progress` event so the transcript can draw the progress card. Labels and counts only:
 * source titles are third-party text, so the client sanitizes them before display.
 */

export const ResearchProgressStep = StringEnum(
  ["scope", "plan", "read", "extract", "crosscheck", "synthesize", "save"],
  { $id: "ResearchProgressStep" },
);
export type ResearchProgressStep = Static<typeof ResearchProgressStep>;

export const ResearchProgressSubQuestion = Type.Object(
  { id: Type.String({ minLength: 1, maxLength: 64 }), question: Type.String({ maxLength: 500 }) },
  { $id: "ResearchProgressSubQuestion", additionalProperties: false },
);

export const ResearchProgressPlan = Type.Object(
  {
    subQuestions: Type.Array(ResearchProgressSubQuestion, { maxItems: 50 }),
    includeLocal: Type.Boolean(),
    estimatedTokens: Type.Number({ minimum: 0 }),
  },
  { $id: "ResearchProgressPlan", additionalProperties: false },
);

export const ResearchProgressEvent = Type.Union(
  [
    Type.Object({ type: Type.Literal("step"), step: ResearchProgressStep }),
    Type.Object({ type: Type.Literal("plan"), plan: ResearchProgressPlan }),
    Type.Object({
      type: Type.Literal("source"),
      url: Type.String({ maxLength: 2000 }),
      title: Type.String({ maxLength: 500 }),
      status: StringEnum(["reading", "read", "failed"]),
    }),
    Type.Object({ type: Type.Literal("claims"), count: Type.Number({ minimum: 0 }) }),
    Type.Object({
      type: Type.Literal("tokens"),
      used: Type.Number({ minimum: 0 }),
      budget: Type.Number({ minimum: 0 }),
    }),
    Type.Object({ type: Type.Literal("done"), artifactId: Type.String({ maxLength: 64 }) }),
    Type.Object({ type: Type.Literal("stopped") }),
  ],
  { $id: "ResearchProgressEvent" },
);
export type ResearchProgressEvent = Static<typeof ResearchProgressEvent>;
