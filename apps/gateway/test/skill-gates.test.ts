import { APPROVAL_ARM_DELAY_MS, type IssuedApproval, PsycheError } from "@psyche/protocol";
import { FakeClock, FakePermissionBroker } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { skillGates } from "../src/compose/skills.ts";

/** Shared bundles: who may sign with the owner's key, and what loosening trust needs. */

const ACTION = {
  name: "tidy",
  treeHash: `sha256:${"a".repeat(64)}`,
  origin: "workspace",
  files: [{ path: "SKILL.md", bytes: 10, executable: false }],
};

function rig(
  opts: { shell?: boolean; loopback?: boolean; origin?: string | null; presence?: string } = {},
) {
  const clock = new FakeClock();
  const broker = new FakePermissionBroker({ clock });
  const published: { event: string; payload: unknown }[] = [];
  // The answer tokens of the cards the gate issues, so a test can answer them as a device.
  const issued: IssuedApproval[] = [];
  const request = broker.requestApproval.bind(broker);
  broker.requestApproval = async (input) => {
    const r = await request(input);
    issued.push(r);
    return r;
  };
  const services = {
    broker,
    publish: (event: string, payload: unknown) => published.push({ event, payload }),
  };
  const call = {
    identity: { desktopShell: opts.shell ?? true, deviceId: "dev1" },
    conn: { peer: { remoteLoopback: opts.loopback ?? true, origin: opts.origin ?? null } },
    ctx: {
      presenceState: () => opts.presence ?? "off",
      bus: { publish: (event: string, payload: unknown) => published.push({ event, payload }) },
      broker,
    },
  };
  const gates = skillGates(services as never);
  return { clock, broker, published, call, gates, issued };
}

async function rejects(p: Promise<unknown>): Promise<PsycheError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(PsycheError);
    return e as PsycheError;
  }
  throw new Error("expected a rejection");
}

describe("export gate", () => {
  it("is for Psyche on the Host itself only, whatever the scopes or presence", async () => {
    for (const bad of [
      { shell: false },
      { loopback: false },
      { origin: "https://evil.example" },
      { shell: false, presence: "ready" },
    ]) {
      const r = rig(bad);
      const err = await rejects(r.gates.export?.(r.call, ACTION, undefined) as Promise<unknown>);
      expect(err.code).toBe("forbidden");
      expect(await r.broker.list()).toEqual([]);
    }
  });

  it("with no presence verifier, shows a device-only card with the name, hash and files, and signs only once it is approved", async () => {
    const r = rig();
    const err = await rejects(r.gates.export?.(r.call, ACTION, undefined) as Promise<unknown>);
    expect(err.code).toBe("approval_required");
    const approvalId = (err.details as { approvalId: string }).approvalId;
    const [card] = await r.broker.list();
    expect(card?.deviceOnly).toBe(true);
    expect(card?.surfaces).toEqual(["desktop"]);
    expect(card?.details).toMatchObject({
      kind: "skill_export",
      name: "tidy",
      treeHash: ACTION.treeHash,
      files: ["SKILL.md"],
      origin: "workspace",
    });
    expect(r.published.some((e) => e.event === "approval.created")).toBe(true);
    // Not approved yet.
    await rejects(r.gates.export?.(r.call, ACTION, approvalId) as Promise<unknown>);
    r.clock.advance(APPROVAL_ARM_DELAY_MS + 10);
    const issued = await r.broker.get(approvalId);
    expect(issued?.status).toBe("pending");
  });

  it("an approval for other files, or for another skill, does not cover this export", async () => {
    const r = rig();
    const err = await rejects(r.gates.export?.(r.call, ACTION, undefined) as Promise<unknown>);
    const approvalId = (err.details as { approvalId: string }).approvalId;
    const [card] = await r.broker.list();
    r.clock.advance(APPROVAL_ARM_DELAY_MS + 10);
    // The owner approves the card the Gateway showed (its answer token is the desktop's).
    // Presenting it for a different tree hash is a binding mismatch, not a pass.
    const other = { ...ACTION, treeHash: `sha256:${"b".repeat(64)}` };
    const e2 = await rejects(r.gates.export?.(r.call, other, approvalId) as Promise<unknown>);
    expect(["binding_mismatch", "approval_required", "forbidden"]).toContain(e2.code);
    expect(card?.kind).toBe("skill_install");
  });

  it("with a presence verifier, a policy_change card bound to the skill and its hash is requested", async () => {
    const r = rig({ presence: "ready" });
    const err = await rejects(r.gates.export?.(r.call, ACTION, undefined) as Promise<unknown>);
    expect(err.code).toBe("approval_required");
    const [card] = await r.broker.list();
    expect(card?.kind).toBe("policy_change");
    expect(card?.details).toMatchObject({
      kind: "skill_export",
      name: "tidy",
      treeHash: ACTION.treeHash,
    });
    // With presence gone (the verifier lost) it fails closed rather than falling back.
    const lost = rig({ presence: "unavailable" });
    expect(
      (await rejects(lost.gates.export?.(lost.call, ACTION, undefined) as Promise<unknown>)).code,
    ).toBe("presence_required");
  });
});

