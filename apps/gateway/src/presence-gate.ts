import { hashCanonical } from "@psyche/audit";
import { getSetting, type PsycheDb, setSetting } from "@psyche/db";
import { bindingHash } from "@psyche/permissions";
import { type JsonObject, PsycheError } from "@psyche/protocol";
import type { Call } from "./context.ts";
import { INTERNAL_SETTING_PREFIX } from "./state-version.ts";

/**
 * Fresh user presence for security changes (security §10): Touch ID through the helper, or a
 * passkey on the web. A gated call first fails `approval_required` with `details.approvalId`: a
 * device-only `policy_change` card bound to the exact change, which the broker accepts only with
 * a verified presence assertion. The retry with that `approvalId` goes through, once.
 *
 * - `ready`: some verifier can verify (a registered helper key, a passkey, an explicit one).
 * - `off`: none ever could, so a fresh install still works with `operator.admin` alone.
 * - `unavailable`: one could before (sticky, in the database) but none can now, for example
 *   after the owner's passkey device was revoked. Gated calls fail closed with
 *   `presence_required` instead of falling back to `operator.admin`: otherwise revoking the
 *   owner's device would switch the gate off. `psyched presence reset` on the machine clears it.
 */
export type PresenceState = "ready" | "unavailable" | "off";

export const PRESENCE_ENROLLED_SETTING = `${INTERNAL_SETTING_PREFIX}presence.enrolled`;

/** The state function the Gateway context exposes; `ready()` reports whether one can verify. */
export function presenceStateFor(db: PsycheDb, ready: () => boolean): () => PresenceState {
  let enrolled: boolean | undefined;
  return () => {
    if (ready()) {
      if (enrolled !== true) {
        if (getSetting(db, PRESENCE_ENROLLED_SETTING)?.value !== true) {
          setSetting(db, PRESENCE_ENROLLED_SETTING, true);
        }
        enrolled = true;
      }
      return "ready";
    }
    // Re-read when not known enrolled: `psyched presence reset` runs in another process.
    if (enrolled !== true) enrolled = getSetting(db, PRESENCE_ENROLLED_SETTING)?.value === true;
    return enrolled ? "unavailable" : "off";
  };
}

/** Clears the sticky flag (`psyched presence reset`, owner on the machine). */
export function resetPresenceEnrollment(db: PsycheDb): boolean {
  const had = getSetting(db, PRESENCE_ENROLLED_SETTING)?.value === true;
  setSetting(db, PRESENCE_ENROLLED_SETTING, false);
  return had;
}

export interface FreshPresenceAction {
  /** What the binding names: a setting key, or `method:<name>`. */
  name: string;
  summary: string;
  /** The exact change the card is bound to (hashed canonically). */
  subject: unknown;
  /** Shown on the card. */
  details: JsonObject;
}

export function presenceRequiredError(): PsycheError {
  return new PsycheError(
    "presence_required",
    "This change needs Touch ID or a passkey, and none can verify on this Gateway now. Register the helper's Touch ID key or a passkey (or run `psyched presence reset` on the machine), then try again.",
    { details: { reason: "no_presence_verifier" } },
  );
}

/** Fresh presence for one change; throws until an approved card for exactly it is consumed. */
export async function requireFreshPresence(
  call: Pick<Call, "ctx" | "identity">,
  action: FreshPresenceAction,
  approvalId: string | undefined,
): Promise<void> {
  const state = call.ctx.presenceState();
  if (state === "off") return;
  if (state === "unavailable") throw presenceRequiredError();
  let valueSha256: string;
  try {
    valueSha256 = hashCanonical((action.subject ?? null) as never);
  } catch {
    throw new PsycheError("invalid_params", `The parameters of ${action.name} are not plain JSON`);
  }
  const binding = bindingHash("policy_change", { setting: action.name, valueSha256 });
  const { broker } = call.ctx;
  if (approvalId === undefined) {
    const issued = await broker.requestApproval({
      kind: "policy_change",
      summary: action.summary,
      details: { ...action.details, requestedByDevice: call.identity.deviceId },
      bindingHash: binding,
      grantKey: binding,
      requestedBy: { runId: null, taskId: null, threadId: null },
      sideEffect: "destructive",
      // `web`: the server-mode web client answers with a passkey (issue #79).
      surfaces: ["desktop", "web", "notification"],
      scopesOffered: ["once"],
      taint: false,
    });
    // Like nodes.invoke: clients learn of the card (and their answer token) from the event.
    call.ctx.bus.publish("approval.created", { approval: issued.approval });
    throw new PsycheError(
      "approval_required",
      `${action.summary} needs your approval with Touch ID or a passkey`,
      { details: { approvalId: issued.approval.id } },
    );
  }
  const approval = await broker.get(approvalId);
  if (approval?.kind !== "policy_change" || !approval.requiresAuthentication) {
    throw new PsycheError("forbidden", "That approval is not a security-change approval");
  }
  const v = await broker.verifyBinding(approvalId, binding);
  if (!v.ok) {
    throw new PsycheError(
      "binding_mismatch",
      `That approval does not cover this change (${v.reason})`,
    );
  }
}

type Params = Record<string, unknown>;

/**
 * `operator.admin` methods that widen access or destroy data, beyond the security settings:
 * each needs fresh presence when its predicate holds. Narrowing calls (revoking a device,
 * removing allowlist entries, denying a pairing) stay admin-only so the owner can always lock
 * things down. `passkeys.register.finish` is gated in the passkeys part (first passkey only).
 */
export const PRESENCE_METHODS: Readonly<Record<string, (p: Params) => string | undefined>> = {
  "devices.approve": (p) =>
    `Approve a new device with ${Array.isArray(p.scopes) ? p.scopes.join(", ") : "scopes"}`,
  "channels.configure": () => "Change a chat channel's access",
  "channels.allowlist.update": (p) =>
    Array.isArray(p.add) && p.add.length > 0 ? "Allow new chat senders" : undefined,
  "channels.pairing.approve": () => "Let a new chat sender talk to Psyche",
  "channels.identities.upsert": () => "Change a person's chat identity and permissions",
  "memory.reset": (p) => (p.dryRun === true ? undefined : "Erase all memory"),
  "backup.delete": () => "Delete a backup",
};

/** The gate for one dispatched call, or `undefined` when the method needs none. */
export function methodPresence(
  method: string,
  params: unknown,
): { action: FreshPresenceAction; approvalId: string | undefined } | undefined {
  const rule = PRESENCE_METHODS[method];
  if (rule === undefined) return undefined;
  const p = (params ?? {}) as Params;
  const summary = rule(p);
  if (summary === undefined) return undefined;
  const { approvalId, ...rest } = p;
  return {
    action: {
      name: `method:${method}`,
      summary,
      subject: rest,
      details: { method, params: rest as JsonObject },
    },
    approvalId: typeof approvalId === "string" ? approvalId : undefined,
  };
}
