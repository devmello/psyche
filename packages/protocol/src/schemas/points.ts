import { type Static, Type } from "@sinclair/typebox";
import { Id, Nullable, StringEnum } from "../common.ts";

/**
 * Psyche points, you click (docs/design/psyche-points-2026.md §3, §8). The owner picks one window
 * and Psyche draws a ring and a note over the next field to fill. It never clicks.
 *
 * These are the shapes the Gateway, the Mac helper and the desktop share. Three rules shape them:
 *
 * - **No action fields (§4.3.3).** Nothing here names a key, a click, a value to set, an AX action
 *   or a point to act on. `points.show` draws by `fieldId` (or by a box in a screenshot, in vision
 *   mode) and nothing else. The only rectangles are `PointsRect`, a field's frame read from the
 *   window or a box to draw around; the owner's own card buttons are `PointsCardAction`. A test
 *   (`points-protocol.test.ts`) walks every schema in this file for action-shaped names.
 * - **No sensitive values.** A sensitive field is `{fieldId, role, label, sensitive, state}` and
 *   never carries a value; the Gateway judges again with `points-rules.ts` before a model sees it.
 * - **Everything the page says is untrusted** (labels, headings, error text, options): it is
 *   capped here, fenced in the prompt and rendered as plain text.
 */

const Strict = { additionalProperties: false } as const;

/** The session ids are the Gateway's; a field id is a helper-held handle (`f12`), never reassigned. */
export const POINTS_FIELD_ID_PATTERN = "^f[0-9]{1,6}$";

/** Limits from the design (§3.1, §3.3, §8), enforced again by the Gateway and the helper. */
export const POINTS_LIMITS = {
  goalMax: 500,
  askMax: 1000,
  labelMax: 120,
  pathMax: 8,
  errorTextMax: 200,
  optionsMax: 40,
  fieldsMax: 300,
  valueMax: 500,
  noteMax: 140,
  hintMax: 100,
  pageSummaryMax: 200,
  pageTextMax: 2000,
  titleMax: 200,
  stringMax: 80,
  memoryLinesMax: 12,
  memoryCharsMax: 1200,
  stepsMax: 300,
} as const;

/** The fixed role list a field is mapped to (§3.1); anything else is not a field. */
export const PointsFieldRole = StringEnum(
  [
    "text",
    "multiline",
    "number",
    "date",
    "checkbox",
    "radio",
    "popup",
    "combobox",
    "button",
    "link",
  ],
  { $id: "PointsFieldRole" },
);
export type PointsFieldRole = Static<typeof PointsFieldRole>;

/** Filled or empty is all the Gateway learns about a sensitive field. */
export const PointsFieldFill = StringEnum(["empty", "filled", "unknown"], {
  $id: "PointsFieldFill",
});
export type PointsFieldFill = Static<typeof PointsFieldFill>;

/** Why a field is sensitive (§5.1). The first five are the teach reasons; the rest are Points'. */
export const PointsSensitiveReason = StringEnum(
  [
    "password",
    "payment",
    "one_time_code",
    "identity",
    "secret",
    "secure_field",
    "value_shape",
    "directions_only",
  ],
  { $id: "PointsSensitiveReason" },
);
export type PointsSensitiveReason = Static<typeof PointsSensitiveReason>;

/**
 * A rectangle in global screen points (top-left origin), or in image pixels in vision mode. It is
 * where a field is, so the overlay can be drawn there. It is never a place to act.
 */
export const PointsRect = Type.Object(
  {
    x: Type.Number(),
    y: Type.Number(),
    width: Type.Number({ minimum: 0 }),
    height: Type.Number({ minimum: 0 }),
  },
  { $id: "PointsRect", ...Strict },
);
export type PointsRect = Static<typeof PointsRect>;

