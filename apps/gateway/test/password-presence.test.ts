import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { presenceChallenge } from "@psyche/permissions";
import type { ApprovalRequest } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import {
  type AuthorizationResult,
  BusCallError,
  composePasswordPresence,
  type LoginSession,
  PasswordNonces,
  type PresenceBus,
  type SessionProps,
} from "../src/compose/password-presence.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/**
 * Password presence (linux design §9) against a fake system bus: the two-step polkit check, the
 * binding of one dialog to one approval, and every refusal. The polkit and logind wire shapes are
 * covered by tests/linux/polkit_dbusmock_test.py.
 */

const NOT_REGISTERED = new BusCallError(
  "org.freedesktop.PolicyKit1.Error.Failed",
  "Action com.psyche.presence.confirm is not registered",
);
const CHALLENGE: AuthorizationResult = { isAuthorized: false, isChallenge: true, details: {} };

/** What the fake bus does; the test changes it between steps. */
class Ctl {
  t = 0;
  sessions: LoginSession[] = [{ id: "c2", uid: 1000, seat: "seat0", path: "/s/c2" }];
  props: SessionProps = {
    type: "wayland",
    active: true,
    remote: false,
    seat: "seat0",
    class: "user",
    locked: false,
  };
  step2: AuthorizationResult | Error = CHALLENGE;
  /** Called for the interactive check; resolve it to answer the dialog. */
  prompt: (cancelId: string) => Promise<AuthorizationResult> = async () => {
    this.t += 5_000;
    return { isAuthorized: true, isChallenge: false, details: {} };
  };
  connect: Error | undefined;
  checks: { flags: number; cancelId: string; action: string }[] = [];
  cancelled: string[] = [];
  closed = 0;
  releasePrompt: (r: AuthorizationResult | Error) => void = () => undefined;
  /** A prompt that waits until the test (or a cancel) settles it. */
  hang(): void {
    this.prompt = (id) =>
      new Promise<AuthorizationResult>((resolve, reject) => {
        this.releasePrompt = (r) => (r instanceof Error ? reject(r) : resolve(r));
        this.onCancel = () =>
          reject(new BusCallError("org.freedesktop.PolicyKit1.Error.Cancelled", `cancelled ${id}`));
      });
  }
  onCancel: () => void = () => undefined;

  bus(): PresenceBus {
    return {
      listSessions: async () => this.sessions,
      sessionProps: async () => this.props,
      checkAuthorization: async (_id, action, flags, cancelId) => {
        this.checks.push({ flags, cancelId, action });
        if (flags === 0) {
          if (this.step2 instanceof Error) throw this.step2;
          return this.step2;
        }
        return this.prompt(cancelId);
      },
      cancelCheckAuthorization: async (id) => {
        this.cancelled.push(id);
        this.onCancel();
      },
      close: () => {
        this.closed++;
      },
    };
  }
}

const clients: TestClient[] = [];
let composed: ComposedGateway | null = null;
let home = "";

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
});

async function setup(
  ctl: Ctl,
  opts: { platform?: NodeJS.Platform; promptTimeoutMs?: number; deadlineSlackMs?: number } = {},
) {
  home = mkdtempSync(join(tmpdir(), "psyche-password-"));
  composed = await composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
    parts: [
      (s) =>
        composePasswordPresence(s, {
          platform: opts.platform ?? "linux",
          uid: 1000,
          now: () => ctl.t,
          bus: async () => {
            if (ctl.connect) throw ctl.connect;
            return ctl.bus();
          },
          promptTimeoutMs: opts.promptTimeoutMs ?? 120_000,
          ...(opts.deadlineSlackMs === undefined ? {} : { deadlineSlackMs: opts.deadlineSlackMs }),
        }),
    ],
  });
  const admin = await adminClient(composed.gateway);
  clients.push(admin);
  return { c: composed, admin };
}

/** A card that requires authentication (a payment: presence is for payments only), armed. */
async function authCard(
  c: ComposedGateway,
  admin: TestClient,
  bindingHash = "b".repeat(64),
  runId: string | null = null,
) {
  const issued = await c.gateway.context.broker.requestApproval({
    kind: "purchase",
    summary: "Pay $5 to Example Shop",
    details: {},
    bindingHash,
    grantKey: bindingHash,
    requestedBy: { runId, taskId: null, threadId: null },
    sideEffect: "financial",
    surfaces: ["desktop", "web"],
    scopesOffered: ["once"],
    taint: false,
  });
  const got = await admin.call<{ approval: ApprovalRequest; answerToken?: string }>(
    "approvals.get",
    { approvalId: issued.approval.id },
  );
  await new Promise((r) => setTimeout(r, 450)); // past the arm delay
  return { approval: got.approval, token: got.answerToken ?? "" };
}

