import { describe, expect, it, vi } from "vitest";
import type { GatewayEvent } from "../../src/client/connection.ts";
import { type GatewayStatus, INITIAL_STATUS } from "../../src/client/status.ts";
import type { GatewayPort } from "../../src/shell/platform.ts";
import { ShellStore } from "../../src/shell/store.ts";

function fakeGateway(handlers: Record<string, (p: unknown) => unknown>) {
  const statusCbs = new Set<(s: GatewayStatus) => void>();
  const eventCbs = new Set<(e: GatewayEvent) => void>();
  const calls: [string, unknown][] = [];
  let seq = 0;
  const port: GatewayPort = {
    getStatus: async () => INITIAL_STATUS,
    onStatus: (cb) => {
      statusCbs.add(cb);
      return () => statusCbs.delete(cb);
    },
    onEvent: (cb) => {
      eventCbs.add(cb);
      return () => eventCbs.delete(cb);
    },
    onResync: () => () => undefined,
    call: async (m, p) => {
      calls.push([m, p]);
      const h = handlers[m];
      if (!h) throw Object.assign(new Error(m), { code: "unknown_method" });
      return h(p);
    },
  };
  return {
    port,
    calls,
    pair: () => {
      for (const cb of statusCbs) cb({ ...INITIAL_STATUS, health: "ok", phase: "paired" });
    },
    emit: (event: string, payload: unknown) => {
      for (const cb of eventCbs) cb({ event, payload, seq: seq++, stateVersion: seq });
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("ShellStore", () => {
  it("loads collections on pairing and streams deltas into messages", async () => {
    const gw = fakeGateway({
      "threads.list": () => ({ threads: [], nextCursor: null }),
      "approvals.list": () => ({ approvals: [], answerTokens: { ap1: "tok" } }),
      "notifications.list": () => ({ notifications: [], nextCursor: null }),
    });
    const store = new ShellStore(gw.port);
    store.start();
    gw.pair();
    await flush();
    expect(gw.calls.map((c) => c[0]).sort()).toEqual([
      "approvals.list",
      "notifications.list",
      "threads.list",
    ]);
    expect(store.getState().answerTokens).toEqual({ ap1: "tok" });

    gw.emit("chat.delta", { threadId: "t1", messageId: "m1", delta: "Three slots " });
    gw.emit("chat.delta", { threadId: "t1", messageId: "m1", delta: "work." });
    expect(store.getState().streaming.m1?.text).toBe("Three slots work.");
    gw.emit("chat.message", {
      message: {
        id: "m1",
        threadId: "t1",
        seq: 3,
        role: "agent",
        blocks: [{ type: "text", md: "Three slots work." }],
      },
    });
    expect(store.getState().streaming.m1).toBeUndefined();
    expect(store.getState().messages.t1?.map((m) => m.id)).toEqual(["m1"]);
  });

  it("answers approvals with the surface token and marks missing methods unavailable", async () => {
    const gw = fakeGateway({
      "approvals.get": () => ({ approval: {}, answerToken: "tok2" }),
      "approvals.answer": () => ({ approval: {}, grant: null }),
    });
    const store = new ShellStore(gw.port);
    await store.answerApproval("ap2", "deny");
    expect(gw.calls.at(-1)).toEqual([
      "approvals.answer",
      { approvalId: "ap2", answerToken: "tok2", decision: "deny" },
    ]);
    await expect(store.call("commands.list", {})).resolves.toBeUndefined();
    expect(store.getState().unavailable).toContain("commands.list");
  });
});

describe("ShellStore.updateThread", () => {
  const UNSUPPORTED = "Changing the permission mode needs a newer version of Psyche.";

  it("shows the Gateway's own message when it refuses, not 'newer version'", async () => {
    const message = "lmstudio/tiny-7b is not on the auto-mode allowlist.";
    const gw = fakeGateway({
      "threads.update": () => {
        throw Object.assign(new Error(message), { code: "forbidden" });
      },
    });
    const store = new ShellStore(gw.port);
    await expect(store.updateThread("t1", { permissionMode: "auto" }, UNSUPPORTED)).resolves.toBe(
      false,
    );
    expect(store.getState().toasts.map((t) => t.text)).toEqual([message]);
    expect(store.getState().unavailable).not.toContain("threads.update");
  });

  it("says 'newer version' only when the Gateway lacks the method", async () => {
    const store = new ShellStore(fakeGateway({}).port);
    await expect(store.updateThread("t1", { permissionMode: "auto" }, UNSUPPORTED)).resolves.toBe(
      false,
    );
    expect(store.getState().toasts.map((t) => t.text)).toEqual([UNSUPPORTED]);
  });

  it("applies the change and refreshes on success", async () => {
    const gw = fakeGateway({
      "threads.update": () => ({ thread: {} }),
      "threads.list": () => ({ threads: [] }),
      "approvals.list": () => ({ approvals: [] }),
      "notifications.list": () => ({ notifications: [] }),
    });
    const store = new ShellStore(gw.port);
    await expect(store.updateThread("t1", { modelRef: "a/b" }, UNSUPPORTED)).resolves.toBe(true);
    expect(gw.calls[0]).toEqual(["threads.update", { threadId: "t1", modelRef: "a/b" }]);
    expect(store.getState().toasts).toEqual([]);
  });
});

describe("toasts (docs/a11y-audit.md T1)", () => {
  it("pauses while held, closes after 8 s otherwise, and keeps errors until dismissed", async () => {
    vi.useFakeTimers();
    try {
      const { port } = fakeGateway({});
      const store = new ShellStore(port);
      store.toast("Saved");
      store.toast("Couldn't save", "error");
      store.holdToasts(true);
      vi.advanceTimersByTime(20_000);
      expect(store.getState().toasts.map((t) => t.text)).toEqual(["Saved", "Couldn't save"]);
      store.holdToasts(false);
      vi.advanceTimersByTime(8_000);
      expect(store.getState().toasts.map((t) => t.text)).toEqual(["Couldn't save"]);
      const err = store.getState().toasts[0];
      if (err) store.dismissToast(err.id);
      expect(store.getState().toasts).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
