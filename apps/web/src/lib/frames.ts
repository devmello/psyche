// Duplicated from apps/desktop/src/lib/frames.ts for the bootstrap; S11 merges the two shells' client code.
/**
 * Tiny local frame helpers matching docs/plans/s00.md "Wire spec v1".
 * S11 replaces these with the `@psyche/protocol` frame schemas once they land.
 */

export const MAX_FRAME_BYTES = 1_048_576;

export interface WireReq {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
  idempotencyKey?: string;
}

export interface WireError {
  code: string;
  message: string;
  details?: unknown;
  retryable?: boolean;
}

export type WireRes =
  | { type: "res"; id: string; ok: true; payload: unknown }
  | { type: "res"; id: string; ok: false; error: WireError };

export interface WireEvent {
  type: "event";
  event: string;
  payload: unknown;
  seq: number;
  stateVersion: number;
}

export type WireFrame = WireReq | WireRes | WireEvent;

export function reqFrame(id: string, method: string, params?: unknown): WireReq {
  return params === undefined ? { type: "req", id, method } : { type: "req", id, method, params };
}

export function encodeFrame(frame: WireFrame): string {
  return JSON.stringify(frame);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse one text frame. Throws on malformed input; callers drop the connection. */
export function parseWireFrame(raw: string): WireFrame {
  if (raw.length > MAX_FRAME_BYTES) throw new Error("frame too large");
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value)) throw new Error("frame is not an object");
  switch (value.type) {
    case "req":
      if (typeof value.id === "string" && typeof value.method === "string")
        return value as unknown as WireReq;
      break;
    case "res":
      if (typeof value.id !== "string" || typeof value.ok !== "boolean") break;
      if (value.ok === true) return value as unknown as WireRes;
      if (isRecord(value.error) && typeof value.error.code === "string")
        return value as unknown as WireRes;
      break;
    case "event":
      if (typeof value.event === "string" && typeof value.seq === "number")
        return value as unknown as WireEvent;
      break;
  }
  throw new Error("invalid frame");
}