const approve = (admin: TestClient, a: { approval: ApprovalRequest; token: string }) =>
  admin.request(
    "approvals.approveWithPassword",
    { approvalId: a.approval.id, answerToken: a.token },
    ik(),
  );

const statusOf = async (admin: TestClient, id: string) =>
  (await admin.call<{ approval: ApprovalRequest }>("approvals.get", { approvalId: id })).approval
    .status;

describe("approvals.approveWithPassword", () => {
  it("approves after polkit says yes, with the two-step check and an audit entry", async () => {
    const ctl = new Ctl();
    const { c, admin } = await setup(ctl);
    const card = await authCard(c, admin);
    const res = (await approve(admin, card)) as {
      ok: boolean;
      payload: { approval: ApprovalRequest };
    };
    expect(res.ok).toBe(true);
    expect(res.payload.approval.status).toBe("approved");
    expect(res.payload.approval.scopeGranted).toBe("once");
    const interactive = ctl.checks.filter((x) => x.flags === 1);
    // Step 2 (flags 0) comes first in this attempt, then exactly one interactive check.
    const at = ctl.checks.findIndex((x) => x.flags === 1);
    expect(ctl.checks[at - 1]?.flags).toBe(0);
    expect(interactive).toEqual([
      { flags: 1, cancelId: `psyche-${card.approval.id}`, action: "com.psyche.presence.confirm" },
    ]);
    const audit = await c.audit.query({ kind: "approval.password_from_window" });
    expect(audit[0]?.data).toMatchObject({
      approvalId: card.approval.id,
      sessionId: "c2",
      presence: {
        kind: "password",
        verifier: "polkit",
        actionId: "com.psyche.presence.confirm",
        subject: "unix-session:c2",
      },
    });
    expect(ctl.closed).toBeGreaterThan(0);
  });

  it("a dismissed dialog is a cancelled, counted refusal and the card stays open", async () => {
    const ctl = new Ctl();
    ctl.prompt = async () => {
      ctl.t += 4_000;
      return { isAuthorized: false, isChallenge: false, details: { "polkit.dismissed": "true" } };
    };
    const { c, admin } = await setup(ctl);
    const card = await authCard(c, admin);
    expect(await approve(admin, card)).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(await statusOf(admin, card.approval.id)).toBe("pending");
    expect((await c.audit.query({ kind: "approval.answer_rejected" })).length).toBeGreaterThan(0);
  });

  it("a wrong password (slow refusal, not dismissed) is forbidden", async () => {
    const ctl = new Ctl();
    ctl.prompt = async () => {
      ctl.t += 9_000;
      return { isAuthorized: false, isChallenge: false, details: {} };
    };
    const { c, admin } = await setup(ctl);
    const card = await authCard(c, admin);
    expect(await approve(admin, card)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await statusOf(admin, card.approval.id)).toBe("pending");
  });

  it("no session: presence_unavailable_here, and no dialog is raised", async () => {
    const ctl = new Ctl();
    ctl.sessions = [];
    const { c, admin } = await setup(ctl);
    const card = await authCard(c, admin);
    expect(await approve(admin, card)).toMatchObject({
      ok: false,
      error: { code: "presence_unavailable_here", details: { reason: "no_session" } },
    });
    expect(ctl.checks.filter((x) => x.flags === 1)).toEqual([]);
  });

  it.each([
    ["a tty", { type: "tty" }],
    ["inactive", { active: false }],
    ["remote", { remote: true }],
    ["no seat", { seat: "" }],
    ["a greeter", { class: "greeter" }],
  ] as const)("a session that is %s does not qualify", async (_n, patch) => {
    const ctl = new Ctl();
    ctl.props = { ...ctl.props, ...patch };
    const { c, admin } = await setup(ctl);
    const card = await authCard(c, admin);
    expect(await approve(admin, card)).toMatchObject({
      ok: false,
      error: { code: "presence_unavailable_here" },
    });
  });

  it("another user's session does not qualify", async () => {
    const ctl = new Ctl();
    ctl.sessions = [{ id: "c9", uid: 1001, seat: "seat0", path: "/s/c9" }];
    const { c, admin } = await setup(ctl);
    const card = await authCard(c, admin);
    expect(await approve(admin, card)).toMatchObject({
      ok: false,
      error: { code: "presence_unavailable_here" },
    });
  });

  it("no agent: an instant refusal without a dismissal is presence_agent_missing", async () => {
    const ctl = new Ctl();
    ctl.prompt = async () => ({ isAuthorized: false, isChallenge: true, details: {} });
    const { c, admin } = await setup(ctl);
    const card = await authCard(c, admin);
    expect(await approve(admin, card)).toMatchObject({
      ok: false,
      error: { code: "presence_agent_missing" },
    });
    const status = await admin.call<{ verifiers: { kind: string; state: string }[] }>(
      "devices.presence.status",
      {},
    );
    expect(status.verifiers.find((v) => v.kind === "password")?.state).toBe("agent_missing");
  });

  it("already authorized without asking: presence_not_enforced, no dialog", async () => {
    const ctl = new Ctl();
    ctl.step2 = { isAuthorized: true, isChallenge: false, details: {} };
    const { c, admin } = await setup(ctl);
    const card = await authCard(c, admin);
    expect(await approve(admin, card)).toMatchObject({
      ok: false,
      error: { code: "presence_not_enforced" },
    });
    expect(ctl.checks.filter((x) => x.flags === 1)).toEqual([]);
    expect(await statusOf(admin, card.approval.id)).toBe("pending");
  });

  it("a locked screen does not qualify, though logind still says Active", async () => {
    const ctl = new Ctl();
    ctl.props = { ...ctl.props, locked: true };
    const { c, admin } = await setup(ctl);
    const card = await authCard(c, admin);
    expect(await approve(admin, card)).toMatchObject({
      ok: false,
      error: { code: "presence_unavailable_here", details: { reason: "no_session" } },
    });
    expect(ctl.checks).toEqual([]);
    expect(await statusOf(admin, card.approval.id)).toBe("pending");
  });

  it("a keep policy: the approval stands, every later one is refused before step 1", async () => {
    const ctl = new Ctl();
    ctl.prompt = async () => ({
      isAuthorized: true,
      isChallenge: false,
      details: { "polkit.retains_authorization_after_challenge": "true" },
    });
    const { c, admin } = await setup(ctl);
    const one = await authCard(c, admin, "a".repeat(64));
    expect(await approve(admin, one)).toMatchObject({ ok: true });
    const two = await authCard(c, admin, "c".repeat(64));
    const before = ctl.checks.length;
    expect(await approve(admin, two)).toMatchObject({
      ok: false,
      error: { code: "presence_not_enforced" },
    });
    expect(ctl.checks.length).toBe(before); // no polkit call at all, not even flags 0
    expect(await statusOf(admin, two.approval.id)).toBe("pending");
  });

  it("a bus that dies mid-dialog frees the slot: polkit_error now, and the next try works", async () => {
    const ctl = new Ctl();
    ctl.prompt = () => new Promise<AuthorizationResult>(() => undefined); // never answers
    const { c, admin } = await setup(ctl, { promptTimeoutMs: 100, deadlineSlackMs: 150 });
    const one = await authCard(c, admin, "a".repeat(64));
    expect(await approve(admin, one)).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(await statusOf(admin, one.approval.id)).toBe("pending");
    ctl.prompt = async () => ({ isAuthorized: true, isChallenge: false, details: {} });
    const two = await authCard(c, admin, "c".repeat(64));
    expect(await approve(admin, two)).toMatchObject({ ok: true });
  });

  it("a failed approval writes no password_from_window audit entry", async () => {
    const ctl = new Ctl();
    ctl.prompt = async () => {
      ctl.t += 9_000;
      return { isAuthorized: false, isChallenge: false, details: {} };
    };
    const { c, admin } = await setup(ctl);
    const card = await authCard(c, admin);
    await approve(admin, card);
    expect(await c.audit.query({ kind: "approval.password_from_window" })).toEqual([]);
  });

  it("policy missing: presence_policy_missing", async () => {
    const ctl = new Ctl();
    ctl.step2 = NOT_REGISTERED;
    const { c, admin } = await setup(ctl);
    const card = await authCard(c, admin);
    expect(await approve(admin, card)).toMatchObject({
      ok: false,
      error: { code: "presence_policy_missing" },
    });
  });

  it("any other D-Bus error refuses (unavailable), as does a missing bus", async () => {
    const ctl = new Ctl();
    ctl.step2 = new Error("boom");
    const { c, admin } = await setup(ctl);
    const card = await authCard(c, admin);
    expect(await approve(admin, card)).toMatchObject({ ok: false, error: { code: "unavailable" } });
    ctl.step2 = CHALLENGE;
    ctl.connect = new Error("no bus");
    expect(await approve(admin, card)).toMatchObject({ ok: false, error: { code: "unavailable" } });
    ctl.connect = undefined;
    ctl.prompt = async () => {
      throw new Error("bus dropped");
    };
    expect(await approve(admin, card)).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(await statusOf(admin, card.approval.id)).toBe("pending");
  });

  it("a card decided elsewhere while the dialog is up cancels the polkit call", async () => {
    const ctl = new Ctl();
    ctl.hang();
    const { c, admin } = await setup(ctl);
    const card = await authCard(c, admin);
    const pending = approve(admin, card);
    await new Promise((r) => setTimeout(r, 200));
    expect(ctl.checks.some((x) => x.flags === 1)).toBe(true);
    await admin.request(
      "approvals.answer",
      { approvalId: card.approval.id, answerToken: card.token, decision: "deny" },
      ik(),
    );
    expect(await pending).toMatchObject({ ok: false, error: { code: "answer_late" } });
    expect(ctl.cancelled).toEqual([`psyche-${card.approval.id}`]);
    expect(await statusOf(admin, card.approval.id)).toBe("denied");
  });

  it("an invalidated card cancels the polkit call too", async () => {
    const ctl = new Ctl();
    ctl.hang();
    const { c, admin } = await setup(ctl);
    const card = await authCard(c, admin, "d".repeat(64), "run_inv");
    const pending = approve(admin, card);
    await new Promise((r) => setTimeout(r, 200));
    await c.broker.revokeRunAuthority("run_inv");
    // A yes that arrives after the card was invalidated never approves.
    ctl.releasePrompt({ isAuthorized: true, isChallenge: false, details: {} });
    expect(await pending).toMatchObject({ ok: false, error: { code: "answer_late" } });
    expect(ctl.cancelled).toEqual([`psyche-${card.approval.id}`]);
    expect(await statusOf(admin, card.approval.id)).toBe("invalidated");
  });

  it("a dialog nobody answers is cancelled after the time limit", async () => {
    const ctl = new Ctl();
    ctl.hang();
    const { c, admin } = await setup(ctl, { promptTimeoutMs: 150 });
    const card = await authCard(c, admin);
    expect(await approve(admin, card)).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(ctl.cancelled).toEqual([`psyche-${card.approval.id}`]);
  });

  it("a second request while one dialog is open conflicts and opens no second dialog", async () => {
    const ctl = new Ctl();
    ctl.hang();
    const { c, admin } = await setup(ctl);
    const one = await authCard(c, admin, "a".repeat(64));
    const two = await authCard(c, admin, "c".repeat(64));
    const first = approve(admin, one);
    const second = approve(admin, two);
    expect(await second).toMatchObject({ ok: false, error: { code: "conflict" } });
    await new Promise((r) => setTimeout(r, 200));
    expect(ctl.checks.filter((x) => x.flags === 1)).toHaveLength(1);
    ctl.releasePrompt({ isAuthorized: true, isChallenge: false, details: {} });
    expect(await first).toMatchObject({ ok: true });
  });

  it("a wrong answer token is refused before any D-Bus call", async () => {
    const ctl = new Ctl();
    const { c, admin } = await setup(ctl);
    const card = await authCard(c, admin);

    expect(await approve(admin, { ...card, token: "nope" })).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    expect(ctl.checks.filter((x) => x.flags === 1)).toEqual([]);
  });

  it("a client-sent password assertion is refused, audited, and decides nothing", async () => {
    const ctl = new Ctl();
    const { c, admin } = await setup(ctl);
    const card = await authCard(c, admin);
    const res = await admin.request(
      "approvals.answer",
      {
        approvalId: card.approval.id,
        answerToken: card.token,
        decision: "approve",
        scope: "once",
        presence: { kind: "password", deviceId: "x", signature: "forged" },
      },
      ik(),
    );
    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await statusOf(admin, card.approval.id)).toBe("pending");
    expect(
      (await c.audit.query({ kind: "approval.answer_rejected" })).some(
        (e) => (e.data as { reason?: string }).reason === "password_from_client",
      ),
    ).toBe(true);
    // And the real path still works afterwards (the token was not spent).
    expect(await approve(admin, card)).toMatchObject({ ok: true });
  });

  it("is refused off Linux", async () => {
    const ctl = new Ctl();
    const { c, admin } = await setup(ctl, { platform: "darwin" });
    const card = await authCard(c, admin);
    expect(await approve(admin, card)).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(ctl.checks).toEqual([]);
  });

  it("is refused from a connection that is not the desktop shell", async () => {
    const ctl = new Ctl();
    const { c } = await setup(ctl);
    const handler = (await partFor(ctl, c)).handlers?.["approvals.approveWithPassword"];
    await expect(
      Promise.resolve().then(() =>
        (handler!.run as unknown as (call: unknown, p: unknown) => unknown)(
          { identity: { desktopShell: false, deviceId: "d" } },
          { approvalId: "a", answerToken: "t" },
        ),
      ),
    ).rejects.toMatchObject({ code: "forbidden", details: { reason: "not_desktop" } });
    expect(ctl.checks.filter((x) => x.flags === 1)).toEqual([]);
  });
});

