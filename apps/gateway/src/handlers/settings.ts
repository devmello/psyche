import { homedir } from "node:os";
import { normalize, sep } from "node:path";
import { getSetting, getSettings, setSetting } from "@psyche/db";
import { assertFolderGrantable } from "@psyche/permissions";
import { isAdminSettingKey, PsycheError } from "@psyche/protocol";
import { normalizeMachineSetting } from "../compose/computer-settings.ts";
import { folderAccessEnv } from "../compose/protected-paths.ts";
import type { Call, HandlerDef } from "../context.ts";
import { LAN_SETTING, parseLanSettings } from "../lan/settings.ts";
import { HOST_HELPER_PIN_SETTING } from "../nodes/registry.ts";
import { requireFreshPresence } from "../presence-gate.ts";
import { redactMcpServers } from "../redact.ts";
import { INTERNAL_SETTING_PREFIX } from "../state-version.ts";
import { isNarrowing } from "./settings-narrowing.ts";

/**
 * Security settings (security §10): `permissions.*`, `computerUse.*`, `exec.*`, `vault.*`, `devices.*`,
 * `gateway.*`, the owner identities and the channel DM / allow policies. Besides
 * `operator.admin` they need fresh user presence: a device-only `policy_change` approval bound to
 * the exact key and value, which the broker only accepts with a verified presence assertion
 * (requiresAuthentication). The exception is {@link OWNER_CHOICE_KEYS}: security settings the
 * owner changes with `operator.admin` alone, no presence step.
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
 * are untrusted. It stays a SECURITY setting for the seal (`isSecuritySettingKey`): out-of-band
 * writes are undone, an untrusted state reads only a value the Gateway vouches for, and a re-seal
 * never adopts one. What Auto may do stays bounded elsewhere: the model allowlist, the rules
 * classifier, the never list (refused) and payments (which still ask). Only the owner's
 * authenticated device (`operator.admin`) can write it; a tool call has no path to this method.
 */
export const OWNER_CHOICE_KEYS: readonly string[] = [
  "permissions.mode",
  // Optional sensitive categories (government, iCloud): off by default, the owner's toggle.
  "permissions.sensitive.government",
  "permissions.sensitive.icloud",
];

export function needsPresence(key: string): boolean {
  if (OWNER_CHOICE_KEYS.includes(key)) return false;
  const root = key.split(".")[0] ?? "";
  return PRESENCE_ROOTS.includes(root) || PRESENCE_KEYS.some((re) => re.test(key));
}

/**
 * A folder newly added to the policy must not be a sensitive root (security §3.5). Returns the
 * real path each new folder was judged at (absent when it does not exist yet): that one path is
 * what is recorded (`recordPolicyFolderReals`), so a swap between the check and the record
 * cannot record a place that was never checked.
 */
async function checkNewFolders(call: Call, value: unknown): Promise<Map<string, string>> {
  const judged = new Map<string, string>();
  const folders = (value as { folders?: unknown } | null)?.folders;
  const roots = (value as { workspaceRoots?: unknown } | null)?.workspaceRoots;
  const storedPolicy = getSetting(call.ctx.db, "permissions.policy")?.value as
    | { folders?: { path?: unknown }[]; workspaceRoots?: unknown[] }
    | undefined;
  const home = call.ctx.config.home;
  if (Array.isArray(folders)) {
    const known = new Set((storedPolicy?.folders ?? []).map((f) => f.path));
    for (const f of folders as { path?: unknown }[]) {
      if (typeof f?.path !== "string" || known.has(f.path)) continue;
      const real = await assertFolderGrantable(f.path, folderAccessEnv(home));
      if (real !== undefined) judged.set(f.path, real);
    }
  }
  // A workspace root is a folder grant (read-write, matched first): the same rules.
  if (Array.isArray(roots)) {
    const known = new Set(storedPolicy?.workspaceRoots ?? []);
    for (const r of roots) {
      if (typeof r !== "string" || known.has(r)) continue;
      await assertFolderGrantable(r, folderAccessEnv(home));
    }
  }
  return judged;
}

