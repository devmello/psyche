import { getSetting, getSettings, setSetting } from "@psyche/db";
import { assertFolderGrantable } from "@psyche/permissions";
import { isAdminSettingKey, PsycheError } from "@psyche/protocol";
import { folderAccessEnv } from "../compose/protected-paths.ts";
import type { Call, HandlerDef } from "../context.ts";
import { LAN_SETTING, parseLanSettings } from "../lan/settings.ts";
import { requireFreshPresence } from "../presence-gate.ts";
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

/**
 * The default permission mode for new threads is the owner's own choice, made from the app's mode
 * switch or Settings, and applies at once: no presence, and no refusal while the security records
 * are untrusted. What Auto may do stays bounded elsewhere: the model allowlist, the classifier,
 * the never list and payments (which still ask with presence). Only the owner's authenticated
 * device (`operator.admin`) can write it; a tool call has no path to this method.
 */
export const OWNER_CHOICE_KEYS: readonly string[] = ["permissions.mode"];

export function needsPresence(key: string): boolean {
  if (OWNER_CHOICE_KEYS.includes(key)) return false;
  const root = key.split(".")[0] ?? "";
  return PRESENCE_ROOTS.includes(root) || PRESENCE_KEYS.some((re) => re.test(key));
}

/** A folder newly added to the policy must not be a sensitive root (security §3.5). */
async function checkNewFolders(call: Call, value: unknown): Promise<void> {
  const folders = (value as { folders?: unknown } | null)?.folders;
  if (!Array.isArray(folders)) return;
  const stored = (
    getSetting(call.ctx.db, "permissions.policy")?.value as
      | { folders?: { path?: unknown }[] }
      | undefined
  )?.folders;
  const known = new Set((stored ?? []).map((f) => f.path));
  const home = call.ctx.config.home;
  for (const f of folders as { path?: unknown }[]) {
    if (typeof f?.path !== "string" || known.has(f.path)) continue;
    await assertFolderGrantable(f.path, folderAccessEnv(home));
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Entries of `mcp.servers` that came from a shared file are written back with the marker, tier,
 * transport, sandbox and working folder they had; an entry cannot claim the marker for itself.
 */
export function keepBundleProtections(stored: unknown, incoming: unknown): unknown {
  if (!Array.isArray(incoming)) return incoming;
  const before = new Map<string, Record<string, unknown>>();
  if (Array.isArray(stored))
    for (const e of stored) if (isObj(e) && typeof e.id === "string") before.set(e.id, e);
  return incoming.map((e) => {
    if (!isObj(e) || typeof e.id !== "string") return e;
    const was = before.get(e.id);
    const { bundle: _claimed, ...rest } = e;
    if (was === undefined || !isObj(was.bundle)) return rest;
    // The command, arguments and variables are what was approved too; values are set through
    // `mcp.secrets.replace`, which writes the setting itself.
    const protectedFields: Record<string, unknown> = {
      bundle: was.bundle,
      trust: "unknown",
      transport: was.transport,
    };
    if (was.sandbox !== undefined) protectedFields.sandbox = was.sandbox;
    if (was.cwd !== undefined) protectedFields.cwd = was.cwd;
    return { ...rest, ...protectedFields };
  });
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
      const { key } = params;
      // `gateway.lan` is stored in its normalized form, and a malformed or wildcard value is
      // refused before anything (including the presence card) is created for it.
      let value = key === LAN_SETTING ? parseLanSettings(params.value) : params.value;
      if (key.startsWith(INTERNAL_SETTING_PREFIX)) {
        throw new PsycheError(
          "invalid_params",
          `Setting keys starting with "${INTERNAL_SETTING_PREFIX}" are reserved`,
        );
      }
      if (isAdminSettingKey(key) && !call.identity.scopes.includes("operator.admin")) {
        throw new PsycheError("forbidden", `Changing ${key} requires operator.admin`);
      }
      if (key === "permissions.policy") await checkNewFolders(call, value);
      // A tool server that came from a shared file keeps its marker, tier and sandbox however the
      // list is written: those only change by importing or removing it.
      if (key === "mcp.servers")
        value = keepBundleProtections(getSetting(call.ctx.db, key)?.value, value);
      // Fresh presence once a verifier was enrolled (helper Touch ID, passkeys); admin only before.
      if (needsPresence(key)) {
        await requireFreshPresence(
          call,
          {
            name: key,
            summary: `Change the security setting ${key}`,
            subject: value ?? null,
            details: { setting: key, value: (value ?? null) as never },
          },
          params.approvalId,
        );
      }
      const before = getSettings(call.ctx.db, [key])[key];
      const entry = setSetting(call.ctx.db, key, value);
      try {
        call.ctx.onSettingChanged?.({
          key,
          before,
          after: value,
          deviceId: call.identity.deviceId,
        });
      } catch {
        // Reporting never fails the change.
      }
      if (key === LAN_SETTING) {
        // Opens or closes the LAN sockets now. A failure is reported through `gateway.info`
        // (`lan.problems`); the stored choice stays, like any other setting.
        try {
          // The owner just said yes on this network: remember it (lan/listener.ts `networks`).
          await call.ctx.lan.apply(value, true);
        } catch (err) {
          call.ctx.log.log("warn", "lan listener failed to apply", {
            code: PsycheError.from(err).code,
          });
        }
      }
      const stateVersion = call.ctx.bus.bumpStateVersion();
      call.emit("settings.changed", { entries: [entry] });
      return { entry, stateVersion };
    },
  },
};