async function partFor(ctl: Ctl, c: ComposedGateway) {
  const services = {
    db: c.db,
    rawBroker: c.broker,
    audit: c.audit,
    clock: { now: () => Date.now() },
  } as never;
  return composePasswordPresence(services, {
    platform: "linux",
    uid: 1000,
    now: () => ctl.t,
    bus: async () => ctl.bus(),
  });
}

describe("devices.presence.status", () => {
  it("reports the password row for each state", async () => {
    const ctl = new Ctl();
    const { admin } = await setup(ctl);
    const row = async () =>
      (
        await admin.call<{ verifiers: { kind: string; state: string; detail?: string }[] }>(
          "devices.presence.status",
          {},
        )
      ).verifiers.find((v) => v.kind === "password");
    expect(await row()).toMatchObject({ state: "ready" });
    ctl.t += 60_000; // stale: re-probed
    ctl.sessions = [];
    expect(await row()).toMatchObject({ state: "no_session" });
    ctl.t += 60_000;
    ctl.sessions = [{ id: "c2", uid: 1000, seat: "seat0", path: "/s/c2" }];
    ctl.step2 = NOT_REGISTERED;
    expect(await row()).toMatchObject({ state: "policy_missing" });
    ctl.t += 60_000;
    ctl.step2 = { isAuthorized: true, isChallenge: false, details: {} };
    expect(await row()).toMatchObject({ state: "not_enforced" });
    ctl.t += 60_000;
    ctl.step2 = CHALLENGE;
    ctl.props = { ...ctl.props, type: "x11" };
    expect(await row()).toMatchObject({ state: "ready", detail: "x11" });
  });
});

