import { describe, expect, it } from "vitest";
import { Methods, validateParams, validateResult } from "../src/index.ts";

/** The wire shapes of the update foundation (updates design §2.2, §2.6, §2.10). */

const params = (method: string, value: unknown): boolean => {
  try {
    validateParams(method, value);
    return true;
  } catch {
    return false;
  }
};
const result = (method: string, value: unknown): boolean => {
  try {
    validateResult(method, value);
    return true;
  } catch {
    return false;
  }
};

describe("gateway.prepareUpdate", () => {
  const spec = Methods["gateway.prepareUpdate"];

  it("is an admin method that is not side-effecting (calling it again is safe)", () => {
    expect(spec.scope).toBe("operator.admin");
    expect(spec.sideEffecting).toBe(false);
  });

  it("takes an optional mode, wait and timeout within sane bounds", () => {
    expect(params("gateway.prepareUpdate", {})).toBe(true);
    expect(params("gateway.prepareUpdate", { mode: "check", waitMs: 0, timeoutMs: 5000 })).toBe(
      true,
    );
    expect(params("gateway.prepareUpdate", { mode: "restart" })).toBe(false);
    expect(params("gateway.prepareUpdate", { waitMs: 120_001 })).toBe(false);
    expect(params("gateway.prepareUpdate", { timeoutMs: 1000 })).toBe(false);
    expect(params("gateway.prepareUpdate", { timeoutMs: 600_001 })).toBe(false);
  });

  it("answers with the gate state, the deadline and the busy report", () => {
    const ok = {
      state: "ready",
      ready: true,
      deadline: "2026-11-05T12:00:00.000Z",
      busy: {
        runningTasks: 1,
        activeChats: 0,
        pendingApprovals: 2,
        recordings: 0,
        tasks: [{ id: "t1", title: "Book a table" }],
        chats: [],
      },
      checkpointed: { tasks: 1, chats: 0 },
    };
    expect(result("gateway.prepareUpdate", ok)).toBe(true);
    expect(result("gateway.prepareUpdate", { ...ok, deadline: null })).toBe(true);
    expect(result("gateway.prepareUpdate", { ...ok, state: "paused" })).toBe(false);
    expect(result("gateway.prepareUpdate", { ...ok, busy: { ...ok.busy, tasks: undefined } })).toBe(
      false,
    );
  });
});

describe("ConnectChallenge.server", () => {
  const base = {
    phase: "challenge",
    nonce: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
    serverOrigin: "http://127.0.0.1:7979",
    protocolVersion: 1,
    expiresAt: "2026-11-05T12:00:00.000Z",
  };

  it("is optional, so an older Gateway's challenge is still valid", () => {
    expect(result("connect", base)).toBe(true);
  });

  it("carries the version and an opaque build, and a commit when known", () => {
    expect(result("connect", { ...base, server: { version: "0.5.0", build: "b1" } })).toBe(true);
    expect(
      result("connect", { ...base, server: { version: "0.5.0", build: "b1", commit: "c0ffee" } }),
    ).toBe(true);
    expect(result("connect", { ...base, server: { version: "0.5.0" } })).toBe(false);
    expect(result("connect", { ...base, server: { version: "", build: "b" } })).toBe(false);
  });
});
