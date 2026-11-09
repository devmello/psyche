import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { countActivePasskeys, type PsycheDb } from "@psyche/db";
import {
  type PresenceAssertion,
  type PresenceVerifier,
  presenceChallenge,
} from "@psyche/permissions";
import { type ErrorCode, PsycheError } from "@psyche/protocol";
import type { Call } from "../context.ts";
import { surfaceOf } from "./handlers.ts";
import { HelperPresenceKeys } from "./presence-keys.ts";
import type { ComposedPart, ComposeServices } from "./services.ts";

/**
 * Password presence on Linux (linux design §9, security §3.7 "Linux specifics").
 *
 * Allow in the desktop window on a card that needs presence asks polkit, over psyched's own
 * system-bus connection, to authorize `com.psyche.presence.confirm` for the owner's active local
 * graphical session. polkit shows the session's authentication agent (a root-owned policy, fixed
 * text), PAM checks the password, and polkitd answers psyched. No password ever reaches Psyche.
 *
 * polkit's yes goes to the caller only, it is not a signature. So the binding lives here: one
 * check at a time, tied to one approval, binding hash and answer token; cancelled when the card
 * is decided, expires or is invalidated; and its yes becomes a random one-use nonce that the
 * verifier below accepts, once, for exactly that challenge and device. Everything fails closed:
 * any D-Bus error, odd answer or race refuses. Nothing is cached except a readiness hint.
 */

export const PRESENCE_ACTION_ID = "com.psyche.presence.confirm";
const POLKIT_NAME = "org.freedesktop.PolicyKit1";
const POLKIT_PATH = "/org/freedesktop/PolicyKit1/Authority";
const POLKIT_IFACE = "org.freedesktop.PolicyKit1.Authority";
const LOGIND_NAME = "org.freedesktop.login1";
const LOGIND_PATH = "/org/freedesktop/login1";
const LOGIND_MANAGER = "org.freedesktop.login1.Manager";
const LOGIND_SESSION = "org.freedesktop.login1.Session";
const PROPS_IFACE = "org.freedesktop.DBus.Properties";

/** A session as `ListSessions` reports it. */
export interface LoginSession {
  id: string;
  uid: number;
  seat: string;
  path: string;
}

/** The logind properties that decide whether a session can show a password dialog. */
export interface SessionProps {
  type: string;
  active: boolean;
  remote: boolean;
  seat: string;
  class: string;
  /** logind's `LockedHint`: `Active` stays true while the screen is locked. */
  locked: boolean;
}

export interface AuthorizationResult {
  isAuthorized: boolean;
  isChallenge: boolean;
  details: Record<string, string>;
}

/** The only D-Bus surface this file uses; tests pass a fake. */
export interface PresenceBus {
  listSessions(): Promise<LoginSession[]>;
  sessionProps(session: LoginSession): Promise<SessionProps>;
  /** `CheckAuthorization` with a `unix-session` subject, empty details. `flags`: 0 or 1. */
  checkAuthorization(
    sessionId: string,
    actionId: string,
    flags: 0 | 1,
    cancellationId: string,
  ): Promise<AuthorizationResult>;
  cancelCheckAuthorization(cancellationId: string): Promise<void>;
  close(): void;
}

/** Opens a fresh connection to the system bus. Rejects when there is none. */
export type PresenceBusFactory = () => Promise<PresenceBus>;

/** An error from the bus with polkit's own name, kept apart from every other failure. */
export class BusCallError extends Error {
  readonly dbusName: string;
  constructor(dbusName: string, message: string) {
    super(message);
    this.name = "BusCallError";
    this.dbusName = dbusName;
  }
}

/** The connection to the bus ended or failed while a call was waiting. */
export class BusConnectionLost extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BusConnectionLost";
  }
}

/** The interactive check did not return by its hard deadline. */
export class PromptDeadlineError extends Error {
  constructor() {
    super("the password dialog check did not return in time");
    this.name = "PromptDeadlineError";
  }
}

export const SYSTEM_BUS_ADDRESS = "unix:path=/run/dbus/system_bus_socket";

