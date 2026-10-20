import { type Static, Type } from "@sinclair/typebox";
import { IsoDateTime, StringEnum } from "../common.ts";

/**
 * Teach mode (feature J8; docs/03 J8). The owner demonstrates a flow in a Mac app while the mac
 * helper records what they click and type, as accessibility targets (and optional screenshots),
 * into a skill draft. Nothing is saved by the helper: the draft goes to the owner for review, and
 * only then into the workspace skills folder, where T2's `skill_install` trust card makes it
 * active. Owner-only: the agent never starts a recording. Added by S14.
 */

/** What a step acted on, from the accessibility tree at that moment. Labels are untrusted text. */
export const TeachTarget = Type.Object(
  {
    app: Type.String({ description: "Bundle id" }),
    appName: Type.String(),
    window: Type.Optional(Type.String({ maxLength: 200 })),
    role: Type.Optional(Type.String()),
    subrole: Type.Optional(Type.String()),
    label: Type.Optional(Type.String({ maxLength: 200 })),
    identifier: Type.Optional(Type.String({ maxLength: 200 })),
  },
  { $id: "TeachTarget" },
);
export type TeachTarget = Static<typeof TeachTarget>;

export const TeachStepKind = StringEnum(
  ["click", "right_click", "double_click", "type", "press", "skipped"],
  { $id: "TeachStepKind" },
);
export type TeachStepKind = Static<typeof TeachStepKind>;

/** A window screenshot taken right after a click; `path` is where the draft keeps it. */
export const TeachScreenshot = Type.Object(
  {
    path: Type.String({ description: "Path in the draft, e.g. screens/step-3.jpg" }),
    mimeType: Type.String(),
    base64: Type.String(),
  },
  { $id: "TeachScreenshot" },
);
export type TeachScreenshot = Static<typeof TeachScreenshot>;

export const TeachEndedBy = StringEnum(["stop", "timeout", "limit", "cancel"], {
  $id: "TeachEndedBy",
});
export type TeachEndedBy = Static<typeof TeachEndedBy>;

/**
 * One recorded step. `type` steps carry the typed `text`, except in a password field, where
 * `secure` is true and nothing typed is kept. `skipped` steps stand for input in apps teach mode
 * never records (Psyche, password managers, finance, system authority prompts): no target, no text.
 */
export const TeachStep = Type.Object(
  {
    index: Type.Integer({ minimum: 1 }),
    kind: TeachStepKind,
    at: IsoDateTime,
    target: Type.Optional(TeachTarget),
    text: Type.Optional(Type.String({ maxLength: 2000 })),
    secure: Type.Optional(Type.Boolean()),
    keys: Type.Optional(Type.String({ description: "A chord, e.g. cmd+s, return" })),
    note: Type.Optional(Type.String()),
    screenshot: Type.Optional(TeachScreenshot),
  },
  { $id: "TeachStep" },
);
export type TeachStep = Static<typeof TeachStep>;

/** `teach.start`. Recording stops on `teach.stop`, `teach.cancel`, `maxSeconds` or `maxSteps`. */
export const TeachStartParams = Type.Object(
  {
    name: Type.Optional(
      Type.String({
        pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
        maxLength: 64,
        description: "Skill name",
      }),
    ),
    description: Type.Optional(Type.String({ maxLength: 1024 })),
    app: Type.Optional(Type.String({ description: "Record only this bundle id" })),
    screenshots: Type.Optional(
      Type.Boolean({ description: "Window screenshot after each click (default false)" }),
    ),
    maxSteps: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    maxSeconds: Type.Optional(Type.Integer({ minimum: 10, maximum: 1800 })),
  },
  { $id: "TeachStartParams" },
);
export type TeachStartParams = Static<typeof TeachStartParams>;

/** `teach.stop` / `teach.cancel` / `teach.status`. */
export const TeachSessionParams = Type.Object(
  { sessionId: Type.String({ minLength: 1 }) },
  { $id: "TeachSessionParams" },
);
export type TeachSessionParams = Static<typeof TeachSessionParams>;

/** A file of the skill draft. Screenshots are listed by path; their bytes came with the steps. */
export const TeachDraftFile = Type.Object(
  {
    path: Type.String(),
    text: Type.Optional(Type.String()),
    fromStep: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { $id: "TeachDraftFile" },
);
export type TeachDraftFile = Static<typeof TeachDraftFile>;

/** The result of `teach.start` (when recording ends) and of `teach.stop`. Never saved by the helper. */
export const TeachDraft = Type.Object(
  {
    sessionId: Type.String(),
    name: Type.String(),
    description: Type.String(),
    startedAt: IsoDateTime,
    endedAt: IsoDateTime,
    endedBy: TeachEndedBy,
    steps: Type.Array(TeachStep, { description: "Without screenshot bytes" }),
    files: Type.Array(TeachDraftFile, { description: "SKILL.md first" }),
  },
  { $id: "TeachDraft" },
);
export type TeachDraft = Static<typeof TeachDraft>;

/** Streamed by `teach.start` (`node.event` data). */
export const TeachStepEvent = Type.Object(
  { type: Type.Literal("teach.step"), sessionId: Type.String(), step: TeachStep },
  { $id: "TeachStepEvent" },
);
export type TeachStepEvent = Static<typeof TeachStepEvent>;