/**
 * Each folder grant's real path (`real`), set here and never taken from the client: an entry the
 * stored policy already has keeps what was recorded for it (a write that drops the field, from an
 * older Settings, loses nothing); a new entry gets the real path `checkNewFolders` judged it at
 * (`judged`), or none when it does not exist yet (the broker records the first one it sees, if
 * that is the path itself). A granted root whose real path later differs from this one covers
 * nothing (`grantedRootRefused`), so a parent swapped for a link is caught as well as the root.
 */
export function recordPolicyFolderReals(
  value: unknown,
  stored: unknown,
  judged: ReadonlyMap<string, string>,
): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const folders = (value as { folders?: unknown }).folders;
  if (!Array.isArray(folders)) return value;
  const storedFolders = (stored as { folders?: unknown } | null | undefined)?.folders;
  const known = new Map<string, string | undefined>();
  if (Array.isArray(storedFolders)) {
    for (const f of storedFolders as { path?: unknown; real?: unknown }[]) {
      if (typeof f?.path !== "string") continue;
      known.set(f.path, typeof f.real === "string" ? f.real : undefined);
    }
  }
  const out: unknown[] = [];
  for (const f of folders as unknown[]) {
    if (typeof f !== "object" || f === null || typeof (f as { path?: unknown }).path !== "string") {
      out.push(f);
      continue;
    }
    const { real: _client, ...rest } = f as { path: string; real?: unknown };
    let real: string | undefined;
    if (known.has(rest.path)) real = known.get(rest.path);
    else real = judged.get(rest.path);
    out.push(real === undefined ? rest : { ...rest, real });
  }
  return { ...value, folders: out };
}

/**
 * Just before a policy write: an entry with no `real` takes the one the stored policy has for the
 * same path now. The broker may have recorded an older folder's real path while this write
 * waited for its card, and the write must not drop it.
 */
export function mergeStoredFolderReals(value: unknown, stored: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const folders = (value as { folders?: unknown }).folders;
  const storedFolders = (stored as { folders?: unknown } | null | undefined)?.folders;
  if (!Array.isArray(folders) || !Array.isArray(storedFolders)) return value;
  const reals = new Map<string, string>();
  for (const f of storedFolders as { path?: unknown; real?: unknown }[]) {
    if (typeof f?.path === "string" && typeof f.real === "string") reals.set(f.path, f.real);
  }
  return {
    ...value,
    folders: folders.map((f: unknown) => {
      if (typeof f !== "object" || f === null) return f;
      const e = f as { path?: unknown; real?: unknown };
      if (typeof e.path !== "string" || e.real !== undefined) return f;
      const real = reals.get(e.path);
      return real === undefined ? f : { ...e, real };
    }),
  };
}

/**
 * Folder grants written as `~/x` are stored as `<home>/x`: the policy matches absolute paths
 * only, so a literal `~` entry grants nothing.
 *
 * - Only an entry that is NEW in this write (its literal path is not in the stored policy) is
 *   expanded. A `~/x` entry already stored never granted anything, and stays literal so an
 *   unrelated policy write cannot start granting it.
 * - Only a leading `~/` expands, to the owner's home. `~user/x` and a bare `~` are refused.
 * - The result is normalised (`..` and `.` resolved, no trailing slash), not realpath'd, and
 *   that normalised path is what `assertFolderGrantable` judges and what is stored: `~/../x`
 *   becomes `<parent of home>/x`, never something under home.
 */
export function expandPolicyFolders(
  value: unknown,
  stored: unknown,
  userHome: string = homedir(),
): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const folders = (value as { folders?: unknown }).folders;
  if (!Array.isArray(folders)) return value;
  const storedFolders = (stored as { folders?: unknown } | null | undefined)?.folders;
  const known = new Set(
    Array.isArray(storedFolders)
      ? storedFolders.map((f: unknown) => (f as { path?: unknown } | null)?.path)
      : [],
  );
  return {
    ...value,
    folders: folders.map((f: unknown) => {
      const path = (f as { path?: unknown } | null)?.path;
      if (typeof path !== "string" || !path.startsWith("~") || known.has(path)) return f;
      if (!path.startsWith("~/")) {
        throw new PsycheError("invalid_params", "folder grants are absolute paths");
      }
      const home = normalize(userHome);
      const joined = normalize(`${home}${sep}${path.slice(2)}`);
      return { ...(f as object), path: joined.length > 1 ? joined.replace(/[\\/]+$/, "") : joined };
    }),
  };
}

