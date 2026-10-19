import { describe, expect, it } from "vitest";
import { INITIAL_STATUS, reduceStatus, type StatusAction } from "../../src/client/status.ts";

const run = (actions: StatusAction[]) => actions.reduce(reduceStatus, INITIAL_STATUS);

describe("reduceStatus", () => {
  it("walks connect → challenge → verify → paired", () => {
    const s = run([
      { type: "health", ok: true },
      { type: "connecting" },
      { type: "challenge", protocolVersion: 1 },
      { type: "verifying" },
      { type: "paired", scopes: ["operator.read"] },
    ]);
    expect(s).toEqual({
      health: "ok",
      phase: "paired",
      protocolVersion: 1,
      scopes: ["operator.read"],
      attempt: 0,
    });
  });

  it("counts failed attempts on close and resets on pairing", () => {
    const s = run([
      { type: "health", ok: false },
      { type: "connecting" },
      { type: "closed" },
      { type: "closed" },
    ]);
    expect(s.phase).toBe("disconnected");
    expect(s.health).toBe("unreachable");
    expect(s.attempt).toBe(2);
    expect(reduceStatus(s, { type: "pending", code: "ABCD-1234" })).toMatchObject({
      phase: "pending",
      pairingCode: "ABCD-1234",
      attempt: 0,
    });
  });

  it("keeps denied after the socket closes", () => {
    const s = run([{ type: "denied", reason: "revoked" }, { type: "closed" }]);
    expect(s.phase).toBe("denied");
  });

  it("never carries secret-looking fields", () => {
    const s = run([{ type: "connecting" }, { type: "error", code: "unauthorized" }]);
    expect(Object.keys(s).sort()).toEqual(["attempt", "health", "lastError", "phase"]);
  });
});
