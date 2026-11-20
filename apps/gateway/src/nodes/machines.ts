import { hostname } from "node:os";
import {
  getDevice,
  getNodeByDevice,
  listDevices,
  type MachineRecord,
  markMachineAnnounced,
  type PsycheDb,
} from "@psyche/db";
import {
  type ComputerSurface,
  type MachineInfo,
  machineNameOk,
  type NodeCapability,
} from "@psyche/protocol";
import { defaultHostLabel } from "../lan/names.ts";

/**
 * Machines on the Gateway (docs/design/linux-helper-only-2026.md sections 6.1, 6.2, 9; wave H3):
 * the accept-time capability allowlist, names, the `MachineInfo` the Gateway reports, and the
 * one-time announcement of a new machine.
 */

/** A machine was added, renamed or removed: what the composition root audits and announces. */
export interface MachineChange {
  change: "added" | "renamed" | "removed";
  machineId: string;
  deviceId: string;
  name: string;
  /** `renamed` only. */
  previousName?: string;
  /** The device whose decision this was (the owner's admin device), when there is one. */
  byDeviceId?: string | null;
  /** `added` only: how the owner approved it. */
  via?: MachineRecord["via"];
}

/**
 * The capabilities a machine may offer (design 6.2). The Gateway drops anything else from its
 * manifest at accept, so a compromised box cannot add a capability the Gateway then routes (a
 * `notify.*`, `keychain.*`, `presence.*`, `screen.*` or `teach.*` of the Host's kind). `health`
 * and `machine.status` are the only ones `nodes.invoke` reaches; the rest are used only through
 * the agent's tools (wave H4 and later).
 */
const MACHINE_CAPABILITY_NAMES: ReadonlySet<string> = new Set([
  "health",
  "machine.status",
  "a11y.status",
  "portal.status",
  "apps.list",
  "apps.open",
  "apps.focus",
  "exec.host",
  "fs.list",
  "fs.stat",
  "fs.read",
  "fs.write",
  "fs.mkdir",
  "fs.remove",
]);

/** `computer.*` and `vscreen.*`: one plain lowercase segment after the namespace. */
const MACHINE_CAPABILITY_FAMILY = /^(computer|vscreen)\.[a-z][a-z0-9_]*$/;

/** The most capabilities a machine keeps; a manifest longer than the allowlist is not honest. */
const MAX_MACHINE_CAPABILITIES = 64;

export function isMachineCapability(name: string): boolean {
  return MACHINE_CAPABILITY_NAMES.has(name) || MACHINE_CAPABILITY_FAMILY.test(name);
}

/** What `nodes.invoke` may call on a machine: its health and its own status report. */
export function isMachineInvokeReachable(name: string): boolean {
  return name === "health" || name === "machine.status";
}

/** The declared capabilities that are on the allowlist, once each, in the order declared. */
export function filterMachineCapabilities(
  declared: readonly NodeCapability[] | undefined,
): NodeCapability[] {
  const seen = new Set<string>();
  const kept: NodeCapability[] = [];
  for (const capability of declared ?? []) {
    if (kept.length >= MAX_MACHINE_CAPABILITIES) break;
    if (!isMachineCapability(capability.name) || seen.has(capability.name)) continue;
    seen.add(capability.name);
    kept.push(capability);
  }
  return kept;
}

/**
 * Whether a network `linux-helper` that has no machine token may open a pairing card. Off until the
 * machine UI (wave H6) can show the card for what it is; until then a machine pairs only with a
 * link. The card path's code and tests stay behind this one flag.
 */
export const MACHINE_PAIRING_CARDS_ENABLED = false as boolean;
let cardsOverride: boolean | undefined;
export function machinePairingCardsEnabled(): boolean {
  return cardsOverride ?? MACHINE_PAIRING_CARDS_ENABLED;
}
/** Tests only: turn the card path on or back to its constant. */
export function forceMachinePairingCardsForTests(on: boolean | undefined): void {
  cardsOverride = on;
}

/** Format and default-ignorable characters that make two names look the same (and are not shown). */
const IGNORABLE =
  /\p{Cf}|\p{Cc}|\p{Mn}|\p{Me}|[\u180b-\u180f\ufe00-\ufe0f]|\u3164|\uffa0|\u115f|\u1160/gu;

