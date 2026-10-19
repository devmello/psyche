import type { ErrorCode } from "@psyche/protocol";
import { expect } from "vitest";
import { FakeClock } from "../clock.ts";
import { createIdGenerator, type IdGenerator } from "../ids.ts";

/**
 * What every conformance factory receives. Implementations that expire, lease or schedule
 * things must read time from `clock` (it only moves when the suite advances it).
 */
export interface ConformanceContext {
  clock: FakeClock;
  ids: IdGenerator;
}

export type ConformanceFactory<T, C extends ConformanceContext = ConformanceContext> = (
  ctx: C,
) => T | Promise<T>;

export function newContext(): ConformanceContext {
  const clock = new FakeClock();
  return { clock, ids: createIdGenerator({ prefix: "conf" }) };
}

/** Await a rejection and check it is a PsycheError with `code` (any code when omitted). */
export async function expectPsycheError(
  promise: Promise<unknown>,
  code?: ErrorCode,
): Promise<void> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, "expected the call to reject").toBeDefined();
  expect(err).toBeInstanceOf(Error);
  const actual = (err as { code?: unknown }).code;
  expect(typeof actual, "rejection should carry a PsycheError code").toBe("string");
  if (code !== undefined) expect(actual).toBe(code);
}

export { collect } from "../async.ts";
