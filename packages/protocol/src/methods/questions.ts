import { Type } from "@sinclair/typebox";
import { Id } from "../common.ts";
import { InputRequest, InputRequestStatus } from "../schemas/tasks.ts";
import { defineMethod, nextCursor, pageParams } from "./define.ts";

/** `questions.*`: structured `ask_user` input requests (architecture §4.3; feature C4). */

/** One answer per question, keyed by the question's `header`; multi-select answers are arrays. */
export const QuestionAnswers = Type.Record(
  Type.String({ pattern: "^.{1,12}$" }),
  Type.Union([
    Type.String({ maxLength: 4000 }),
    Type.Array(Type.String({ maxLength: 4000 }), { maxItems: 4 }),
  ]),
  { $id: "QuestionAnswers", additionalProperties: false },
);

export const InputRequestResult = Type.Object(
  { inputRequest: InputRequest },
  { $id: "InputRequestResult" },
);

export const QuestionsMethods = {
  "questions.list": defineMethod({
    params: Type.Object({
      threadId: Type.Optional(Id),
      taskId: Type.Optional(Id),
      status: Type.Optional(Type.Array(InputRequestStatus)),
      ...pageParams,
    }),
    result: Type.Object({ inputRequests: Type.Array(InputRequest), ...nextCursor }),
    scope: "operator.read",
    description: "Lists input requests (default: open), newest first.",
  }),
  "questions.get": defineMethod({
    params: Type.Object({ inputRequestId: Id }),
    result: InputRequestResult,
    scope: "operator.read",
    description: "Returns one input request with its questions and answer.",
  }),
  "questions.answer": defineMethod({
    params: Type.Object({ inputRequestId: Id, answer: QuestionAnswers }),
    result: InputRequestResult,
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Answers an open input request; the run that asked consumes it. Side-effecting: a repeat with the same key returns the original result.",
  }),
} as const;