/** Cyrillic and Greek letters that read as a Latin one (lowercase; the key is case-folded first). */
const CONFUSABLES: Readonly<Record<string, string>> = {
  "\u0430": "a",
  "\u0435": "e",
  "\u043e": "o",
  "\u0440": "p",
  "\u0441": "c",
  "\u0443": "y",
  "\u0445": "x",
  "\u0456": "i",
  "\u0458": "j",
  "\u0455": "s",
  "\u04bb": "h",
  "\u0501": "d",
  "\u043a": "k",
  "\u043c": "m",
  "\u043d": "h",
  "\u0442": "t",
  "\u0432": "b",
  "\u0437": "3",
  "\u03b1": "a",
  "\u03b2": "b",
  "\u03b5": "e",
  "\u03b6": "z",
  "\u03b7": "n",
  "\u03b9": "i",
  "\u03ba": "k",
  "\u03bc": "u",
  "\u03bd": "v",
  "\u03bf": "o",
  "\u03c1": "p",
  "\u03c4": "t",
  "\u03c5": "u",
  "\u03c7": "x",
  "\u03c9": "w",
};

/**
 * Uppercase Greek and Cyrillic letters that read as a Latin one. Mapped before lowercasing: the
 * lowercase form of U+039C is U+03BC, which reads as `u`, while the capital reads as `M`.
 */
const UPPER_CONFUSABLES: Readonly<Record<string, string>> = {
  "\u0391": "a",
  "\u0392": "b",
  "\u0395": "e",
  "\u0396": "z",
  "\u0397": "h",
  "\u0399": "i",
  "\u039a": "k",
  "\u039c": "m",
  "\u039d": "n",
  "\u039f": "o",
  "\u03a1": "p",
  "\u03a4": "t",
  "\u03a5": "y",
  "\u03a7": "x",
  "\u0410": "a",
  "\u0412": "b",
  "\u0415": "e",
  "\u041a": "k",
  "\u041c": "m",
  "\u041d": "h",
  "\u041e": "o",
  "\u0420": "p",
  "\u0421": "c",
  "\u0422": "t",
  "\u0423": "y",
  "\u0425": "x",
  "\u0406": "i",
  "\u0408": "j",
  "\u0405": "s",
  "\u04c0": "l",
};

/** Latin-block and Cyrillic letters that read as another letter. */
const EXTRA_CONFUSABLES: Readonly<Record<string, string>> = {
  "\u0251": "a",
  "\u029f": "l",
  "\u04cf": "l",
  "\u044c": "b",
  "\u0131": "i",
};

/** Letters, digits and spacing vowel signs (`\p{Mc}`, so Devanagari words that differ by a vowel sign stay different). */
const KEPT = /[\p{L}\p{N}\p{Mc}]/u;

function skeleton(text: string): string {
  let out = "";
  for (const ch of text.normalize("NFKC").replace(IGNORABLE, "")) {
    let c = UPPER_CONFUSABLES[ch];
    if (c === undefined) {
      const lower = ch.toUpperCase().toLowerCase();
      c = EXTRA_CONFUSABLES[lower] ?? CONFUSABLES[lower] ?? lower;
    }
    if (!KEPT.test(c)) continue;
    // `i`, `l`, `1` (and capital `I`) share a shape in most UI fonts, as do `0` and `o`.
    if (c === "i" || c === "1") c = "l";
    else if (c === "0") c = "o";
    out += c;
  }
  return out;
}

/**
 * Names compare by what they look like: NFKC (so U+217C is `l`), invisible characters removed,
 * Cyrillic and Greek look-alikes mapped to Latin (capitals directly), `i`/`l`/`1` and `0`/`o`
 * folded, and everything that is not a letter, digit or spacing vowel sign dropped (so `This Mac.`,
 * `ThisMac` and `This-Mac` are one name). Design 8.2: a lookalike must not sit next to a real
 * machine, or the Host's label, under a name that reads the same.
 */
export function machineNameKey(name: string): string {
  return skeleton(name);
}

/** The key without trailing digits and separators: `This Mac 2` reads as `This Mac`. */
function machineNameStemKey(name: string): string {
  const cleaned = name.normalize("NFKC").replace(IGNORABLE, "");
  return skeleton(cleaned.replace(/[\p{N}\s._-]+$/u, ""));
}

/** A name that mixes Latin letters with Cyrillic or Greek ones is a lookalike attempt. */
export function isMixedScriptName(name: string): boolean {
  return /\p{Script=Latin}/u.test(name) && /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(name);
}

/** Labels the interface uses for the Host itself: never a machine's name. */
function reservedNameKeys(): Set<string> {
  const keys = new Set([machineNameKey("This Mac"), machineNameKey("This computer")]);
  for (const host of [hostname().trim(), defaultHostLabel()]) {
    if (host === "") continue;
    keys.add(machineNameKey(host));
    // `studio.local` and `studio` are both what the Mac calls itself.
    keys.add(machineNameKey(host.replace(/\.local$/iu, "")));
    keys.add(machineNameKey(host.split(".")[0] ?? host));
  }
  keys.delete("");
  return keys;
}