const BUS_CALL_TIMEOUT_MS = 8_000;
/** Beyond the owner's time to type: how long a cancelled or silent check may take to return. */
const PROMPT_DEADLINE_SLACK_MS = 5_000;

function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out`)), BUS_CALL_TIMEOUT_MS);
    timer.unref?.();
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/** A bus client (dbus-next, pure JS) on `address`, loaded on first use. */
async function openPresenceBus(address: string): Promise<PresenceBus> {
  const dbus = await import("dbus-next");
  const bus = dbus.sessionBus({ busAddress: address });
  // dbus-next 0.10.2 never rejects calls still waiting when the connection ends, so a bus that
  // restarts mid-dialog would leave them pending forever. Every call races this instead.
  let gone: ((e: Error) => void) | undefined;
  const goneP = new Promise<never>((_, reject) => {
    gone = reject;
  });
  goneP.catch(() => undefined);
  const onGone = (e?: unknown) => {
    gone?.(new BusConnectionLost(e instanceof Error ? e.message : "connection ended"));
  };
  // A dropped connection must not become an uncaught 'error' event.
  bus.on("error", onGone);
  const conn = (bus as unknown as { _connection?: NodeJS.EventEmitter })._connection;
  conn?.on("end", onGone);
  conn?.on("close", onGone);
  const call = async (
    path: string,
    iface: string,
    member: string,
    destination: string,
    signature: string,
    body: unknown[],
    timeout = true,
  ): Promise<unknown[]> => {
    const msg = new dbus.Message({ destination, path, interface: iface, member, signature, body });
    try {
      const p = Promise.race([bus.call(msg).then((r) => (r?.body ?? []) as unknown[]), goneP]);
      return await (timeout ? withTimeout(p, member) : p);
    } catch (err) {
      const e = err as { type?: unknown; text?: unknown; message?: unknown };
      if (typeof e.type === "string") {
        throw new BusCallError(e.type, typeof e.text === "string" ? e.text : String(e.message));
      }
      throw err;
    }
  };
  const variant = (v: unknown): unknown =>
    v !== null && typeof v === "object" && "value" in (v as object)
      ? (v as { value: unknown }).value
      : v;
  return {
    async listSessions() {
      const [rows] = await call(LOGIND_PATH, LOGIND_MANAGER, "ListSessions", LOGIND_NAME, "", []);
      if (!Array.isArray(rows)) throw new Error("ListSessions returned no list");
      return rows.map((r: unknown[]) => ({
        id: String(r[0]),
        uid: Number(r[1]),
        seat: String(r[3] ?? ""),
        path: String(r[4]),
      }));
    },
    async sessionProps(session) {
      const [all] = await call(session.path, PROPS_IFACE, "GetAll", LOGIND_NAME, "s", [
        LOGIND_SESSION,
      ]);
      const p = (all ?? {}) as Record<string, unknown>;
      const seat = variant(p.Seat);
      return {
        type: String(variant(p.Type) ?? ""),
        active: variant(p.Active) === true,
        remote: variant(p.Remote) !== false,
        seat: Array.isArray(seat) ? String(seat[0] ?? "") : "",
        class: String(variant(p.Class) ?? ""),
        // Fail closed: a missing hint counts as locked.
        locked: variant(p.LockedHint) !== false,
      };
    },
    async checkAuthorization(sessionId, actionId, flags, cancellationId) {
      const subject = ["unix-session", { "session-id": new dbus.Variant("s", sessionId) }];
      const [res] = await call(
        POLKIT_PATH,
        POLKIT_IFACE,
        "CheckAuthorization",
        POLKIT_NAME,
        "(sa{sv})sa{ss}us",
        [subject, actionId, {}, flags, cancellationId],
        // Interactive: the owner may take a while; the caller sets its own limit.
        flags === 0,
      );
      if (!Array.isArray(res) || res.length < 3) throw new Error("CheckAuthorization: bad reply");
      const details: Record<string, string> = {};
      for (const [k, v] of Object.entries((res[2] ?? {}) as Record<string, unknown>)) {
        details[k] = String(v);
      }
      return { isAuthorized: res[0] === true, isChallenge: res[1] === true, details };
    },
    async cancelCheckAuthorization(cancellationId) {
      await call(POLKIT_PATH, POLKIT_IFACE, "CancelCheckAuthorization", POLKIT_NAME, "s", [
        cancellationId,
      ]);
    },
    close() {
      try {
        bus.disconnect();
      } catch {
        // already gone
      }
    },
  };
}

/**
 * The production factory: always the one system bus socket. It reads NO environment variable
 * (`DBUS_SYSTEM_BUS_ADDRESS` and the like can be set for a user service through
 * `systemctl --user set-environment`, `environment.d` or a unit drop-in, and would point psyched
 * at a fake polkitd that says yes).
 */
export const systemPresenceBus: PresenceBusFactory = () => openPresenceBus(SYSTEM_BUS_ADDRESS);

/**
 * TEST ONLY: a client on another bus address (the dbusmock harness's private bus). Nothing in
 * production imports this; the address always comes from the test's own code, never from the
 * environment of psyched.
 */
export const presenceBusAt =
  (address: string): PresenceBusFactory =>
  () =>
    openPresenceBus(address);

/** Why password presence cannot be used right now. */
export type PasswordState =
  | "ready"
  | "policy_missing"
  | "not_enforced"
  | "no_session"
  | "agent_missing"
  | "unavailable";

interface Preflight {
  state: Exclude<PasswordState, "agent_missing">;
  sessionId?: string;
  sessionType?: string;
  detail?: string;
}

const GRAPHICAL = new Set(["wayland", "x11"]);

/** polkit's reply for an action it does not know ("Action … is not registered"). */
function isUnknownAction(err: unknown): boolean {
  return (
    err instanceof BusCallError &&
    err.dbusName === "org.freedesktop.PolicyKit1.Error.Failed" &&
    /not registered/i.test(err.message)
  );
}

/**
 * Steps 1 and 2 of the check, shared by the readiness probe and every approval: the owner's
 * active local graphical session (logind), then polkit asked WITHOUT interaction. A yes without
 * asking means a rule approves everything, which proves no presence.
 */
export async function preflight(bus: PresenceBus, uid: number): Promise<Preflight> {
  const sessions = (await bus.listSessions()).filter((s) => s.uid === uid && s.seat !== "");
  let chosen: { s: LoginSession; p: SessionProps } | undefined;
  let lockedSeen = false;
  for (const s of sessions) {
    let p: SessionProps;
    try {
      p = await bus.sessionProps(s);
    } catch {
      continue; // a session that vanished cannot qualify
    }
    if (GRAPHICAL.has(p.type) && p.active && !p.remote && p.seat !== "" && p.class === "user") {
      // A locked screen keeps `Active=true`; nobody is at the keyboard to answer for it.
      if (p.locked) lockedSeen = true;
      else chosen ??= { s, p };
    }
  }
  if (chosen === undefined) {
    return {
      state: "no_session",
      detail: lockedSeen ? "The screen is locked" : "No active graphical session on this computer",
    };
  }
  const base = { sessionId: chosen.s.id, sessionType: chosen.p.type };
  let first: AuthorizationResult;
  try {
    first = await bus.checkAuthorization(chosen.s.id, PRESENCE_ACTION_ID, 0, "");
  } catch (err) {
    if (isUnknownAction(err)) {
      return { ...base, state: "policy_missing", detail: "The polkit policy is not installed" };
    }
    throw err;
  }
  if (first.isAuthorized) {
    return { ...base, state: "not_enforced", detail: "A polkit rule approves without a password" };
  }
  if (!first.isChallenge) {
    // polkit would refuse even with a password (a rule, or the session is not active for it).
    return { ...base, state: "no_session", detail: "polkit does not offer a password here" };
  }
  return { ...base, state: "ready" };
}

const NONCE_TTL_MS = 10_000;

interface NonceEntry {
  challenge: string;
  deviceId: string;
  expiresAt: number;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const sameText = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Accepts `kind: "password"` only for a nonce this process minted after polkit's yes, for the
 * same challenge and device, before it expires. A nonce is looked up by its hash and consumed on
 * the first lookup, match or not; an unknown value consumes nothing.
 */
export class PasswordNonces implements PresenceVerifier {
  readonly #live = new Map<string, NonceEntry>();
  readonly #now: () => number;
  constructor(now: () => number) {
    this.#now = now;
  }

  mint(challenge: string, deviceId: string): string {
    const now = this.#now();
    for (const [k, e] of this.#live) if (e.expiresAt < now) this.#live.delete(k);
    const nonce = randomBytes(32).toString("base64url");
    this.#live.set(sha(nonce), { challenge, deviceId, expiresAt: now + NONCE_TTL_MS });
    return nonce;
  }

  drop(nonce: string): void {
    this.#live.delete(sha(nonce));
  }

  get size(): number {
    return this.#live.size;
  }

  async verify(
    assertion: PresenceAssertion,
    challenge: string,
    deviceId: string,
  ): Promise<boolean> {
    if (assertion.kind !== "password") return false;
    const key = sha(assertion.signature);
    const entry = this.#live.get(key);
    if (entry === undefined) return false;
    this.#live.delete(key);
    return (
      this.#now() <= entry.expiresAt &&
      assertion.deviceId === deviceId &&
      entry.deviceId === deviceId &&
      sameText(entry.challenge, challenge)
    );
  }
}

export interface PasswordPresenceSetup {
  /** Opens the system bus; default: dbus-next. */
  bus?: PresenceBusFactory;
  /** Default `process.platform`; anything but `linux` mounts no password presence. */
  platform?: NodeJS.Platform;
  /** Default `process.getuid()`. */
  uid?: number;
  /** Monotonic milliseconds. */
  now?: () => number;
  /** A refusal faster than this, with no dismissal, means no agent showed a dialog. */
  agentGraceMs?: number;
  /** How long the owner has to type the password. */
  promptTimeoutMs?: number;
  /** How long past promptTimeoutMs a silent check may stay pending before it counts as failed. */
  deadlineSlackMs?: number;
  /** How long a readiness probe stays fresh. */
  probeTtlMs?: number;
}

interface Attempt {
  approvalId: string;
  cancelId: string;
  bus?: PresenceBus;
  cancelledBy?: "closed" | "timeout" | "stop";
}

const PROMPT_TIMEOUT_MS = 120_000;
const AGENT_GRACE_MS = 2_000;
const PROBE_TTL_MS = 30_000;
const PROBE_START_TIMEOUT_MS = 6_000;

function refuse(code: ErrorCode, message: string, reason: string): PsycheError {
  return new PsycheError(code, message, { details: { reason } });
}

export function composePasswordPresence(
  services: ComposeServices,
  setup: PasswordPresenceSetup = {},
): Promise<ComposedPart> {
  const platform = setup.platform ?? process.platform;
  const linux = platform === "linux";
  const openBus = setup.bus ?? systemPresenceBus;
  const now = setup.now ?? (() => performance.now());
  const uid = setup.uid ?? process.getuid?.() ?? -1;
  const agentGraceMs = setup.agentGraceMs ?? AGENT_GRACE_MS;
  const promptTimeoutMs = setup.promptTimeoutMs ?? PROMPT_TIMEOUT_MS;
  const probeTtlMs = setup.probeTtlMs ?? PROBE_TTL_MS;
  const deadlineSlackMs = setup.deadlineSlackMs ?? PROMPT_DEADLINE_SLACK_MS;
  const nonces = new PasswordNonces(now);
  const keys = new HelperPresenceKeys(services.db);

  let stopped = false;
  let active: Attempt | undefined;

  // Readiness hint only: never consulted to authorize an approval.
  let probe: (Preflight & { at: number }) | undefined;
  let lastReady = false;
  let probing: Promise<void> | undefined;
  let retains = false;
  let agentMissing = false;

  const record = (p: Preflight | { state: "unavailable"; detail: string }) => {
    probe = { ...p, at: now() };
    if (p.state === "ready") lastReady = true;
    // No session or a bus hiccup says nothing about the policy: keep the last known answer.
    else if (p.state === "policy_missing" || p.state === "not_enforced") lastReady = false;
  };

  function refreshProbe(): Promise<void> {
    // A keep policy is sticky: no probe can say more than that.
    if (!linux || stopped || retains) return Promise.resolve();
    probing ??= (async () => {
      let bus: PresenceBus | undefined;
      try {
        bus = await withTimeout(openBus(), "connect");
        record(await preflight(bus, uid));
      } catch {
        record({ state: "unavailable", detail: "polkit could not be reached" });
      } finally {
        bus?.close();
        probing = undefined;
      }
    })();
    return probing;
  }

  const stale = () => probe === undefined || now() - probe.at > probeTtlMs;

  const log = services.logger;
  const rawBroker = services.rawBroker;

  async function approveWithPassword(
    call: Call,
    params: { approvalId: string; answerToken: string },
  ) {
    if (!linux) {
      throw refuse("unavailable", "Password approvals work on Linux only", "not_linux");
    }
    // Only the Psyche app on this computer, whose Allow the owner just clicked.
    if (call.identity.desktopShell !== true) {
      throw refuse(
        "forbidden",
        "Password approvals come from the Psyche app on this computer",
        "not_desktop",
      );
    }
    if (active !== undefined || stopped) {
      throw new PsycheError("conflict", "A password dialog is already open for an approval");
    }
    // Taken before the first await: two calls racing through the checks open one dialog.
    const attempt: Attempt = {
      approvalId: params.approvalId,
      cancelId: `psyche-${params.approvalId}`,
    };
    active = attempt;
    const unsubscribe: (() => void)[] = [];
    let timer: NodeJS.Timeout | undefined;
    let nonce: string | undefined;
    const mine = () => active === attempt && attempt.cancelledBy === undefined;
    const cancel = (why: NonNullable<Attempt["cancelledBy"]>) => {
      if (attempt.cancelledBy !== undefined) return;
      attempt.cancelledBy = why;
      void attempt.bus?.cancelCheckAuthorization(attempt.cancelId).catch(() => undefined);
    };
    const late = () => new PsycheError("answer_late", "That approval is no longer open");
    try {
      const a = await rawBroker.get(params.approvalId);
      if (a === undefined)
        throw new PsycheError("not_found", `approval ${params.approvalId} not found`);
      if (a.status !== "pending")
        throw new PsycheError("answer_late", `approval already ${a.status}`);
      if (!a.requiresAuthentication) {
        throw new PsycheError(
          "invalid_params",
          "This approval needs no password; answer it directly",
        );
      }
      const by = {
        deviceId: call.identity.deviceId,
        surface: surfaceOf(services.db, call.identity.deviceId),
      };
      // The desktop shell on a loopback connection: its refused answers are audited, not counted.
      const local = call.conn.peer.remoteLoopback;
      // Before any dialog: this window's unused token, an armed card, not rate limited. A bad
      // token counts against the rejected-answer cap.
      await rawBroker.precheckAnswer({
        approvalId: a.id,
        answerToken: params.answerToken,
        decidedBy: by,
        local,
      });
      const reject = (reason: string, code: ErrorCode, message: string, details?: object) =>
        rawBroker.rejectPresence({
          approvalId: a.id,
          decidedBy: by,
          local,
          reason,
          code,
          message,
          details: { reason, ...(details ?? {}) },
        });
      unsubscribe.push(
        rawBroker.subscribe((e) => {
          if (
            (e.type === "approval.decided" ||
              e.type === "approval.expired" ||
              e.type === "approval.invalidated") &&
            e.approval.id === a.id
          ) {
            cancel("closed");
          }
        }),
      );

      // A *_keep policy was seen: polkit may answer yes without asking, which proves nothing.
      // Refuse before step 1, whatever polkit would say now.
      if (retains) {
        return await reject(
          "not_enforced",
          "presence_not_enforced",
          "The polkit policy keeps authorizations after a password, so it proves no presence",
        );
      }

      let bus: PresenceBus;
      try {
        bus = await withTimeout(openBus(), "connect");
      } catch {
        return await reject(
          "polkit_unreachable",
          "unavailable",
          "The system's password service could not be reached",
        );
      }
      attempt.bus = bus;
      if (!mine()) throw late();

      let pre: Preflight;
      try {
        pre = await preflight(bus, uid);
      } catch {
        return await reject(
          "polkit_error",
          "unavailable",
          "The system's password service did not answer",
        );
      }
      record(pre);
      if (pre.state === "no_session") {
        return await reject(
          "no_session",
          "presence_unavailable_here",
          "Approve at this computer, or with a passkey from another device",
        );
      }
      if (pre.state === "policy_missing") {
        return await reject(
          "policy_missing",
          "presence_policy_missing",
          "Psyche's password policy is not installed on this computer",
        );
      }
      if (pre.state === "not_enforced") {
        return await reject(
          "not_enforced",
          "presence_not_enforced",
          "A rule on this computer approves Psyche without a password",
        );
      }
      if (pre.state !== "ready" || pre.sessionId === undefined) {
        return await reject("polkit_error", "unavailable", "Password approvals are not available");
      }
      if (!mine()) throw late();

      // Step 3: the dialog. Synchronously after the check above, so a cancel that lands later
      // is queued behind this call on the same connection.
      const started = now();
      const pending = bus.checkAuthorization(
        pre.sessionId,
        PRESENCE_ACTION_ID,
        1,
        attempt.cancelId,
      );
      timer = setTimeout(() => cancel("timeout"), promptTimeoutMs);
      timer.unref?.();
      // Hard deadline: a bus that vanished mid-dialog never answers `pending`, and the slot
      // must not stay taken for every later approval.
      let deadline: NodeJS.Timeout | undefined;
      const deadlineP = new Promise<never>((_, rejectDeadline) => {
        deadline = setTimeout(
          () => rejectDeadline(new PromptDeadlineError()),
          promptTimeoutMs + deadlineSlackMs,
        );
        deadline.unref?.();
      });
      pending.catch(() => undefined); // a late failure after the deadline is not unhandled
      let res: AuthorizationResult | undefined;
      let failure: unknown;
      try {
        res = await Promise.race([pending, deadlineP]);
      } catch (err) {
        failure = err;
      }
      clearTimeout(deadline);
      clearTimeout(timer);
      const elapsed = now() - started;

      if (attempt.cancelledBy === "closed") throw late();
      if (
        attempt.cancelledBy !== undefined &&
        !(failure instanceof PromptDeadlineError || failure instanceof BusConnectionLost)
      ) {
        return await reject("presence_cancelled", "cancelled", "The password dialog timed out");
      }
      if (res === undefined) {
        log?.log("warn", "polkit check failed", {
          reason: failure instanceof Error ? failure.name : "unknown",
        });
        return await reject("polkit_error", "unavailable", "The system's password service failed");
      }
      if (!res.isAuthorized) {
        if (res.details["polkit.dismissed"] !== undefined) {
          agentMissing = false;
          return await reject(
            "presence_cancelled",
            "cancelled",
            "The password dialog was cancelled",
          );
        }
        if (elapsed < agentGraceMs) {
          agentMissing = true;
          return await reject(
            "agent_missing",
            "presence_agent_missing",
            "No password dialog is available on this desktop",
          );
        }
        agentMissing = false;
        return await reject("password_failed", "forbidden", "The password was not accepted", {
          reason: "password_failed",
        });
      }
      agentMissing = false;
      if (res.details["polkit.retains_authorization_after_challenge"] !== undefined) {
        // A *_keep policy: this approval stands, later ones will be refused as not enforced.
        retains = true;
      }

      // polkit said yes. Is it still this approval, still ours, still open?
      if (!mine()) throw late();
      const fresh = await rawBroker.get(a.id);
      if (
        !mine() ||
        fresh === undefined ||
        fresh.status !== "pending" ||
        fresh.bindingHash !== a.bindingHash
      ) {
        throw late();
      }

      const challenge = presenceChallenge(a.id, a.bindingHash, params.answerToken);
      nonce = nonces.mint(challenge, by.deviceId);
      const checkedAt = new Date(services.clock.now()).toISOString();
      const presence = {
        kind: "password",
        verifier: "polkit",
        actionId: PRESENCE_ACTION_ID,
        subject: `unix-session:${pre.sessionId}`,
        checkedAt,
      };
      // The answer is the window's (its token, its surface); `once` only, because the scope is
      // not part of what polkit confirmed.
      const approval = await rawBroker.answer({
        approvalId: a.id,
        answerToken: params.answerToken,
        decision: "approve",
        scope: "once",
        decidedBy: by,
        local,
        presence: { kind: "password", deviceId: by.deviceId, signature: nonce },
      });
      // Audited only once the broker accepted the answer: a refused or late one is the broker's
      // own audit entry, and this one means "approved with the owner's password".
      try {
        await services.audit.append({
          kind: "approval.password_from_window",
          actor: { type: "device", deviceId: call.identity.deviceId },
          data: { approvalId: a.id, sessionId: pre.sessionId, presence },
        });
      } catch (err) {
        log?.log("error", "could not audit a password approval", {
          reason: err instanceof Error ? err.name : "unknown",
        });
      }
      const grant =
        approval.grantId == null
          ? null
          : ((await rawBroker.listGrants({ includeRevoked: true })).find(
              (g) => g.id === approval.grantId,
            ) ?? null);
      return { approval, grant };
    } finally {
      clearTimeout(timer);
      if (nonce !== undefined) nonces.drop(nonce);
      for (const u of unsubscribe) u();
      attempt.bus?.close();
      if (active === attempt) active = undefined;
      void refreshProbe();
    }
  }

  async function presenceStatus() {
    if (linux && stale()) await refreshProbe();
    const verifiers: {
      kind: "touch_id_key" | "passkey" | "password";
      state: string;
      detail?: string;
    }[] = [];
    const hasKey = keys.list().length > 0;
    if (!linux || hasKey)
      verifiers.push({ kind: "touch_id_key", state: hasKey ? "ready" : "not_enrolled" });
    verifiers.push({
      kind: "passkey",
      state: countActivePasskeys(services.db as PsycheDb) > 0 ? "ready" : "not_enrolled",
    });
    if (linux) {
      const p = probe;
      let state: PasswordState = p?.state ?? "unavailable";
      let detail = p?.detail;
      if (retains) {
        state = "not_enforced";
        detail = "The polkit policy keeps authorizations after a password";
      } else if (state === "ready" && agentMissing) {
        state = "agent_missing";
        detail = "No password dialog is available on this desktop";
      } else if (state === "ready" && p?.sessionType === "x11") {
        // The UI shows its own translated X11 warning for this token.
        detail = "x11";
      }
      verifiers.push({ kind: "password", state, ...(detail === undefined ? {} : { detail }) });
    }
    return { verifiers };
  }

  const part: ComposedPart = {
    handlers: {
      "approvals.approveWithPassword": { run: approveWithPassword },
      "devices.presence.status": { run: presenceStatus },
    },
    ...(linux
      ? {
          presence: {
            kind: "password" as const,
            verifier: nonces,
            ready: () => {
              if (stale()) void refreshProbe();
              return lastReady && !retains;
            },
          },
        }
      : {}),
    stop() {
      stopped = true;
      const a = active;
      if (a !== undefined && a.cancelledBy === undefined) {
        a.cancelledBy = "stop";
        void a.bus?.cancelCheckAuthorization(a.cancelId).catch(() => undefined);
      }
    },
  };
  if (!linux) return Promise.resolve(part);
  // Readiness is known before the first gated call; a slow bus never holds up startup for long.
  return Promise.race([
    refreshProbe(),
    new Promise<void>((r) => setTimeout(r, PROBE_START_TIMEOUT_MS).unref?.()),
  ]).then(() => part);
}