export const settingsHandlers: Record<string, HandlerDef> = {
  "settings.get": {
    run(call: Call, params: { keys?: string[] }) {
      const keys = params.keys?.filter((k) => !k.startsWith(INTERNAL_SETTING_PREFIX));
      const all = getSettings(call.ctx.db, keys);
      const settings = Object.fromEntries(
        Object.entries(all).filter(([k]) => !k.startsWith(INTERNAL_SETTING_PREFIX)),
      );
      // A tool server's env values, URL secrets and auth never leave the Gateway this way, for
      // any device: `mcp.config` and `mcp.secrets` are how the owner sees them.
      if ("mcp.servers" in settings) {
        settings["mcp.servers"] = redactMcpServers(settings["mcp.servers"]);
      }
      return { settings, stateVersion: call.ctx.bus.stateVersion };
    },
  },
  "settings.set": {
    // Not transactional: a security key first awaits the broker. The write itself is one row.
    async run(call: Call, params: { key: string; value: unknown; approvalId?: string }) {
      const { key } = params;
      // Tool servers change only through the `mcp.*` methods. A whole-list write can't carry
      // the secrets a read hides, and it would skip the trust card.
      if (key === "mcp.servers") {
        throw new PsycheError(
          "invalid_params",
          "Tool servers can't be written with settings.set. Use mcp.probe and mcp.add to add one, mcp.update to edit, mcp.setEnabled to pause or resume, and mcp.remove to remove.",
          { details: { reason: "use_mcp_methods" } },
        );
      }
      // `gateway.lan` is stored in its normalized form, and a malformed or wildcard value is
      // refused before anything (including the presence card) is created for it.
      let value = key === LAN_SETTING ? parseLanSettings(params.value) : params.value;
      // Per-machine tiers and the default computer (wave H4): only paired machines, tiers at
      // most the fixed caps, refused before any card is made for them.
      value = normalizeMachineSetting(call.ctx.db, key, value);
      if (key.startsWith(INTERNAL_SETTING_PREFIX)) {
        throw new PsycheError(
          "invalid_params",
          `Setting keys starting with "${INTERNAL_SETTING_PREFIX}" are reserved`,
        );
      }
      if (isAdminSettingKey(key) && !call.identity.scopes.includes("operator.admin")) {
        throw new PsycheError("forbidden", `Changing ${key} requires operator.admin`);
      }
      if (key === "permissions.policy") {
        value = expandPolicyFolders(value, getSetting(call.ctx.db, key)?.value);
        const judged = await checkNewFolders(call, value);
        value = recordPolicyFolderReals(value, getSetting(call.ctx.db, key)?.value, judged);
      }
      // Fresh presence once a verifier was enrolled (helper Touch ID, passkeys); admin only before.
      // A change that provably only narrows what the agent may do applies at once from an admin
      // device (no card). Anything else, a mixed change included, keeps the card. Nothing is
      // awaited between this read and the write below.
      const narrowing =
        needsPresence(key) &&
        call.identity.scopes.includes("operator.admin") &&
        // Stored values are only a baseline while the security records are trusted.
        call.ctx.securityState?.untrusted() === null &&
        isNarrowing(key, getSetting(call.ctx.db, key)?.value, value);
      if (needsPresence(key) && !narrowing) {
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
      // Nothing is awaited between this read and the write.
      if (key === "permissions.policy") value = mergeStoredFolderReals(value, before);
      const entry = setSetting(call.ctx.db, key, value);
      try {
        call.ctx.onSettingChanged?.({
          key,
          before,
          after: value,
          deviceId: call.identity.deviceId,
          ...(narrowing ? { narrowing: true } : {}),
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
      // Pinning (or unpinning) the Host helper settles or reopens an ambiguity at once.
      if (key === HOST_HELPER_PIN_SETTING) call.ctx.nodes.refreshHostHelper();
      const stateVersion = call.ctx.bus.bumpStateVersion();
      call.emit("settings.changed", { entries: [entry] });
      return {
        entry:
          entry.key === "mcp.servers" ? { ...entry, value: redactMcpServers(entry.value) } : entry,
        stateVersion,
      };
    },
  },
};
