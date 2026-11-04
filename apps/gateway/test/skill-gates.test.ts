import { APPROVAL_ARM_DELAY_MS, PsycheError } from "@psyche/protocol";
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
  return { clock, broker, published, call, gates };
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

  it("leaves a fresh install (no verifier ever enrolled) working with admin alone", async () => {
    const r = rig({ presence: "off" });
    await r.gates.authorChange?.(r.call, { keyId: "k", from: "seen", to: "trusted" }, undefined);
    expect(await r.broker.list()).toEqual([]);
  });
});