/** One field as the helper read it (§3.1). Page text, so untrusted. */
export const PointsField = Type.Object(
  {
    fieldId: Type.String({ pattern: POINTS_FIELD_ID_PATTERN }),
    role: PointsFieldRole,
    label: Type.String({ maxLength: POINTS_LIMITS.labelMax }),
    /** Headings and group titles above the field, outermost first. */
    path: Type.Array(Type.String({ maxLength: POINTS_LIMITS.labelMax }), {
      maxItems: POINTS_LIMITS.pathMax,
    }),
    required: Type.Optional(Type.Boolean()),
    invalid: Type.Optional(Type.Boolean()),
    errorText: Type.Optional(Type.String({ maxLength: POINTS_LIMITS.errorTextMax })),
    options: Type.Optional(
      Type.Array(Type.String({ maxLength: POINTS_LIMITS.labelMax }), {
        maxItems: POINTS_LIMITS.optionsMax,
      }),
    ),
    frame: Type.Optional(PointsRect),
    enabled: Type.Optional(Type.Boolean()),
    focused: Type.Optional(Type.Boolean()),
    state: PointsFieldFill,
    /** Set when the helper judged the field sensitive: then there is no `value`. */
    sensitive: Type.Optional(PointsSensitiveReason),
    /** The value of a field that passed the sensitive judge, at most 500 characters. */
    value: Type.Optional(Type.String({ maxLength: POINTS_LIMITS.valueMax })),
  },
  { $id: "PointsField", ...Strict },
);
export type PointsField = Static<typeof PointsField>;

/** The digest of one page of the chosen window (§3.1). No query string or fragment. */
export const PointsDigest = Type.Object(
  {
    app: Type.Object(
      { bundleId: Type.String({ maxLength: 200 }), name: Type.String({ maxLength: 120 }) },
      Strict,
    ),
    windowTitle: Type.String({ maxLength: POINTS_LIMITS.titleMax }),
    /** The web area's host and path, never a query or fragment. */
    host: Type.Optional(Type.String({ maxLength: 253 })),
    path: Type.Optional(Type.String({ maxLength: 500 })),
    /** True for a page served over plain `http:`. */
    insecure: Type.Optional(Type.Boolean()),
    headings: Type.Array(Type.String({ maxLength: POINTS_LIMITS.labelMax }), { maxItems: 40 }),
    /** Instruction text near the fields, at most 2,000 characters a page. */
    instructions: Type.String({ maxLength: POINTS_LIMITS.pageTextMax }),
    /** A hash of the field roles and label paths: a new one means a new page. */
    fingerprint: Type.String({ minLength: 1, maxLength: 64 }),
    fields: Type.Array(PointsField, { maxItems: POINTS_LIMITS.fieldsMax }),
    /** The tree was cut at `maxVisit` or `maxEmit`. */
    truncated: Type.Optional(Type.Boolean()),
    /** `sparse` when fewer than 3 fillable fields were found: the card offers Let Psyche look. */
    tree: StringEnum(["ok", "sparse"]),
  },
  { $id: "PointsDigest", ...Strict },
);
export type PointsDigest = Static<typeof PointsDigest>;

export const PointsStepKind = StringEnum(
  ["fill", "choose", "check", "skip", "self", "review", "next_page"],
  { $id: "PointsStepKind" },
);
export type PointsStepKind = Static<typeof PointsStepKind>;

/** How a suggested value traces to its source (§3.3 grounding). */
export const PointsDerivation = StringEnum(
  ["exact", "case", "date_format", "name_part", "address_part"],
  { $id: "PointsDerivation" },
);
export type PointsDerivation = Static<typeof PointsDerivation>;

export const PointsExpectShape = StringEnum(
  ["date", "email", "phone", "postal", "digits", "oneOf"],
  { $id: "PointsExpectShape" },
);
export type PointsExpectShape = Static<typeof PointsExpectShape>;

/** One step of a page plan, as the model wrote it. The Gateway checks it before anything draws. */
export const PointsStep = Type.Object(
  {
    fieldId: Type.String({ pattern: POINTS_FIELD_ID_PATTERN }),
    kind: PointsStepKind,
    note: Type.String({ maxLength: POINTS_LIMITS.noteMax }),
    value: Type.Optional(Type.String({ maxLength: POINTS_LIMITS.valueMax })),
    option: Type.Optional(Type.String({ maxLength: POINTS_LIMITS.labelMax })),
    /** Source ids: `memory:<id>`, `profile:<field>` or `goal`. */
    sources: Type.Optional(Type.Array(Type.String({ maxLength: 80 }), { maxItems: 4 })),
    derivation: Type.Optional(PointsDerivation),
    expect: Type.Optional(
      Type.Object(
        {
          shape: PointsExpectShape,
          detail: Type.Optional(Type.String({ maxLength: POINTS_LIMITS.hintMax })),
        },
        Strict,
      ),
    ),
  },
  { $id: "PointsStep", ...Strict },
);
export type PointsStep = Static<typeof PointsStep>;

