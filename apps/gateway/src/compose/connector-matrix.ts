import type { ConnectorRecord, ConnectorRegistry } from "@psyche/connectors";
import { getSetting, getSettings } from "@psyche/db";
import { appleConnectorKey, type MatrixRule, type PolicyConfig } from "@psyche/permissions";
import { PsycheError } from "@psyche/protocol";
import type { ComposeServices } from "./services.ts";

/**
 * Settings → Connectors' Allow / Ask / Deny per action group (#747). The UI saves a connector's
 * rules as `permissions.connectors.<connectorId>` (`{"mail.organize": "deny", …}`); this layer
 * makes both deciders follow them:
 *
 * - the Permission Broker: the rules go into `policy.connectors[<connectorId>]` on top of the
 *   owner's `permissions.policy` (the registry stamps each call with its group). Apple app
 *   connectors also land under `apple.<app>`, which direct `node.*` helper calls use. A
 *   shortcut's `config.shortcutRules` entry becomes `shortcuts.run/<id>` (off → deny);
 * - the connector executor's own matrix (`registry.setMatrix`), which otherwise keeps the
 *   defaults and refuses an allowed write that carries no approval.
 *
 * The broker's floors (sends, destructive, financial, device-only) still ask whatever the matrix
 * says, except where the owner lifted one in Settings with a confirmation: `permissions.
 * liftedFloors.<connectorId>` (`["notes.delete", …]`) becomes `policy.liftedFloors` and the
 * executor's `floorLifted` (security §3.12). Only that setting lifts a floor: a `liftedFloors`
 * entry inside an imported `permissions.policy` is dropped, and a plain `allow` never lifts one.
 */
export const CONNECTOR_MATRIX_PREFIX = "permissions.connectors.";
export const LIFTED_FLOORS_PREFIX = "permissions.liftedFloors.";

const RULES: readonly MatrixRule[] = ["allow", "ask", "deny"];
const SHORTCUT_RULE: Record<string, MatrixRule> = { off: "deny", ask: "ask", allow: "allow" };

type Matrix = Record<string, MatrixRule>;

function rulesOf(value: unknown): Matrix {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Matrix = {};
  for (const [k, v] of Object.entries(value)) {
    if (k !== "" && RULES.includes(v as MatrixRule)) out[k] = v as MatrixRule;
  }
  return out;
}

/** The owner's `permissions.connectors.<id>` settings, by connector id. */
export function ownerMatrices(settings: Record<string, unknown>): Map<string, Matrix> {
  const out = new Map<string, Matrix>();
  for (const [key, value] of Object.entries(settings)) {
    if (!key.startsWith(CONNECTOR_MATRIX_PREFIX)) continue;
    const id = key.slice(CONNECTOR_MATRIX_PREFIX.length);
    if (id !== "") out.set(id, rulesOf(value));
  }
  return out;
}

/** The owner's confirmed `permissions.liftedFloors.<id>` settings, by connector id. */
export function ownerLiftedFloors(settings: Record<string, unknown>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [key, value] of Object.entries(settings)) {
    if (!key.startsWith(LIFTED_FLOORS_PREFIX) || !Array.isArray(value)) continue;
    const id = key.slice(LIFTED_FLOORS_PREFIX.length);
    const actions = value.filter((v): v is string => typeof v === "string" && v !== "");
    if (id !== "" && actions.length > 0) out.set(id, [...new Set(actions)]);
  }
  return out;
}

/**
 * `policy.liftedFloors` for the broker: the owner's confirmed opt-ins only, for the connector and
 * (Apple apps) for `apple.<app>`, which direct `node.*` calls use.
 */
export function brokerLiftedFloors(
  owner: ReadonlyMap<string, readonly string[]>,
  records: readonly Pick<ConnectorRecord, "id" | "type">[],
): NonNullable<PolicyConfig["liftedFloors"]> {
  const out: Record<string, string[]> = {};
  const types = new Map(records.map((r) => [r.id, r.type]));
  for (const [id, actions] of owner) {
    out[id] = [...actions];
    const type = types.get(id);
    const appleKey = type === undefined ? undefined : appleConnectorKey(type);
    if (appleKey !== undefined)
      out[appleKey] = [...new Set([...(out[appleKey] ?? []), ...actions])];
  }
  return out;
}

/**
 * `policy.connectors` for the broker: `permissions.policy`'s entries with the owner's Settings
 * rules on top, for the connector and (Apple apps) for `apple.<app>`, which direct `node.*`
 * calls use.
 *
 * Settings saves a connector's whole matrix, so a rule equal to its catalogue default is an echo,
 * not a choice: it stays out, and the broker keeps its own defaults until the owner changes a
 * group (a default `allow` read keeps the first-read card; node writes keep asking).
 */