describe("the plain card is answered on the device that asked", () => {
  async function answered(by: string) {
    const r = rig();
    const err = await rejects(r.gates.export?.(r.call, ACTION, undefined) as Promise<unknown>);
    const approvalId = (err.details as { approvalId: string }).approvalId;
    r.clock.advance(APPROVAL_ARM_DELAY_MS + 10);
    await r.broker.answer({
      approvalId,
      answerToken: r.issued[0]?.answerTokens.desktop as string,
      decision: "approve",
      scope: "once",
      decidedBy: { deviceId: by },
    });
    return { r, approvalId };
  }

  it("a second paired computer cannot approve the Host's export", async () => {
    const { r, approvalId } = await answered("dev2");
    const err = await rejects(r.gates.export?.(r.call, ACTION, approvalId) as Promise<unknown>);
    expect(err.code).toBe("forbidden");
  });

  it("the Host's own desktop can, once, and only for the files the card named", async () => {
    const { r, approvalId } = await answered("dev1");
    const other = { ...ACTION, treeHash: `sha256:${"b".repeat(64)}` };
    await rejects(r.gates.export?.(r.call, other, approvalId) as Promise<unknown>);
    await r.gates.export?.(r.call, ACTION, approvalId);
  });

  it("the card is bound to the asking device: another device presenting it gets a mismatch", async () => {
    const { r, approvalId } = await answered("dev1");
    const elsewhere = { ...r.call, identity: { ...r.call.identity, deviceId: "dev2" } };
    const err = await rejects(r.gates.export?.(elsewhere, ACTION, approvalId) as Promise<unknown>);
    expect(["binding_mismatch", "forbidden"]).toContain(err.code);
  });
});

describe("author trust gate", () => {
  it("needs presence once a verifier exists, and fails closed when it is lost", async () => {
    const r = rig({ presence: "ready" });
    const action = { keyId: `sha256:${"c".repeat(64)}`, from: "seen", to: "trusted" };
    const err = await rejects(
      r.gates.authorChange?.(r.call, action, undefined) as Promise<unknown>,
    );
    expect(err.code).toBe("approval_required");
    const [card] = await r.broker.list();
    expect(card?.kind).toBe("policy_change");
    expect(card?.details).toMatchObject({
      kind: "skill_author",
      keyId: action.keyId,
      to: "trusted",
    });
    const lost = rig({ presence: "unavailable" });
    expect(
      (await rejects(lost.gates.authorChange?.(lost.call, action, undefined) as Promise<unknown>))
        .code,
    ).toBe("presence_required");
  });

  it("with no verifier it shows a device-only card, so trust never happens without one", async () => {
    const r = rig({ presence: "off" });
    const action = { keyId: `sha256:${"c".repeat(64)}`, from: "seen", to: "trusted" };
    const err = await rejects(
      r.gates.authorChange?.(r.call, action, undefined) as Promise<unknown>,
    );
    expect(err.code).toBe("approval_required");
    const [card] = await r.broker.list();
    expect(card?.deviceOnly).toBe(true);
    expect(card?.details).toMatchObject({
      kind: "skill_author",
      keyId: action.keyId,
      to: "trusted",
    });
  });

  it("trusting while installing rides on the install card when no verifier exists, and needs presence when one does", async () => {
    const off = rig({ presence: "off" });
    const action = {
      keyId: `sha256:${"c".repeat(64)}`,
      from: undefined,
      to: "trusted",
      via: "install" as const,
    };
    await off.gates.authorChange?.(off.call, action, undefined);
    expect(await off.broker.list()).toEqual([]);
    const ready = rig({ presence: "ready" });
    expect(
      (await rejects(ready.gates.authorChange?.(ready.call, action, undefined) as Promise<unknown>))
        .code,
    ).toBe("approval_required");
    expect((await ready.broker.list())[0]?.kind).toBe("policy_change");
  });
});

describe("rotating the author key and signing a notice use the same gate as an export", () => {
  const ROTATE = { keyId: `sha256:${"a".repeat(64)}`, name: "Ada" };
  const NOTICE = {
    kind: "key" as const,
    keyId: `sha256:${"a".repeat(64)}`,
    reason: "key leaked",
  };

  it("are for Psyche on the Host itself only, whatever the presence", async () => {
    for (const bad of [
      { shell: false },
      { loopback: false },
      { shell: false, presence: "ready" },
    ]) {
      const r = rig(bad);
      expect(
        (await rejects(r.gates.rotate?.(r.call, ROTATE, undefined) as Promise<unknown>)).code,
      ).toBe("forbidden");
      expect(
        (await rejects(r.gates.notice?.(r.call, NOTICE, undefined) as Promise<unknown>)).code,
      ).toBe("forbidden");
      expect(await r.broker.list()).toEqual([]);
    }
  });

  it("show a device-only card, and with a verifier ask for fresh presence; a lost verifier fails closed", async () => {
    const r = rig();
    const err = await rejects(r.gates.rotate?.(r.call, ROTATE, undefined) as Promise<unknown>);
    expect(err.code).toBe("approval_required");
    const [card] = await r.broker.list();
    expect(card?.deviceOnly).toBe(true);
    expect(card?.details).toMatchObject({ kind: "skill_author_rotate", keyId: ROTATE.keyId });
    const p = rig({ presence: "ready" });
    await rejects(p.gates.notice?.(p.call, NOTICE, undefined) as Promise<unknown>);
    const [pc] = await p.broker.list();
    expect(pc?.kind).toBe("policy_change");
    expect(pc?.details).toMatchObject({ kind: "skill_author_notice", noticeKind: "key" });
    const lost = rig({ presence: "unavailable" });
    expect(
      (await rejects(lost.gates.rotate?.(lost.call, ROTATE, undefined) as Promise<unknown>)).code,
    ).toBe("presence_required");
  });

  it("an approval for rotating is no use for signing a notice", async () => {
    const r = rig();
    const err = await rejects(r.gates.rotate?.(r.call, ROTATE, undefined) as Promise<unknown>);
    const approvalId = (err.details as { approvalId: string }).approvalId;
    r.clock.advance(APPROVAL_ARM_DELAY_MS + 10);
    const e2 = await rejects(r.gates.notice?.(r.call, NOTICE, approvalId) as Promise<unknown>);
    expect(["binding_mismatch", "approval_required", "forbidden"]).toContain(e2.code);
  });
});
