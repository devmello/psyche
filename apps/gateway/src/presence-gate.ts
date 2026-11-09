import { hashCanonical } from "@psyche/audit";
import { getSetting, type PsycheDb, setSetting } from "@psyche/db";
import { bindingHash } from "@psyche/permissions";
import { type JsonObject, PsycheError } from "@psyche/protocol";
import { hostWords } from "@psyche/protocol/host-words";
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
 *   owner's device would switch the gate off. `psyched presence reset` on the machine clears it,
 *   24 hours later (a recovery every device shows) or at once with presence from an admin device.
 */
export type PresenceState = "ready" | "unavailable" | "off";

export const PRESENCE_ENROLLED_SETTING = `${INTERNAL_SETTING_PREFIX}presence.enrolled`;

/**
 * The state function the Gateway context exposes; `ready()` reports whether one can verify.
 * `forget()` drops the cached enrollment after the Gateway itself reset it (a presence-reset
 * recovery, `security/recoveries.ts`).
 */
export function presenceStateFor(
  db: PsycheDb,
  ready: () => boolean,
): (() => PresenceState) & { forget(): void } {
  let enrolled: boolean | undefined;
  const state = () => {
    if (ready()) {
      if (enrolled !== true) {
        if (getSetting(db, PRESENCE_ENROLLED_SETTING)?.value !== true) {
          setSetting(db, PRESENCE_ENROLLED_SETTING, true);
        }
        enrolled = true;
      }
      return "ready" as const;
    }
    // Once known enrolled it stays so in memory: a write from another process cannot switch the
    // gate off (the seal undoes such a write too, security-state-integrity §7.1).
    if (enrolled !== true) enrolled = getSetting(db, PRESENCE_ENROLLED_SETTING)?.value === true;
    return enrolled ? ("unavailable" as const) : ("off" as const);
  };
  return Object.assign(state, {
    forget() {
      enrolled = undefined;
    },
  });
}

/**
 * Clears the sticky flag. Only the Gateway calls it, when a `psyched presence reset` recovery
 * applies (24 hours after it was asked, or at once with fresh presence on an admin device).
 */
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

/** Presence fails closed while the security records are untrusted (security-state-integrity §7.1). */
export function stateUntrustedError(): PsycheError {
  return new PsycheError(
    "presence_required",
    "Psyche's security records failed their check, so changes that widen access are blocked. Review your devices in Settings → Devices, then run `psyched security reseal` on the machine (it applies after 24 hours).",
    { details: { reason: "state_untrusted" } },
  );
}

export function presenceRequiredError(): PsycheError {
  return new PsycheError(
    "presence_required",
    `This change needs ${hostWords().presence} or a passkey, and none can verify on this Gateway now. Connect Psyche Helper on this computer (a Windows PC also needs its Windows Hello key registered) or add a passkey, or run \`psyched presence reset\` on the machine, which applies after 24 hours, then try again.`,
    { details: { reason: "no_presence_verifier" } },
  );
}

/**
 * A security change needs an approved card for exactly it, consumed once. The card is a tap on a
 * paired device (owner's decision, 2026-11-09: presence is for payments only). Enrolling a presence
 * verifier is the exception (`strong`): a stolen admin device must not be able to add its own
 * authenticator or key and then approve payments with it, so that card needs the presence step too
 * and fails closed when no verifier can verify.
 */
export async function requireFreshPresence(
  call: Pick<Call, "ctx" | "identity">,
  action: FreshPresenceAction,
  approvalId: string | undefined,
  opts: { strong?: boolean } = {},
): Promise<void> {
  if (call.ctx.securityState?.untrusted() != null) throw stateUntrustedError();
  const state = call.ctx.presenceState();
  const strong = opts.strong === true;
  // Adding a verifier is gated by what can verify, not by what the owner enrolled: on a default
  // Mac the helper's auto-paired key can sign the sheet, so a first passkey from a device with
  // only `operator.approvals` must pass it too (`presenceCanVerify`, context.ts).
  const canVerify = call.ctx.presenceCanVerify?.() ?? state !== "off";
  if (state === "off" && !(strong && canVerify)) return;
  if (strong && !canVerify) throw presenceRequiredError();
  let valueSha256: string;
  try {
    valueSha256 = hashCanonical((action.subject ?? null) as never);
  } catch {
    throw new PsycheError("invalid_params", `The parameters of ${action.name} are not plain JSON`);
  }
  // The card is bound to the device that asked: `approval.created` (id included) reaches every
  // operator.read subscriber, so without this another admin device could present an approvalId
  // the owner approved for someone else's request and spend it. A different device hashes to a
  // different binding and gets `binding_mismatch`.
  const binding = bindingHash("policy_change", {
    setting: action.name,
    valueSha256,
    requestedByDevice: call.identity.deviceId,
  });
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
      ...(opts.strong === true ? { requireAuthentication: true } : {}),
    });
    // Like nodes.invoke: clients learn of the card (and their answer token) from the event.
    call.ctx.bus.publish("approval.created", { approval: issued.approval });
    throw new PsycheError(
      "approval_required",
      opts.strong === true
        ? `${action.summary} needs your approval with ${hostWords().presence} or a passkey`
        : `${action.summary} needs your approval`,
      { details: { approvalId: issued.approval.id } },
    );
  }
  const approval = await broker.get(approvalId);
  if (
    approval?.kind !== "policy_change" ||
    (opts.strong === true && !approval.requiresAuthentication)
  ) {
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
  // A setup token pairs a computer without a second approval, so making one is approving ahead.
  "devices.setupToken.create": (p) =>
    `Let a new computer pair itself${p.via === "lan" ? " from this network" : ""} with ${Array.isArray(p.scopes) ? p.scopes.join(", ") : "scopes"}`,
  "channels.configure": () => "Change a chat channel's access",
  "channels.allowlist.update": (p) =>
    Array.isArray(p.add) && p.add.length > 0 ? "Allow new chat senders" : undefined,
  "channels.pairing.approve": () => "Let a new chat sender talk to Psyche",
  "channels.identities.upsert": () => "Change a person's chat identity and permissions",
  "memory.reset": (p) => (p.dryRun === true ? undefined : "Erase all memory"),
  "memory.lessons.forgetAll": (p) =>
    p.dryRun === true ? undefined : "Forget everything Psyche learned from you",
  "backup.delete": () => "Delete a backup",
  "gateway.lan.rotateCert": () => "Replace the certificate computers on this network trust",
  "sandbox.installSrt": () =>
    "Install srt (the sandbox runtime) into Psyche's tools folder from the npm registry",
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
