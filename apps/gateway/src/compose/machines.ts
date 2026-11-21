import { getDevice, getMachineByDevice, getSetting, listMachines, type PsycheDb } from "@psyche/db";
import { type AppTier, appCap, effectiveTier, TIER_RANK } from "@psyche/permissions";
import {
  type MachineInfo,
  machineNameOk,
  type NodeClient,
  type NodeInfo,
  type NodeInvokeResult,
  PsycheError,
  type ToolRegistration,
  type ToolResult,
} from "@psyche/protocol";
import type { Logger } from "../log.ts";
import { machineInfoOf } from "../nodes/machines.ts";
import type { MachineRouter, MachineTarget, SurfaceCall } from "./computer.ts";
import {
  COMPUTER_USE_DEFAULT_MACHINE,
  COMPUTER_USE_ENABLED,
  COMPUTER_USE_MACHINE_APPS,
  defaultMachineFrom,
  machineAppTiers,
  machineComputerUseFile,
} from "./computer-settings.ts";

/**
 * Computer use on paired machines, the Gateway side (docs/design/linux-helper-only-2026.md 6.2,
 * 8.2, 8.3; wave H4). `compose/computer.ts` keeps the broker path, the cards, the money and
 * hard-block checks, the risky labels and the bindings for every surface; a call that names a
 * machine (or a Task's call on the default computer for background work) comes here as a
 * `SurfaceCall` with `machine` set. This router:
 *
 * - finds exactly the named machine (`NodeRegistry.machine(deviceId)`): never another machine,
 *   never the Host, never "the newest helper". A name matches case-insensitively and must match
 *   one machine only;
 * - sends only `computer.*` and `apps.list|open|focus`, always on the machine's private screen;
 * - refuses credential placeholders in anything sent to a machine (no vault fill there, G4);
 * - applies the machine's own tiers (`computerUse.machineApps`, never the Host's) under the fixed
 *   caps: an app on Off is refused, one below the tier the call needs answers
 *   `approval_required/tier_ask` like a helper, so `computer.ts` asks the owner with a card
 *   bound to this machine and retries with that approval ("for 30 minutes" on this machine only);
 * - answers `unavailable` with `details.reason: "machine_offline"` when the machine is not
 *   connected. An unattended Task's call parks instead: the owner is told once, and the call
 *   waits for the machine to come back (bounded), then goes ahead or fails the same way.
 *
 * The box enforces its own ceiling (`policy.json`) and its own `computer-use.json` again. The
 * per-machine tiers are pushed to a machine whose helper offers `computer.set_settings`
 * (`syncTiers`); a helper without it keeps its own file, which can only narrow.
 *
 * Exposed for the shell and file tools on machines (H5): `resolve` and `online`.
 */

/** Capabilities a machine is sent through computer use. Everything else is refused here. */
const MACHINE_COMPUTER_CAPS = /^computer\.[a-z][a-z0-9_]*$/;
const MACHINE_APP_CAPS: ReadonlySet<string> = new Set(["apps.list", "apps.open", "apps.focus"]);

/** The helper capability that takes the machine's tiers (`computer-use.json`). */
export const MACHINE_SETTINGS_CAPABILITY = "computer.set_settings";

/** "Allow for this session" on a machine: as long as the helper's (30 minutes). */
const ALLOWANCE_MS = 30 * 60_000;
/** How long an unattended Task's call waits for its machine to come back. */
const PARK_MS = 30 * 60_000;
const PARK_POLL_MS = 2_000;
const SETTINGS_TIMEOUT_MS = 10_000;

