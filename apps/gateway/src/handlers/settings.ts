import { hashCanonical } from "@psyche/audit";
import { getSettings, setSetting } from "@psyche/db";
import { bindingHash } from "@psyche/permissions";
import { isAdminSettingKey, PsycheError } from "@psyche/protocol";
import type { Call, HandlerDef } from "../context.ts";
import { INTERNAL_SETTING_PREFIX } from "../state-version.ts";

/**
 * Security settings (security §10): `permissions.*`, `computerUse.*`, `exec.*`, `vault.*`, `devices.*`,
 * `gateway.*`, the owner identities and the channel DM / allow policies. Besides
 * `operator.admin` they need fresh user presence: a device-only `policy_change` approval bound to
 * the exact key and value, which the broker only accepts with a verified presence assertion
 * (requiresAuthentication).
 */
// `computerUse`: enabling computer use and raising an app's tier widen what the agent may do on
// the Mac (security §12), like `permissions.apps`.
const PRESENCE_ROOTS = [
  "permissions",
  "exec",
  "vault",
  "devices",
  "gateway",
  "identityLinks",
  "computerUse",
];
const PRESENCE_KEYS = [
  /^commands\.ownerAllowFrom$/,
  /^channels\.[^.]+\.(dmPolicy|allowFrom|groupAllowFrom)$/,
];

export function needsPresence(key: string): boolean {
  const root = key.split(".")[0] ?? "";
  return PRESENCE_ROOTS.includes(root) || PRESENCE_KEYS.some((re) => re.test(key));
}

function settingBinding(key: string, value: unknown): string {
  let valueSha256: string;
  try {
    valueSha256 = hashCanonical(value ?? null);
  } catch {
    throw new PsycheError("invalid_params", `The value of ${key} is not plain JSON`);
  }
  return bindingHash("policy_change", { setting: key, valueSha256 });
}

/** Fresh presence for one security setting change; throws until an approved card is consumed. */
async function requirePresence(call: Call, key: string, value: unknown, approvalId?: string) {
  const binding = settingBinding(key, value);
  const { broker } = call.ctx;
  if (approvalId === undefined) {
    const issued = await broker.requestApproval({
      kind: "policy_change",
      summary: `Change the security setting ${key}`,
      details: { setting: key, value: value as never, requestedByDevice: call.identity.deviceId },
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
      `Changing ${key} needs your approval with Touch ID or a passkey`,
      { details: { approvalId: issued.approval.id } },
    );
  }
  const approval = await broker.get(approvalId);
  if (approval?.kind !== "policy_change" || !approval.requiresAuthentication) {
    throw new PsycheError("forbidden", "That approval is not a security-setting approval");
  }
  const v = await broker.verifyBinding(approvalId, binding);
  if (!v.ok) {
    throw new PsycheError(
      "binding_mismatch",
      `That approval does not cover this change (${v.reason})`,
    );
  }
}

export const settingsHandlers: Record<string, HandlerDef> = {
  "settings.get": {
    run(call: Call, params: { keys?: string[] }) {
      const keys = params.keys?.filter((k) => !k.startsWith(INTERNAL_SETTING_PREFIX));
      const all = getSettings(call.ctx.db, keys);
      const settings = Object.fromEntries(
        Object.entries(all).filter(([k]) => !k.startsWith(INTERNAL_SETTING_PREFIX)),
      );
      return { settings, stateVersion: call.ctx.bus.stateVersion };
    },
  },
  "settings.set": {
    // Not transactional: a security key first awaits the broker. The write itself is one row.
    async run(call: Call, params: { key: string; value: unknown; approvalId?: string }) {
      const { key, value } = params;
      if (key.startsWith(INTERNAL_SETTING_PREFIX)) {
        throw new PsycheError(
          "invalid_params",
          `Setting keys starting with "${INTERNAL_SETTING_PREFIX}" are reserved`,
        );
      }
      if (isAdminSettingKey(key) && !call.identity.scopes.includes("operator.admin")) {
        throw new PsycheError("forbidden", `Changing ${key} requires operator.admin`);
      }
      // Fresh presence once a verifier exists (helper Touch ID, passkeys); until then admin only.
      if (needsPresence(key) && call.ctx.settingsPresence()) {
        await requirePresence(call, key, value, params.approvalId);
      }
      const entry = setSetting(call.ctx.db, key, value);
      const stateVersion = call.ctx.bus.bumpStateVersion();
      call.emit("settings.changed", { entries: [entry] });
      return { entry, stateVersion };
    },
  },
};
