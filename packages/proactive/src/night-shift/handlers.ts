import { type MethodParams, type MethodResult, PsycheError, type Surface } from "@psyche/protocol";
import type { NightShiftApply } from "./apply.ts";
import { MAX_BUDGET_USD, MIN_BUDGET_USD, minutesOf, NIGHT_SHIFT_SETTING_KEYS } from "./settings.ts";

/**
 * `nightShift.apply`, `nightShift.undo` and `nightShift.dismiss` (docs/design/night-shift-2026.md
 * §6.2). Params are validated and scopes checked by the Gateway router (apply and undo need
 * `operator.approvals`, dismiss `operator.write`), and the router's idempotency store replays a
 * side-effecting call with the same key, so a replayed apply returns the same approval and token.
 * The answer token handed back is the calling device's own surface only.
 */
export interface NightShiftCaller {
  surface: Surface;
  /** The desktop shell on this Mac's loopback (set by the Gateway): only it may apply Messages items. */
  local: boolean;
}

type Method = "nightShift.apply" | "nightShift.undo" | "nightShift.dismiss";

export type NightShiftHandlers = {
  [M in Method]: (params: MethodParams<M>, caller: NightShiftCaller) => Promise<MethodResult<M>>;
};

export function createNightShiftHandlers(apply: NightShiftApply): NightShiftHandlers {
  const answer = (
    r: Awaited<ReturnType<NightShiftApply["apply"]>>,
    caller: NightShiftCaller,
  ): MethodResult<"nightShift.apply"> => {
    const token = r.issued?.answerTokens[caller.surface];
    return {
      ...(r.issued === undefined ? {} : { approval: r.issued.approval }),
      ...(token === undefined ? {} : { answerToken: token }),
      refused: r.refused.map((x) => ({
        itemId: x.itemId,
        reason: x.reason.slice(0, 300),
      })),
    };
  };
  return {
    "nightShift.apply": async (p, caller) =>
      answer(
        await apply.apply(
          { reviewId: p.reviewId, items: p.items, sends: p.sends },
          { local: caller.local },
        ),
        caller,
      ),
    "nightShift.undo": async (p, caller) =>
      answer(await apply.undo(p.itemIds, { local: caller.local }), caller),
    "nightShift.dismiss": async (p) => ({ dismissed: apply.dismiss(p.reviewId, p.itemIds) }),
  };
}

const KNOWN: ReadonlySet<string> = new Set(NIGHT_SHIFT_SETTING_KEYS);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * The server-side schema of the `nightShift.*` settings keys (§8): only the known keys, each with
 * its type and range. `settings.set` calls it before storing. Not a security setting: enabling
 * Night shift grants nothing, so the keys are not sealed.
 */
export function validateNightShiftSetting(key: string, value: unknown): unknown {
  if (!key.startsWith("nightShift.")) return value;
  const bad = (why: string): never => {
    throw new PsycheError("invalid_params", `${key}: ${why}`, {
      details: { reason: "night_shift_setting" },
    });
  };
  if (!KNOWN.has(key)) bad("not a Night shift setting");
  if (value === null) return value; // clears it back to the default
  switch (key) {
    case "nightShift.enabled":
    case "nightShift.notify":
    case "nightShift.domains.mail":
    case "nightShift.domains.calendar":
    case "nightShift.domains.reminders":
    case "nightShift.domains.files":
      if (typeof value !== "boolean") bad("must be true or false");
      return value;
    case "nightShift.consentedAt":
      if (typeof value !== "string" || Number.isNaN(Date.parse(value)) || value.length > 40) {
        bad("must be an ISO time");
      }
      return value;
    case "nightShift.window.start":
    case "nightShift.window.end":
      if (typeof value !== "string" || !HHMM.test(value)) bad("must be HH:MM");
      void minutesOf(value as string);
      return value;
    case "nightShift.budgetUsd":
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < MIN_BUDGET_USD ||
        value > MAX_BUDGET_USD
      ) {
        bad(`must be between ${MIN_BUDGET_USD} and ${MAX_BUDGET_USD}`);
      }
      return value;
    case "nightShift.expiryDays":
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 7) {
        bad("must be a whole number of days from 1 to 7");
      }
      return value;
  }
  return bad("not a Night shift setting");
}