/** A credential placeholder (`{{cred:…}}`, any spacing or case): never sent to a machine. */
const CREDENTIAL_PLACEHOLDER = /\{\{\s*cred\s*:/i;

/** The live connection of a machine, as `NodeRegistry.machine(deviceId)` returns it. */
export interface LiveMachine {
  info: NodeInfo;
  client: NodeClient;
}

export interface MachineRouterDeps {
  db: PsycheDb;
  /** `NodeRegistry.machine(deviceId)`: the machine's live connection, or `undefined`. */
  machine(deviceId: string): LiveMachine | undefined;
  /** A Task parked because its machine is offline: tell the owner (once per park). */
  parked?(machine: MachineTarget, taskId: string): void;
  now?: () => number;
  /** How long a parked call waits, and how often it looks (tests shorten both). */
  park?: { timeoutMs: number; pollMs: number };
  logger?: Logger;
}

export interface MachineRouterHandle extends MachineRouter {
  /** Whether the machine is connected now. */
  online(deviceId: string): boolean;
  /** The paired machines as the `machines.list` tool shows them. */
  list(): MachineInfo[];
  /** Pushes each connected machine's tiers to its helper (or one machine's). Best effort. */
  syncTiers(deviceId?: string): Promise<void>;
  /** `settings.changed` entries: the tiers or the enabled switch changed. */
  onChanged(entries: readonly { key: string; value: unknown }[]): void;
}

const machineName = (name: string): string => (machineNameOk(name) ? name : "Linux computer");

function err(
  code: "unavailable" | "policy_denied" | "forbidden" | "approval_required",
  message: string,
  details: Record<string, unknown>,
  retryable?: boolean,
): NodeInvokeResult {
  return {
    ok: false,
    error: { code, message, details, ...(retryable === undefined ? {} : { retryable }) },
  };
}

/** Whether any string in `v` (deep, bounded) carries a credential placeholder. */
function carriesCredential(v: unknown, depth = 0): boolean {
  if (typeof v === "string") return CREDENTIAL_PLACEHOLDER.test(v);
  if (depth > 6 || typeof v !== "object" || v === null) return false;
  const values = Array.isArray(v) ? v : Object.values(v);
  return values.some((x) => carriesCredential(x, depth + 1));
}

const isTier = (t: unknown): t is AppTier =>
  t === "off" || t === "read" || t === "click" || t === "interact";

export function createMachineRouter(deps: MachineRouterDeps): MachineRouterHandle {
  const now = deps.now ?? Date.now;
  const park = deps.park ?? { timeoutMs: PARK_MS, pollMs: PARK_POLL_MS };
  /** device id + lowercased app → the tier an approved card allowed, until when. */
  const allowances = new Map<string, { tier: AppTier; until: number }>();

  /** Every paired machine (revoked devices are never listed), as references. */
  function paired(): { id: string; ref: MachineTarget }[] {
    const out: { id: string; ref: MachineTarget }[] = [];
    for (const record of listMachines(deps.db)) {
      const device = getDevice(deps.db, record.deviceId);
      if (device === undefined || device.revokedAt) continue;
      out.push({
        id: record.id,
        ref: { deviceId: record.deviceId, name: machineName(device.name) },
      });
    }
    return out;
  }

  function resolve(ref: string): MachineTarget {
    const want = ref.trim();
    const all = paired();
    // An id or a device id names one machine exactly.
    const byId = all.find((m) => m.id === want || m.ref.deviceId === want);
    if (byId !== undefined) return byId.ref;
    const lower = want.toLowerCase();
    const byName = all.filter((m) => m.ref.name.toLowerCase() === lower);
    if (byName.length > 1) {
      throw new PsycheError(
        "conflict",
        `More than one computer is named ${want}. Rename one in Settings → Devices, then try again.`,
        { details: { reason: "machine_ambiguous" } },
      );
    }
    const hit = byName[0];
    if (hit === undefined) {
      throw new PsycheError(
        "not_found",
        `No computer named ${want} is paired with Psyche. machines.list shows the computers it can use.`,
        { details: { reason: "machine_not_found" } },
      );
    }
    return hit.ref;
  }

  function backgroundDefault(): MachineTarget | undefined {
    const ref = defaultMachineFrom(getSetting(deps.db, COMPUTER_USE_DEFAULT_MACHINE)?.value);
    if (ref === undefined) return undefined;
    try {
      // Only a paired machine's id counts: a name or a device id left in the setting never
      // points at another computer later.
      if (!listMachines(deps.db).some((x) => x.id === ref)) throw new Error("not a machine id");
      return resolve(ref);
    } catch {
      // The default names a computer that is gone: never a silent fallback to this one.
      throw new PsycheError(
        "not_found",
        "The default computer for background work is no longer paired. Choose another in Settings → Computer use.",
        { details: { reason: "machine_not_found" } },
      );
    }
  }

  function live(deviceId: string): LiveMachine | undefined {
    try {
      return deps.machine(deviceId);
    } catch {
      return undefined;
    }
  }

  const offline = (m: MachineTarget): NodeInvokeResult =>
    err(
      "unavailable",
      `${m.name} is offline, so Psyche cannot use it right now. Try again when it is back, or use this computer instead.`,
      { reason: "machine_offline", machine: { deviceId: m.deviceId, name: m.name } },
      true,
    );

  /** An unattended Task's call waits for its machine (bounded); others answer at once. */
  async function connected(m: MachineTarget, call: SurfaceCall): Promise<LiveMachine | undefined> {
    const up = live(m.deviceId);
    if (up !== undefined) return up;
    const taskId = call.context.taskId;
    if (call.context.unattended !== true || taskId === undefined) return undefined;
    try {
      deps.parked?.(m, taskId);
    } catch {
      // Telling the owner is best effort; the park itself is not.
    }
    const deadline = now() + park.timeoutMs;
    while (now() < deadline) {
      if (call.signal.aborted) return undefined;
      await new Promise<void>((done) => {
        const stop = () => {
          clearTimeout(timer);
          call.signal.removeEventListener("abort", stop);
          done();
        };
        const timer = setTimeout(stop, park.pollMs);
        call.signal.addEventListener("abort", stop, { once: true });
      });
      // A machine removed while the Task waited is not paired any more: no park on it.
      if (!paired().some((x) => x.ref.deviceId === m.deviceId)) return undefined;
      const back = live(m.deviceId);
      if (back !== undefined) return back;
    }
    return undefined;
  }

  /** The machine id (the settings key) of a paired machine's device. */
  const machineIdOf = (deviceId: string): string | undefined =>
    getMachineByDevice(deps.db, deviceId)?.id;

  /** The tier the owner chose for `app` on this machine, capped (`undefined`: asks). */
  function tierOn(deviceId: string, app: string): AppTier | undefined {
    const machineId = machineIdOf(deviceId);
    const tiers =
      machineId === undefined
        ? {}
        : machineAppTiers(getSetting(deps.db, COMPUTER_USE_MACHINE_APPS)?.value, machineId);
    const own = Object.entries(tiers).find(([k]) => k === app)?.[1];
    return effectiveTier(app, own).tier;
  }

  /**
   * The machine's tiers, as a helper would apply them: the fixed cap, Off, then the tier, an
   * approval for this exact app and tier, or an allowance from one. `undefined` means go ahead.
   */
  function gate(m: MachineTarget, call: SurfaceCall): NodeInvokeResult | undefined {
    const app = call.approval?.app;
    const needed = call.approval?.tierRequired;
    if (app === undefined || app === "*" || !isTier(needed) || needed === "off") return undefined;
    const cap = appCap(app);
    if (TIER_RANK[cap.cap] < TIER_RANK[needed]) {
      return err("policy_denied", cap.reason || `${app} is limited to ${cap.cap}`, {
        reason: `app_tier:${cap.cap}`,
        app,
      });
    }
    const tier = tierOn(m.deviceId, app);
    if (tier === "off") {
      return err("policy_denied", `${app} is off for computer use on ${m.name}`, {
        reason: "app_tier:off",
        app,
      });
    }
    // An explicit tier is the owner's word: below what the call needs it refuses, with no card and
    // no allowance (a helper's `have < needed && !asks`). Only an unset tier (Ask) may be approved.
    if (tier !== undefined) {
      if (TIER_RANK[tier] >= TIER_RANK[needed]) return undefined;
      return err("policy_denied", `${app} is limited to ${tier} on ${m.name}`, {
        reason: `app_tier:${tier}`,
        app,
      });
    }
    const key = `${m.deviceId}|${app}`;
    const approved = (call.params as { approval?: { app?: unknown; tier?: unknown } }).approval;
    if (
      call.approvalId !== undefined &&
      typeof approved?.app === "string" &&
      approved.app === app &&
      isTier(approved.tier) &&
      TIER_RANK[approved.tier] >= TIER_RANK[needed]
    ) {
      allowances.set(key, { tier: approved.tier, until: now() + ALLOWANCE_MS });
      return undefined;
    }
    const allowed = allowances.get(key);
    if (
      allowed !== undefined &&
      allowed.until > now() &&
      TIER_RANK[allowed.tier] >= TIER_RANK[needed]
    ) {
      return undefined;
    }
    return err("approval_required", `${app} on ${m.name} needs your permission for computer use.`, {
      reason: "tier_ask",
      app,
      tierRequired: needed,
    });
  }

  function removed(m: MachineTarget): NodeInvokeResult | undefined {
    if (paired().some((x) => x.ref.deviceId === m.deviceId)) return undefined;
    return err("unavailable", `${m.name} is no longer a computer Psyche can use.`, {
      reason: "machine_removed",
      machine: { deviceId: m.deviceId, name: m.name },
    });
  }

  async function invoke(m: MachineTarget, call: SurfaceCall): Promise<NodeInvokeResult> {
    if (!MACHINE_COMPUTER_CAPS.test(call.capability) && !MACHINE_APP_CAPS.has(call.capability)) {
      return err("forbidden", `Psyche does not use ${call.capability} on a paired computer.`, {
        reason: "machine_policy",
      });
    }
    if (call.machine !== undefined && call.machine.deviceId !== m.deviceId) {
      return err("forbidden", "The call names another computer.", { reason: "machine_mismatch" });
    }
    if (carriesCredential(call.params)) {
      return err(
        "policy_denied",
        `Psyche never fills or types saved credentials on ${m.name}. Sign in there yourself.`,
        { reason: "credential_refused" },
      );
    }
    // Paired and not revoked at this call, whatever the router was told before.
    const gone = removed(m);
    if (gone !== undefined) return gone;
    // A refusal stands whatever the machine's state; a card is asked only for a machine that is
    // there to act once it is approved.
    const refused = gate(m, call);
    if (refused !== undefined && refused.error?.code !== "approval_required") return refused;
    const node = await connected(m, call);
    if (node === undefined || node.info.deviceId !== m.deviceId) return offline(m);
    // A park can last 30 minutes: what was true before it is checked again before anything is sent.
    if (getSetting(deps.db, COMPUTER_USE_ENABLED)?.value !== true) {
      return err("policy_denied", "Computer use is off.", { reason: "computer_use_disabled" });
    }
    const gone2 = removed(m);
    if (gone2 !== undefined) return gone2;
    const again = gate(m, call);
    if (again !== undefined) return again;
    if (refused !== undefined) return refused;
    // A machine's private screen only (design Q3): its helper refuses any other.
    const params = { ...call.params, surface: "virtual_screen" };
    return node.client.invoke(call.capability, params, {
      signal: call.signal,
      timeoutMs: call.timeoutMs,
      ...(call.approvalId === undefined ? {} : { approvalId: call.approvalId }),
    });
  }

  async function endSession(m: MachineTarget, session: string): Promise<void> {
    const node = live(m.deviceId);
    if (node === undefined) return;
    await node.client
      .invoke("computer.end_session", { session, surface: "virtual_screen" }, { timeoutMs: 5_000 })
      .catch(() => undefined);
  }

  async function syncOne(deviceId: string): Promise<void> {
    const node = live(deviceId);
    if (node === undefined) return;
    if (!node.info.capabilities.some((c) => c.name === MACHINE_SETTINGS_CAPABILITY)) return;
    const machineId = machineIdOf(deviceId);
    if (machineId === undefined) return;
    const file = machineComputerUseFile(
      getSetting(deps.db, COMPUTER_USE_ENABLED)?.value,
      getSetting(deps.db, COMPUTER_USE_MACHINE_APPS)?.value,
      machineId,
    );
    const res = await node.client
      .invoke(MACHINE_SETTINGS_CAPABILITY, { settings: file }, { timeoutMs: SETTINGS_TIMEOUT_MS })
      .catch((e: unknown) => ({ ok: false as const, error: PsycheError.from(e).toPayload() }));
    if (!res.ok) {
      deps.logger?.log("warn", "pushing a machine's computer-use tiers failed", {
        code: res.error?.code ?? "internal",
      });
    }
  }

  async function syncTiers(deviceId?: string): Promise<void> {
    const ids = deviceId === undefined ? paired().map((m) => m.ref.deviceId) : [deviceId];
    for (const id of ids) await syncOne(id);
  }

  return {
    resolve,
    backgroundDefault,
    invoke,
    endSession,
    online: (deviceId) => live(deviceId) !== undefined,
    list() {
      const out: MachineInfo[] = [];
      for (const record of listMachines(deps.db)) {
        const info = machineInfoOf(deps.db, record);
        if (info !== undefined) out.push(info);
      }
      return out;
    },
    syncTiers,
    onChanged(entries) {
      if (
        entries.some((e) => e.key === COMPUTER_USE_MACHINE_APPS || e.key === COMPUTER_USE_ENABLED)
      ) {
        // A tier the owner lowered also ends what an earlier card allowed above it there.
        for (const [key, allowed] of [...allowances]) {
          const [deviceId = "", app = ""] = key.split("|");
          const tier = tierOn(deviceId, app);
          if (tier !== undefined && TIER_RANK[tier] < TIER_RANK[allowed.tier]) {
            allowances.delete(key);
          }
        }
        void syncTiers();
      }
    },
  };
}

/**
 * The `machines.list` agent tool (design 8.2): read-only, the paired computers the agent may name
 * in `machine`. Their names and status come from the boxes and are untrusted.
 */
export function machinesListTool(router: Pick<MachineRouterHandle, "list">): ToolRegistration {
  return {
    spec: {
      name: "machines.list",
      description:
        "The paired computers Psyche can use besides this one: id, name, status (online or offline), surfaces, display, shell and files. Pass an id or name as machine to the computer and apps tools.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      sideEffect: "read",
      provenanceOut: "untrusted",
    },
    async execute(): Promise<ToolResult> {
      try {
        const machines = router.list().map((m) => ({
          id: m.id,
          name: m.name,
          status: m.status,
          surfaces: m.surfaces,
          display: m.display,
          exec: m.exec,
          files: m.files,
        }));
        return { output: { machines }, provenance: "untrusted" };
      } catch (e) {
        return {
          output: { error: PsycheError.from(e).toPayload() },
          isError: true,
          provenance: "untrusted",
        };
      }
    },
  };
}
