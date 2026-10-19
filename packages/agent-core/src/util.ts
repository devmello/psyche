import { createHash, randomUUID } from "node:crypto";
import type { Clock, SideEffect } from "@psyche/protocol";

/**
 * Canonical JSON (security §3.5): sorted keys, no insignificant whitespace, `undefined` members
 * dropped. Strings are hashed exactly as given, never NFC-folded (S23 design-13): the executor
 * runs the raw string, and NFC / NFD forms are different files and addresses. The connector
 * registry re-checks the loop's binding with the same formula (`toolCallBindingHash`).
 */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJSON(v)).join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(obj[k])}`).join(",")}}`;
  }
  throw new TypeError(`canonicalJSON: unsupported value of type ${typeof value}`);
}

export function sha256(input: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}

/** `bindingHash = sha256("psyche.binding.v1|" + kind + "|" + canonicalJSON(fields))` (security §3.5). */
export function bindingHash(kind: string, fields: unknown): `sha256:${string}` {
  return sha256(`psyche.binding.v1|${kind}|${canonicalJSON(fields)}`);
}

export function paramsHash(params: unknown): `sha256:${string}` {
  return sha256(canonicalJSON(params));
}

/** Id source; `@psyche/testing`'s `createIdGenerator()` satisfies it. */
export interface IdSource {
  next(prefix?: string): string;
}

export const randomIds: IdSource = {
  next: (prefix = "id") => `${prefix}_${randomUUID().replaceAll("-", "")}`,
};

export const systemClock: Clock = { now: () => Date.now() };

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/** `YYYY-MM-DD` of `ms` in `timeZone` (IANA name). */
export function localDate(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

/** Rough token estimate (4 chars ≈ 1 token) used for budgets, never for billing. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export const SEVERITY: Record<SideEffect, number> = {
  none: 0,
  read: 1,
  write: 2,
  destructive: 3,
  financial: 4,
};

/** The more severe of two side-effect classes (a description may only tighten a spec). */
export function stricter(a: SideEffect, b: SideEffect | undefined): SideEffect {
  if (b === undefined) return a;
  return SEVERITY[b] > SEVERITY[a] ? b : a;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A promise with its resolvers, for parking a run. */
export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