export const PointsDoneWhen = StringEnum(["submit", "next_page", "none"], {
  $id: "PointsDoneWhen",
});
export type PointsDoneWhen = Static<typeof PointsDoneWhen>;

/** The model's answer for one page (§3.3). Anything that does not fit is a failed call. */
export const PointsPlan = Type.Object(
  {
    page: Type.Object(
      {
        title: Type.String({ maxLength: POINTS_LIMITS.labelMax }),
        summary: Type.String({ maxLength: POINTS_LIMITS.pageSummaryMax }),
      },
      Strict,
    ),
    steps: Type.Array(PointsStep, { maxItems: POINTS_LIMITS.stepsMax }),
    done_when: PointsDoneWhen,
  },
  { $id: "PointsPlan", ...Strict },
);
export type PointsPlan = Static<typeof PointsPlan>;

/**
 * The helper's fixed card text, resolved by the desktop in the owner's language and sent at Start
 * (§8, §9). The Gateway accepts only these keys, each at most 80 characters with control and bidi
 * characters stripped, and refuses a start without the full set.
 */
export const PointsCardStrings = Type.Object(
  {
    back: Type.String({ maxLength: POINTS_LIMITS.stringMax }),
    skip: Type.String({ maxLength: POINTS_LIMITS.stringMax }),
    next: Type.String({ maxLength: POINTS_LIMITS.stringMax }),
    looksWrong: Type.String({ maxLength: POINTS_LIMITS.stringMax }),
    stuck: Type.String({ maxLength: POINTS_LIMITS.stringMax }),
    stuckMissing: Type.String({ maxLength: POINTS_LIMITS.stringMax }),
    stuckUnclear: Type.String({ maxLength: POINTS_LIMITS.stringMax }),
    stuckBlocked: Type.String({ maxLength: POINTS_LIMITS.stringMax }),
    askInPsyche: Type.String({ maxLength: POINTS_LIMITS.stringMax }),
    letLook: Type.String({ maxLength: POINTS_LIMITS.stringMax }),
    stop: Type.String({ maxLength: POINTS_LIMITS.stringMax }),
    hideNote: Type.String({ maxLength: POINTS_LIMITS.stringMax }),
    copy: Type.String({ maxLength: POINTS_LIMITS.stringMax }),
    /** "You fill this yourself: {label}". */
    selfFill: Type.String({ maxLength: POINTS_LIMITS.stringMax }),
    /** "You fill this yourself" with no label, for a payment field. */
    selfFillPlain: Type.String({ maxLength: POINTS_LIMITS.stringMax }),
    /** "This button pays. Check the amount, then decide yourself." */
    payButton: Type.String({ maxLength: POINTS_LIMITS.stringMax }),
    /** "Psyche doesn't know this one." */
    unknownValue: Type.String({ maxLength: POINTS_LIMITS.stringMax }),
    /** "Scroll down to {label}". */
    scrollTo: Type.String({ maxLength: POINTS_LIMITS.stringMax }),
    /** "◉ Pointing: {app}". */
    menuBarTitle: Type.String({ maxLength: POINTS_LIMITS.stringMax }),
    /** The step format, "{n}/{total}". */
    stepFormat: Type.String({ maxLength: POINTS_LIMITS.stringMax }),
    visionBadge: Type.String({ maxLength: POINTS_LIMITS.stringMax }),
    followWindow: Type.String({ maxLength: POINTS_LIMITS.stringMax }),
  },
  { $id: "PointsCardStrings", ...Strict },
);
export type PointsCardStrings = Static<typeof PointsCardStrings>;

export const PointsEntry = StringEnum(["chat", "palette", "tray"], { $id: "PointsEntry" });
export type PointsEntry = Static<typeof PointsEntry>;

/** Why a window cannot be pointed at (§2.2). */
export const PointsRefusal = StringEnum(
  ["never_app", "fixed_off", "terminal_or_ide", "owner_off", "not_a_window", "permission_missing"],
  { $id: "PointsRefusal" },
);
export type PointsRefusal = Static<typeof PointsRefusal>;