describe("PasswordNonces", () => {
  const challenge = (a: string) => presenceChallenge(a, "b".repeat(64), "tok");
  const assertion = (signature: string, deviceId = "dev") =>
    ({ kind: "password", deviceId, signature }) as const;

  it("accepts a live nonce once, for its challenge and device", async () => {
    let t = 0;
    const n = new PasswordNonces(() => t);
    const v = n.mint(challenge("a1"), "dev");
    expect(await n.verify(assertion(v), challenge("a1"), "dev")).toBe(true);
    expect(await n.verify(assertion(v), challenge("a1"), "dev")).toBe(false); // replay
    t = 1;
  });

  it("refuses and consumes a nonce used for another approval's challenge", async () => {
    const n = new PasswordNonces(() => 0);
    const v = n.mint(challenge("a1"), "dev");
    expect(await n.verify(assertion(v), challenge("a2"), "dev")).toBe(false);
    expect(await n.verify(assertion(v), challenge("a1"), "dev")).toBe(false);
  });

  it("refuses another device, another kind, a guess and an expired nonce", async () => {
    let t = 0;
    const n = new PasswordNonces(() => t);
    const v = n.mint(challenge("a1"), "dev");
    expect(await n.verify(assertion(v, "other"), challenge("a1"), "other")).toBe(false);
    const w = n.mint(challenge("a1"), "dev");
    expect(await n.verify({ ...assertion(w), kind: "helper" }, challenge("a1"), "dev")).toBe(false);
    expect(await n.verify(assertion("guess"), challenge("a1"), "dev")).toBe(false);
    // The guess consumed nothing: w is still good until it expires.
    const x = n.mint(challenge("a1"), "dev");
    t = 60_000;
    expect(await n.verify(assertion(x), challenge("a1"), "dev")).toBe(false);
  });
});
