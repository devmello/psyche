import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { Value } from "@sinclair/typebox/value";
import { type DeviceScope, Nullable } from "../common.ts";

/**
 * Registry helpers shared by the client method families (`src/methods/*.ts`), the event
 * registry (`src/events.ts`), the node protocol (`src/node.ts`) and the browser bridge
 * (`src/bridge.ts`). Wire spec v1 in `docs/plans/s00.md`.
 */

/** Scope a caller's device token must carry; `"none"` only for the pre-pairing handshake. */
export type MethodScope = DeviceScope | "none";

export interface MethodSpec<
  P extends TSchema = TSchema,
  R extends TSchema = TSchema,
  S extends MethodScope = MethodScope,
  E extends boolean = boolean,
> {
  readonly params: P;
  readonly result: R;
  readonly scope: S;
  /** `true` → the `req` frame must carry `idempotencyKey`; duplicates return the original result. */
  readonly sideEffecting: E;
  readonly description: string;
}

export interface EventSpec<P extends TSchema = TSchema> {
  readonly payload: P;
  readonly description: string;
}

/** Defines one method; keeps the schema, scope and side-effect literals in the type. */
export function defineMethod<
  const P extends TSchema,
  const R extends TSchema,
  const S extends MethodScope,
  const E extends boolean = false,
>(spec: {
  params: P;
  result: R;
  scope: S;
  sideEffecting?: E;
  description: string;
}): MethodSpec<P, R, S, E> {
  return {
    params: spec.params,
    result: spec.result,
    scope: spec.scope,
    sideEffecting: (spec.sideEffecting ?? false) as E,
    description: spec.description,
  };
}

/** Defines one event; the payload schema is what `validateEventPayload` checks. */
export function defineEvent<const P extends TSchema>(spec: {
  payload: P;
  description: string;
}): EventSpec<P> {
  return { payload: spec.payload, description: spec.description };
}

// --- Validation ---------------------------------------------------------------------------------

export interface Validator<T extends TSchema> {
  check(value: unknown): value is Static<T>;
  /** Up to `max` readable `"<path>: <message>"` lines. Empty when the value is valid. */
  errors(value: unknown, max?: number): string[];
}

/**
 * Compiles a schema with TypeBox's `TypeCompiler` on first use. Under a Content-Security-Policy
 * that forbids `eval` (Electron renderer, web UI) compilation throws, and the validator falls back
 * to the interpreted `Value.Check`, which accepts and rejects exactly the same values.
 */
export function createValidator<T extends TSchema>(schema: T): Validator<T> {
  let compiled: ReturnType<typeof TypeCompiler.Compile<T>> | null | undefined;
  const get = () => {
    if (compiled === undefined) {
      try {
        compiled = TypeCompiler.Compile(schema);
      } catch {
        compiled = null;
      }
    }
    return compiled;
  };
  return {
    check(value: unknown): value is Static<T> {
      const c = get();
      return c === null ? Value.Check(schema, value) : c.Check(value);
    },
    errors(value: unknown, max = 5): string[] {
      const c = get();
      const iterator = c === null ? Value.Errors(schema, value) : c.Errors(value);
      const out: string[] = [];
      for (const error of iterator) {
        const line = `${error.path === "" ? "/" : error.path}: ${describeError(error.schema, error.message)}`;
        if (!out.includes(line)) out.push(line);
        if (out.length >= max) break;
      }
      return out;
    },
  };
}

/** TypeBox reports custom kinds as "Expected kind 'StringEnum'"; name the allowed values instead. */
function describeError(schema: TSchema, message: string): string {
  const values = (schema as { enum?: unknown }).enum;
  if (Array.isArray(values)) {
    const shown = values.slice(0, 8).map((v) => JSON.stringify(v));
    return `Expected one of ${shown.join(", ")}${values.length > 8 ? ", …" : ""}`;
  }
  return message;
}

// --- Shared shapes ------------------------------------------------------------------------------

/** Empty params (`{}`); clients may also omit `params` entirely. */
export const EmptyParams = Type.Object({}, { $id: "EmptyParams" });
export type EmptyParams = Static<typeof EmptyParams>;

/** Result of mutations that have nothing else to return. */
export const OkResult = Type.Object({ ok: Type.Literal(true) }, { $id: "OkResult" });
export type OkResult = Static<typeof OkResult>;

/** Opaque pagination cursor returned as `nextCursor`; `null` means the last page. */
export const Cursor = Type.String({ minLength: 1, maxLength: 512, description: "Opaque cursor" });

/** Page size; the Gateway clamps to its own maximum. */
export const PageLimit = Type.Integer({ minimum: 1, maximum: 500 });

/** Params fields shared by every paged list method. */
export const pageParams = {
  cursor: Type.Optional(Cursor),
  limit: Type.Optional(PageLimit),
};

/** `nextCursor` result field shared by every paged list method. */
export const nextCursor = { nextCursor: Nullable(Cursor) };