export function brokerConnectors(
  base: PolicyConfig["connectors"],
  owner: ReadonlyMap<string, Matrix>,
  records: readonly Pick<ConnectorRecord, "id" | "type" | "config">[],
  defaults: (type: string) => Readonly<Record<string, string>> | undefined = () => undefined,
): NonNullable<PolicyConfig["connectors"]> {
  const out: Record<string, Matrix> = {};
  const layer = (id: string, m: Matrix) => {
    out[id] = { ...(out[id] ?? {}), ...m };
  };
  for (const [id, m] of Object.entries(base ?? {})) layer(id, rulesOf(m));
  const types = new Map(records.map((r) => [r.id, r.type]));
  for (const [id, m] of owner) {
    const type = types.get(id);
    const d = (type === undefined ? undefined : defaults(type)) ?? {};
    const chosen = Object.fromEntries(Object.entries(m).filter(([k, v]) => d[k] !== v));
    layer(id, chosen);
    const appleKey = type === undefined ? undefined : appleConnectorKey(type);
    if (appleKey !== undefined) layer(appleKey, chosen);
  }
  for (const r of records) {
    const shortcuts = r.config.shortcutRules;
    if (typeof shortcuts === "object" && shortcuts !== null && !Array.isArray(shortcuts)) {
      const sub: Matrix = {};
      for (const [sid, rule] of Object.entries(shortcuts)) {
        const mapped = SHORTCUT_RULE[String(rule)];
        if (sid !== "" && mapped !== undefined) sub[`shortcuts.run/${sid}`] = mapped;
      }
      layer(r.id, sub);
    }
  }
  return out;
}

export interface ConnectorMatrixSync {
  /** Re-applies the stored rules to the broker and the executor (boot, after any change). */
  sync(): Promise<void>;
  /**
   * Re-layers the broker's connector rules right away from the records last seen (a new
   * `permissions.policy` replaced them), before `sync` re-reads the records.
   */
  applyNow(): void;
  /** Whether a `settings.changed` entry is one this layer follows. */
  follows(key: string): boolean;
}

export function connectorMatrixSync(
  services: ComposeServices,
  registry: ConnectorRegistry,
): ConnectorMatrixSync {
  const { db, rawBroker, logger } = services;
  const warn = (msg: string, err: unknown, fields: Record<string, unknown> = {}) =>
    logger?.log("warn", msg, { ...fields, code: PsycheError.from(err).code });
  // One pass at a time; a change during a pass runs one more.
  let running: Promise<void> | undefined;
  let again = false;
  let records: ConnectorRecord[] = [];
  const defaultsByType = new Map(
    registry
      .catalogue()
      .map((e) => [e.type, Object.fromEntries(e.actions.map((a) => [a.id, a.defaultRule]))]),
  );
  const defaultsFor = (type: string) => defaultsByType.get(type);

  function applyBroker(): void {
    const settings = getSettings(db);
    const owner = ownerMatrices(settings);
    const policy = getSetting(db, "permissions.policy")?.value as PolicyConfig | undefined;
    try {
      rawBroker.setPolicy({
        ...rawBroker.policy,
        connectors: brokerConnectors(policy?.connectors, owner, records, defaultsFor),
        liftedFloors: brokerLiftedFloors(ownerLiftedFloors(settings), records),
      });
    } catch (err) {
      warn("applying connector rules to the broker failed", err);
    }
  }

  async function setMatrix(record: ConnectorRecord, wanted: Matrix): Promise<void> {
    const changed = Object.entries(wanted).filter(([k, v]) => record.actionMatrix[k] !== v);
    if (changed.length === 0) return;
    try {
      await registry.setMatrix(record.id, Object.fromEntries(changed));
    } catch {
      // One bad entry (an unknown group, allow on a send) must not drop the rest.
      for (const [k, v] of changed) {
        await registry.setMatrix(record.id, { [k]: v }).catch((err) =>
          warn("a connector rule could not be applied", err, {
            connectorId: record.id,
            action: k,
          }),
        );
      }
    }
  }

  async function pass(): Promise<void> {
    records = await registry.list();
    applyBroker();
    const owner = ownerMatrices(getSettings(db));
    for (const r of records) {
      const wanted = owner.get(r.id);
      if (wanted !== undefined) await setMatrix(r, wanted);
    }
  }

  async function sync(): Promise<void> {
    if (running !== undefined) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        await pass().catch((err) => warn("syncing connector rules failed", err));
      } while (again);
    })().finally(() => {
      running = undefined;
    });
    return running;
  }

  return {
    sync,
    applyNow: applyBroker,
    follows: (key) =>
      key === "permissions.policy" ||
      key.startsWith(CONNECTOR_MATRIX_PREFIX) ||
      key.startsWith(LIFTED_FLOORS_PREFIX),
  };
}