/**
 * Why a machine may not have this name, or undefined: it is the Host's own label or name, it
 * mixes scripts, or it is the name of another paired device or machine (the device list and the
 * machine list read the same). Unpaired and revoked rows hold no name: an unauthenticated caller
 * cannot squat one.
 */
export function machineNameRefusal(
  db: PsycheDb,
  name: string,
  exceptDeviceId?: string,
): "reserved" | "taken" | "mixed" | undefined {
  const key = machineNameKey(name);
  if (key === "") return "reserved";
  const reserved = reservedNameKeys();
  if (reserved.has(key)) return "reserved";
  // A reserved name followed by digits ("This Mac 2") is still the Host's.
  const stem = machineNameStemKey(name);
  if (stem !== "" && reserved.has(stem)) return "reserved";
  if (isMixedScriptName(name)) return "mixed";
  const taken = listDevices(db).some(
    (d) =>
      d.id !== exceptDeviceId &&
      d.pairedAt !== null &&
      d.revokedAt === null &&
      machineNameKey(d.name) === key,
  );
  return taken ? "taken" : undefined;
}

/** Whether another device or machine already has this name, or it is reserved. */
export function machineNameTaken(db: PsycheDb, name: string, exceptDeviceId?: string): boolean {
  return machineNameRefusal(db, name, exceptDeviceId) !== undefined;
}

const FALLBACK_MACHINE_NAME = "Linux computer";

/**
 * The name a newly paired machine gets: what it called itself when that is a name a machine may
 * have, else a plain one, with " 2", " 3"... added until no other machine has it. (Renaming to a
 * taken name is refused instead: `machines.rename`.)
 */
export function uniqueMachineName(
  db: PsycheDb,
  requested: string,
  exceptDeviceId?: string,
): string {
  const trimmed = requested.trim().slice(0, 56);
  let base = machineNameOk(trimmed) ? trimmed : FALLBACK_MACHINE_NAME;
  const why = machineNameRefusal(db, base, exceptDeviceId);
  if (why === "reserved" || why === "mixed") base = FALLBACK_MACHINE_NAME;
  if (!machineNameTaken(db, base, exceptDeviceId)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base} ${n}`;
    if (!machineNameTaken(db, candidate, exceptDeviceId)) return candidate;
  }
  return `${base} ${Date.now()}`.slice(0, 64);
}

/**
 * The machine as `machines.list` reports it. Everything here is what the Gateway stored plus the
 * manifest it kept; the box's own `machine.status` report (display, limits, account) arrives with
 * the helper waves, so until then those fields carry the cautious defaults.
 */
export function machineInfoOf(db: PsycheDb, record: MachineRecord): MachineInfo | undefined {
  const device = getDevice(db, record.deviceId);
  if (device === undefined || device.revokedAt) return undefined;
  const node = getNodeByDevice(db, record.deviceId);
  const names = new Set((node?.capabilities ?? []).map((c) => c.name));
  const hasScreen = [...names].some((n) => n.startsWith("vscreen.") || n.startsWith("computer."));
  const surfaces: ComputerSurface[] = hasScreen ? ["virtual_screen"] : [];
  return {
    id: record.id,
    deviceId: record.deviceId,
    name: device.name,
    platform: device.platform,
    status: node?.status ?? "offline",
    display: null,
    surfaces,
    exec: { enabled: names.has("exec.host"), contained: false },
    files: { roots: [] },
    account: "own",
    policyOwner: "user",
    passwordlessSudo: false,
    helperVersion: null,
    lastSeenAt: device.lastSeenAt ?? null,
  };
}

/**
 * Announces a new machine exactly once (the "added" event and notice), however it was approved:
 * the first caller wins the conditional UPDATE. Returns whether this call announced it.
 */
export function announceMachine(
  db: PsycheDb,
  record: MachineRecord,
  publish: (info: MachineInfo) => void,
  notify: ((change: MachineChange) => void) | null | undefined,
): boolean {
  if (!markMachineAnnounced(db, record.deviceId)) return false;
  const info = machineInfoOf(db, record);
  if (info === undefined) return false;
  publish(info);
  notify?.({
    change: "added",
    machineId: record.id,
    deviceId: record.deviceId,
    name: info.name,
    via: record.via,
    byDeviceId: record.approvedByDeviceId,
  });
  return true;
}
