import { type Static, Type } from "@sinclair/typebox";
import { IsoDateTime, StringEnum } from "../common.ts";
import { defineMethod } from "./define.ts";
import { BrowserTeachStep } from "./skills.ts";

/**
 * `teach.app.*` Teach by showing in a desktop app (J8 phase 2, docs/design/teach-by-showing-2026.md
 * §13). The owner picks one app they already granted for computer use, does the task once and
 * stops; the Host helper (Mac or Windows) watches that app's accessibility events and returns semantic steps.
 *
 * Only the Psyche desktop shell on the Host may call these methods (the desktop's main process,
 * on the owner's click). The Host helper's `teach.record.*` capabilities are unreachable through
 * `nodes.invoke` and the agent's node tools, and no agent tool starts, stops or reads a
 * recording. The review and save path is the browser phase's: `skills.drafts.fromRecording`.
 */

/** An app the owner can record in: granted for computer use and not off limits. */
export const TeachAppChoice = Type.Object(
  {
    bundleId: Type.String({ minLength: 3, maxLength: 200 }),
    name: Type.String({ maxLength: 120 }),
    tier: StringEnum(["click", "interact"]),
  },
  { $id: "TeachAppChoice" },
);
export type TeachAppChoice = Static<typeof TeachAppChoice>;

/**
 * One step as the helper captured it, for the review screen. `sample` is what the owner typed into
 * an ordinary field; it never exists for a sensitive field. It stays in the review window until
 * Save, and Save sends it only where the owner chose to keep it.
 */
export const TeachAppCapturedStep = Type.Composite(
  [
    Type.Omit(BrowserTeachStep, ["keepValue", "value", "input"]),
    Type.Object({ sample: Type.Optional(Type.String({ maxLength: 500 })) }),
  ],
  { $id: "TeachAppCapturedStep" },
);
export type TeachAppCapturedStep = Static<typeof TeachAppCapturedStep>;

export const TeachAppEndedBy = StringEnum(["stop", "limit", "timeout", "cancel", "interrupted"], {
  $id: "TeachAppEndedBy",
});
export type TeachAppEndedBy = Static<typeof TeachAppEndedBy>;

export const TeachAppStatus = Type.Object(
  {
    active: Type.Boolean(),
    sessionId: Type.Optional(Type.String()),
    app: Type.Optional(Type.Object({ bundleId: Type.String(), name: Type.String() })),
    steps: Type.Optional(Type.Integer({ minimum: 0 })),
    startedAt: Type.Optional(IsoDateTime),
    /** Set when recording ended without Stop (the cap, the time limit, the app quit). */
    ended: Type.Optional(TeachAppEndedBy),
  },
  { $id: "TeachAppStatus" },
);
export type TeachAppStatus = Static<typeof TeachAppStatus>;

export const TeachAppCapture = Type.Object(
  {
    id: Type.String(),
    endedBy: TeachAppEndedBy,
    app: Type.Object({ bundleId: Type.String(), name: Type.String() }),
    steps: Type.Array(TeachAppCapturedStep, { maxItems: 200 }),
    /** Input in places that are never recorded (secure fields, other apps), left out. */
    skipped: Type.Integer({ minimum: 0 }),
  },
  { $id: "TeachAppCapture" },
);
export type TeachAppCapture = Static<typeof TeachAppCapture>;

export const TeachAppMethods = {
  "teach.app.apps": defineMethod({
    params: Type.Object({}),
    result: Type.Object({ apps: Type.Array(TeachAppChoice, { maxItems: 200 }) }),
    scope: "operator.admin",
    description:
      "Desktop shell only: the apps the owner granted for computer use that can be recorded (Settings → Computer use). Psyche, security prompts, password managers, banking, browsers and terminals are never listed. An app is its bundle id on a Mac and its lowercase executable name on Windows (`notepad.exe`).",
  }),
  "teach.app.start": defineMethod({
    params: Type.Object({ bundleId: Type.String({ minLength: 3, maxLength: 200 }) }),
    result: Type.Object({
      sessionId: Type.String(),
      app: Type.Object({ bundleId: Type.String(), name: Type.String() }),
    }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Side-effecting, desktop shell only, on the owner's click: the Host helper starts watching one granted app's accessibility events. Refused (forbidden, policy_denied) for any other caller, for an app that is not granted, and for Psyche and system security prompts. A visible indicator shows on the owner's computer while it records.",
  }),
  "teach.app.stop": defineMethod({
    params: Type.Object({}),
    result: TeachAppCapture,
    scope: "operator.admin",
    // Not side-effecting on purpose: a side-effecting method's result is kept for replay in
    // `gateway_idempotency` for days, and this result carries what the owner typed.
    description:
      "Desktop shell only: ends the recording and returns the steps for the review screen. Nothing is stored by the helper or the Gateway, and no idempotency record holds the result.",
  }),
  "teach.app.cancel": defineMethod({
    params: Type.Object({}),
    result: Type.Object({ cancelled: Type.Boolean() }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Side-effecting, desktop shell only: ends the recording and drops everything it caught.",
  }),
  "teach.app.status": defineMethod({
    params: Type.Object({}),
    result: TeachAppStatus,
    scope: "operator.admin",
    description: "Desktop shell only: whether an app is being recorded, and how many steps so far.",
  }),
} as const;
