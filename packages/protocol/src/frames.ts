import { type Static, Type } from "@sinclair/typebox";
import { ErrorPayload, PsycheError } from "./errors.ts";
import { createValidator } from "./methods/define.ts";

/**
 * WS / NDJSON frames (wire spec v1 in `docs/plans/s00.md`; architecture §11; data model §11).
 * One JSON frame per WebSocket text message, or per line on the node and browser-bridge sockets.
 * Frames are closed objects: unknown envelope keys are rejected. Method params, results and
 * event payloads are validated separately against the registry (`validateParams`,
 * `validateResult`, `validateEventPayload`).
 */

/** Largest accepted frame, in UTF-8 bytes (1 MiB), on every transport. */
export const MAX_FRAME_BYTES = 1_048_576;

/** Correlates a `res` with its `req`. Chosen by the sender, unique per connection. */
export const FrameId = Type.String({ minLength: 1, maxLength: 128, $id: "FrameId" });
export type FrameId = Static<typeof FrameId>;

/** Required on side-effecting methods; a repeat with the same key returns the original result. */
export const IdempotencyKey = Type.String({ minLength: 1, maxLength: 128, $id: "IdempotencyKey" });
export type IdempotencyKey = Static<typeof IdempotencyKey>;

export const ReqFrame = Type.Object(
  {
    type: Type.Literal("req"),
    id: FrameId,
    method: Type.String({ minLength: 1, maxLength: 128 }),
    params: Type.Optional(Type.Unknown()),
    idempotencyKey: Type.Optional(IdempotencyKey),
  },
  { $id: "ReqFrame", additionalProperties: false },
);
export type ReqFrame = Static<typeof ReqFrame>;

export const ResOkFrame = Type.Object(
  {
    type: Type.Literal("res"),
    id: FrameId,
    ok: Type.Literal(true),
    payload: Type.Unknown(),
  },
  { $id: "ResOkFrame", additionalProperties: false },
);
export type ResOkFrame = Static<typeof ResOkFrame>;

export const ResErrFrame = Type.Object(
  {
    type: Type.Literal("res"),
    id: FrameId,
    ok: Type.Literal(false),
    error: ErrorPayload,
  },
  { $id: "ResErrFrame", additionalProperties: false },
);
export type ResErrFrame = Static<typeof ResErrFrame>;

export const ResFrame = Type.Union([ResOkFrame, ResErrFrame], { $id: "ResFrame" });
export type ResFrame = Static<typeof ResFrame>;

/**
 * Server-pushed event. `seq` increases by one per event on a connection; `stateVersion`
 * increases on every persisted mutation. Events are not replayed: a client that sees a gap
 * refreshes the affected collections (data model §11).
 */
export const EventFrame = Type.Object(
  {
    type: Type.Literal("event"),
    event: Type.String({ minLength: 1, maxLength: 128 }),
    payload: Type.Unknown(),
    seq: Type.Integer({ minimum: 0 }),
    stateVersion: Type.Integer({ minimum: 0 }),
  },
  { $id: "EventFrame", additionalProperties: false },
);
export type EventFrame = Static<typeof EventFrame>;

export const Frame = Type.Union([ReqFrame, ResOkFrame, ResErrFrame, EventFrame], { $id: "Frame" });
export type Frame = Static<typeof Frame>;

const frameValidator = createValidator(Frame);
const variantValidators = {
  req: createValidator(ReqFrame),
  event: createValidator(EventFrame),
  resOk: createValidator(ResOkFrame),
  resErr: createValidator(ResErrFrame),
};

/** UTF-8 byte length without allocating an encoded copy. */
function utf8ByteLength(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Readable reason for a frame that failed validation, scoped to the variant its `type` names. */
function describeInvalid(value: unknown): string {
  if (!isRecord(value)) return "frame must be a JSON object";
  const type = value.type;
  let lines: string[];
  if (type === "req") lines = variantValidators.req.errors(value);
  else if (type === "event") lines = variantValidators.event.errors(value);
  else if (type === "res") {
    lines =
      value.ok === false
        ? variantValidators.resErr.errors(value)
        : variantValidators.resOk.errors(value);
  } else return `unknown frame type ${JSON.stringify(type ?? null)}`;
  return lines.length > 0 ? lines.join("; ") : "frame does not match the wire spec";
}

/**
 * Parses and validates one frame. Throws `PsycheError("invalid_frame")` for oversized input,
 * malformed JSON or a shape outside the wire spec. When the frame carried a usable string `id`,
 * the error's `details.id` holds it so the receiver can answer with `errRes(id, …)`.
 */
export function parseFrame(raw: string): Frame {
  if (typeof raw !== "string") {
    throw new PsycheError("invalid_frame", "frame must be a string");
  }
  // Each UTF-16 code unit encodes to at most 3 UTF-8 bytes, so short frames skip the count.
  if (raw.length * 3 > MAX_FRAME_BYTES) {
    const bytes = utf8ByteLength(raw);
    if (bytes > MAX_FRAME_BYTES) {
      throw new PsycheError(
        "invalid_frame",
        `frame is ${bytes} bytes; the limit is ${MAX_FRAME_BYTES}`,
        {
          details: { bytes, limit: MAX_FRAME_BYTES },
        },
      );
    }
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    throw new PsycheError("invalid_frame", "frame is not valid JSON", { cause: err });
  }
  if (frameValidator.check(value)) return value;
  const id =
    isRecord(value) && typeof value.id === "string" && value.id.length > 0 ? value.id : undefined;
  throw new PsycheError(
    "invalid_frame",
    `invalid frame: ${describeInvalid(value)}`,
    id === undefined || id.length > 128 ? {} : { details: { id } },
  );
}

/** Serializes a frame (one line on NDJSON transports: JSON never contains a raw newline). */
export function serializeFrame(frame: Frame): string {
  return JSON.stringify(frame);
}

/** Successful response. `undefined` payloads are sent as `null` so the key survives JSON. */
export function okRes(id: string, payload: unknown): ResOkFrame {
  return { type: "res", id, ok: true, payload: payload === undefined ? null : payload };
}

/** Error response from a wire error or a `PsycheError`. */
export function errRes(id: string, error: ErrorPayload | PsycheError): ResErrFrame {
  return {
    type: "res",
    id,
    ok: false,
    error: error instanceof PsycheError ? error.toPayload() : error,
  };
}

export function eventFrame(
  event: string,
  payload: unknown,
  seq: number,
  stateVersion: number,
): EventFrame {
  return {
    type: "event",
    event,
    payload: payload === undefined ? null : payload,
    seq,
    stateVersion,
  };
}

/** Request frame; `idempotencyKey` is included only when given. */
export function reqFrame(
  id: string,
  method: string,
  params?: unknown,
  idempotencyKey?: string,
): ReqFrame {
  const frame: ReqFrame = { type: "req", id, method };
  if (params !== undefined) frame.params = params;
  if (idempotencyKey !== undefined) frame.idempotencyKey = idempotencyKey;
  return frame;
}