export const PointsWindow = Type.Object(
  {
    ref: Type.String({ minLength: 1, maxLength: 80 }),
    app: Type.Object(
      { bundleId: Type.String({ maxLength: 200 }), name: Type.String({ maxLength: 120 }) },
      Strict,
    ),
    title: Type.String({ maxLength: POINTS_LIMITS.titleMax }),
    frontmost: Type.Boolean(),
    refusal: Type.Optional(PointsRefusal),
  },
  { $id: "PointsWindow", ...Strict },
);
export type PointsWindow = Static<typeof PointsWindow>;

export const PointsState = StringEnum(["reading", "pointing", "paused", "ended"], {
  $id: "PointsState",
});
export type PointsState = Static<typeof PointsState>;

export const PointsNeeds = StringEnum(["accessibility", "screenRecording"], {
  $id: "PointsNeeds",
});
export type PointsNeeds = Static<typeof PointsNeeds>;

export const PointsEndReason = StringEnum(
  [
    "stop",
    "window_closed",
    "app_quit",
    "app_changed",
    "idle",
    "computer_use",
    "recording",
    "helper_lost",
    "gateway_lost",
    "error",
  ],
  { $id: "PointsEndReason" },
);
export type PointsEndReason = Static<typeof PointsEndReason>;

export const PointsSessionStatus = Type.Object(
  {
    sessionId: Id,
    app: Type.Object(
      { bundleId: Type.String({ maxLength: 200 }), name: Type.String({ maxLength: 120 }) },
      Strict,
    ),
    state: PointsState,
    page: Type.Integer({ minimum: 0 }),
    step: Type.Integer({ minimum: 0 }),
    of: Type.Integer({ minimum: 0 }),
    vision: Type.Boolean(),
  },
  { $id: "PointsSessionStatus", ...Strict },
);
export type PointsSessionStatus = Static<typeof PointsSessionStatus>;

/** The `points.updated` event payload (§8). Counts and states only, never titles or values. */
export const PointsUpdatedPayload = Type.Object(
  {
    sessionId: Id,
    state: PointsState,
    page: Type.Integer({ minimum: 0 }),
    step: Type.Integer({ minimum: 0 }),
    of: Type.Integer({ minimum: 0 }),
    vision: Type.Boolean(),
    needs: Type.Optional(PointsNeeds),
    reason: Type.Optional(PointsEndReason),
  },
  { $id: "PointsUpdatedPayload", ...Strict },
);
export type PointsUpdatedPayload = Static<typeof PointsUpdatedPayload>;

export const PointsAskRequestedPayload = Type.Object(
  { sessionId: Id },
  { $id: "PointsAskRequestedPayload", ...Strict },
);
export type PointsAskRequestedPayload = Static<typeof PointsAskRequestedPayload>;

// ---- Gateway methods ----

export const PointsWindowsParams = Type.Object({}, { $id: "PointsWindowsParams", ...Strict });
export const PointsWindowsResult = Type.Object(
  { windows: Type.Array(PointsWindow, { maxItems: 200 }) },
  { $id: "PointsWindowsResult", ...Strict },
);

export const PointsStartParams = Type.Object(
  {
    window: Type.String({ minLength: 1, maxLength: 80 }),
    goal: Type.Optional(Type.String({ maxLength: POINTS_LIMITS.goalMax })),
    /**
     * Where the goal's words come from. `owner`: the owner typed or edited it in the start sheet.
     * `offer`: it is the agent's `points_offer` text, passed on unedited, so it is model text, not
     * the owner's words: it is no grounding source and no Memory query (W6 enforces it). Absent
     * with a goal counts as `offer`.
     */
    goalSource: Type.Optional(StringEnum(["owner", "offer"])),
    threadId: Type.Optional(Id),
    entry: PointsEntry,
    locale: Type.String({ minLength: 2, maxLength: 35 }),
    strings: PointsCardStrings,
    /**
     * The closing thread note's text in the owner's language, with `{app}`, `{pages}` and
     * `{fields}` ("Pointed you through {app}: {pages} pages, {fields} fields."), sent by the
     * desktop from its messages. Without it the Gateway leaves no note: it has no catalogue.
     */
    closingNote: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  { $id: "PointsStartParams", ...Strict },
);
export const PointsStartResult = Type.Object(
  {
    sessionId: Id,
    app: Type.Object(
      { bundleId: Type.String({ maxLength: 200 }), name: Type.String({ maxLength: 120 }) },
      Strict,
    ),
  },
  { $id: "PointsStartResult", ...Strict },
);

export const PointsStopParams = Type.Object(
  { sessionId: Id },
  { $id: "PointsStopParams", ...Strict },
);
export const PointsStopResult = Type.Object(
  { ended: Type.Boolean() },
  { $id: "PointsStopResult", ...Strict },
);

export const PointsStatusParams = Type.Object({}, { $id: "PointsStatusParams", ...Strict });
export const PointsStatusResult = Type.Object(
  { session: Type.Optional(PointsSessionStatus) },
  { $id: "PointsStatusResult", ...Strict },
);

export const PointsAskParams = Type.Object(
  { sessionId: Id, text: Type.String({ minLength: 1, maxLength: POINTS_LIMITS.askMax }) },
  { $id: "PointsAskParams", ...Strict },
);
export const PointsAskResult = Type.Object(
  { answer: Type.String() },
  { $id: "PointsAskResult", ...Strict },
);

// ---- Helper capabilities (`points.*`; node capabilities, not Gateway methods) ----

/**
 * The Mac helper's Points capabilities (§8). Like `vscreen.*` they are not in `Methods`: only the
 * Gateway's Points module calls them, on the Host helper, through a wrapper that allows exactly
 * these names. `nodes.invoke` and agent tools never reach them. Their declared side effects are
 * none or read; none can act on another app.
 */
export const POINTS_CAPABILITY_EFFECTS = {
  "points.windows": "read",
  "points.session": "read",
  "points.show": "none",
  "points.look": "read",
  "points.end": "none",
} as const;
export const POINTS_CAPABILITIES = Object.keys(POINTS_CAPABILITY_EFFECTS) as ReadonlyArray<
  keyof typeof POINTS_CAPABILITY_EFFECTS
>;
export type PointsCapability = (typeof POINTS_CAPABILITIES)[number];

/** A candidate window from the helper (`points.windows`): through AX, no Screen Recording. */
export const PointsHelperWindow = Type.Object(
  {
    pid: Type.Integer({ minimum: 1 }),
    windowIndex: Type.Integer({ minimum: 0 }),
    app: Type.Object(
      { bundleId: Type.String({ maxLength: 200 }), name: Type.String({ maxLength: 120 }) },
      Strict,
    ),
    title: Type.String({ maxLength: POINTS_LIMITS.titleMax }),
    frontmost: Type.Boolean(),
    refusal: Type.Optional(PointsRefusal),
  },
  { $id: "PointsHelperWindow", ...Strict },
);
export type PointsHelperWindow = Static<typeof PointsHelperWindow>;

export const PointsHelperWindowsResult = Type.Object(
  { windows: Type.Array(PointsHelperWindow, { maxItems: 200 }) },
  { $id: "PointsHelperWindowsResult", ...Strict },
);

export const PointsSessionParams = Type.Object(
  { window: Type.String({ minLength: 1, maxLength: 80 }), strings: PointsCardStrings },
  { $id: "PointsSessionParams", ...Strict },
);

/** The buttons on the card: the owner's own clicks, reported to the Gateway. */
export const PointsCardAction = StringEnum(
  [
    "back",
    "skip",
    "wrong",
    "stuck_missing",
    "stuck_unclear",
    "stuck_blocked",
    "ask",
    "look",
    "next",
    "follow_window",
    "stop",
  ],
  { $id: "PointsCardAction" },
);
export type PointsCardAction = Static<typeof PointsCardAction>;

export const PointsSessionEventType = StringEnum(
  ["digest", "field", "focus", "page", "action", "visible", "ended"],
  { $id: "PointsSessionEventType" },
);
export type PointsSessionEventType = Static<typeof PointsSessionEventType>;

/**
 * One streamed event of `points.session`: a flat object with a `type`, so the generated Swift is
 * one struct. Which members are set follows `type` (digest: `digest`; field: `fieldId`, `state`,
 * `value` on commit and for non-sensitive fields only; focus: `fieldId`; action: `action` and
 * `actionId`, the owner's own click; visible: `visible`; ended: `reason`).
 */
export const PointsSessionEvent = Type.Object(
  {
    type: PointsSessionEventType,
    digest: Type.Optional(PointsDigest),
    fieldId: Type.Optional(Type.String({ pattern: POINTS_FIELD_ID_PATTERN })),
    state: Type.Optional(PointsFieldFill),
    value: Type.Optional(Type.String({ maxLength: POINTS_LIMITS.valueMax })),
    action: Type.Optional(PointsCardAction),
    /** Names the owner's latest `look` or `next` click; `points.look` answers only for it. */
    actionId: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
    visible: Type.Optional(Type.Boolean()),
    reason: Type.Optional(PointsEndReason),
  },
  { $id: "PointsSessionEvent", ...Strict },
);
export type PointsSessionEvent = Static<typeof PointsSessionEvent>;

export const PointsShowKind = StringEnum(
  ["fill", "choose", "check", "skip", "self", "review", "next_page", "info"],
  { $id: "PointsShowKind" },
);
export type PointsShowKind = Static<typeof PointsShowKind>;

/** Where the ring goes: a field the helper holds, or a box in a screenshot (vision mode). */
export const PointsShowTarget = Type.Object(
  {
    fieldId: Type.Optional(Type.String({ pattern: POINTS_FIELD_ID_PATTERN })),
    box: Type.Optional(PointsRect),
    imageSize: Type.Optional(
      Type.Object(
        { width: Type.Integer({ minimum: 1 }), height: Type.Integer({ minimum: 1 }) },
        Strict,
      ),
    ),
  },
  { $id: "PointsShowTarget", ...Strict },
);
export type PointsShowTarget = Static<typeof PointsShowTarget>;

/** `points.show`: text only. The helper clamps every length again and draws; it does nothing else. */
export const PointsShowParams = Type.Object(
  {
    sessionId: Id,
    target: PointsShowTarget,
    kind: PointsShowKind,
    note: Type.String({ maxLength: POINTS_LIMITS.noteMax }),
    value: Type.Optional(Type.String({ maxLength: POINTS_LIMITS.valueMax })),
    sources: Type.Optional(Type.Array(Type.String({ maxLength: 80 }), { maxItems: 4 })),
    step: Type.Object(
      { n: Type.Integer({ minimum: 0 }), of: Type.Integer({ minimum: 0 }) },
      Strict,
    ),
    warning: Type.Optional(Type.String({ maxLength: POINTS_LIMITS.noteMax })),
  },
  { $id: "PointsShowParams", ...Strict },
);
export const PointsShowResult = Type.Object(
  { shown: Type.Boolean() },
  { $id: "PointsShowResult", ...Strict },
);

export const PointsLookParams = Type.Object(
  { sessionId: Id, actionId: Type.String({ minLength: 1, maxLength: 80 }) },
  { $id: "PointsLookParams", ...Strict },
);
export const PointsLookResult = Type.Object(
  {
    image: Nullable(
      Type.String({ contentEncoding: "base64", description: "JPEG of the target window only" }),
    ),
    width: Type.Integer({ minimum: 0 }),
    height: Type.Integer({ minimum: 0 }),
    pointsPerPixel: Type.Number({ minimum: 0 }),
    /** Every known sensitive field's frame was painted solid before encoding. */
    masked: Type.Boolean(),
  },
  { $id: "PointsLookResult", ...Strict },
);

export const PointsEndParams = Type.Object(
  { sessionId: Id },
  { $id: "PointsEndParams", ...Strict },
);
export const PointsEndResult = Type.Object({}, { $id: "PointsEndResult", ...Strict });

/**
 * `points_offer` (chat part, §6.2): the card the agent's `points.offer {goal}` tool renders, a
 * button that opens the start sheet with the goal filled in. It starts nothing; the owner's click
 * opens the sheet and Start is a second click. The goal is the model's text: plain text.
 */
export const PointsOfferBlock = Type.Object(
  { type: Type.Literal("points_offer"), goal: Type.String({ maxLength: POINTS_LIMITS.goalMax }) },
  { $id: "PointsOfferBlock", ...Strict },
);
