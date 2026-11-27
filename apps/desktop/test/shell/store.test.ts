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

  it("says Auto works only on the listed models, names the model, and offers Switch model", async () => {
    const gw = fakeGateway({
      "threads.update": () => {
        throw Object.assign(new Error("ignored"), {
          code: "forbidden",
          details: { reason: "auto_model_not_allowed", model: "lmstudio/tiny-7b" },
        });
      },
    });
    const store = new ShellStore(gw.port);
    const onSwitchModel = vi.fn();
    await expect(
      store.updateThread("t1", { permissionMode: "auto" }, UNSUPPORTED, { onSwitchModel }),
    ).resolves.toBe(false);
    const [toast] = store.getState().toasts;
    expect(toast?.text).toBe(
      "Auto works only on the listed models, and tiny-7b isn't on the Auto-mode list. Pick an allowed model, or use Manual or Balanced.",
    );
    expect(toast?.tone).toBe("warn");
    expect(toast?.action?.label).toBe("Switch model");
    expect(onSwitchModel).not.toHaveBeenCalled();
    toast?.action?.run();
    expect(onSwitchModel).toHaveBeenCalledTimes(1);
    expect(store.getState().unavailable).not.toContain("threads.update");
  });

  it("explains a refused Auto with no model pinned or configured, without the Gateway's English", async () => {
    const gw = fakeGateway({
      "threads.update": () => {
        throw Object.assign(new Error("Auto mode needs a model on the auto-mode allowlist."), {
          code: "forbidden",
          details: { reason: "auto_model_not_allowed" },
        });
      },
    });
    const store = new ShellStore(gw.port);
    await store.updateThread("t1", { permissionMode: "auto" }, UNSUPPORTED, {
      onSwitchModel: () => undefined,
    });
    const [toast] = store.getState().toasts;
    expect(toast?.text).toBe(
      "Auto works only on the listed models. Pick one in the model picker first.",
    );
    expect(toast?.action?.label).toBe("Switch model");
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

const msg = (id: string, threadId: string, text: string, seq = 1) => ({
  id,
  threadId,
  seq,
  role: "agent",
  createdAt: "2026-11-09T10:00:00.000Z",
  blocks: [{ type: "text", md: text }],
});
const entryOf = (id: string, title = "t") => ({
  thread: { id, kind: "side", title, permissionMode: "balanced", lastMessageAt: "x" },
  activity: { running: 0, awaitingInput: 0, awaitingApproval: 0 },
});

describe("ShellStore without messages (D7)", () => {
  const listed = () =>
    fakeGateway({
      "threads.list": () => ({ threads: [entryOf("t1")], nextCursor: null }),
      "approvals.list": () => ({ approvals: [] }),
      "notifications.list": () => ({ notifications: [], nextCursor: null }),
    });

  it("keeps no messages or streaming, but still moves the last line", async () => {
    const gw = listed();
    const store = new ShellStore(gw.port, { messages: false });
    store.start();
    gw.pair();
    await flush();
    gw.emit("chat.delta", { threadId: "t1", messageId: "m1", delta: "abc" });
    gw.emit("chat.message", { message: msg("m1", "t1", "done") });
    expect(store.getState().streaming).toEqual({});
    expect(store.getState().messages).toEqual({});
    expect(store.getState().threads[0]?.lastMessage?.text).toBe("done");
  });

  it("still stores them by default (positive control)", () => {
    const gw = listed();
    const store = new ShellStore(gw.port);
    store.start();
    gw.emit("chat.delta", { threadId: "t1", messageId: "m1", delta: "abc" });
    expect(store.getState().streaming.m1?.text).toBe("abc");
  });

  it("drops orphaned streaming text when its thread is cleared, deleted or resynced", async () => {
    const gw = listed();
    const store = new ShellStore(gw.port);
    store.start();
    gw.pair();
    await flush();
    for (const [i, ev] of ["thread.cleared", "thread.deleted"].entries()) {
      gw.emit("chat.delta", { threadId: "t1", messageId: `m${i}`, delta: "x" });
      gw.emit("chat.delta", { threadId: "other", messageId: `o${i}`, delta: "y" });
      gw.emit(ev, { threadId: "t1" });
      expect(Object.keys(store.getState().streaming)).toContain(`o${i}`);
      expect(Object.keys(store.getState().streaming)).not.toContain(`m${i}`);
    }
    await store.refresh();
    expect(store.getState().streaming).toEqual({});
  });
});

describe("ShellStore refetching (D11)", () => {
  const base = {
    "threads.list": () => ({ threads: [entryOf("t1"), entryOf("t2")], nextCursor: null }),
    "approvals.list": () => ({ approvals: [] }),
    "notifications.list": () => ({ notifications: [], nextCursor: null }),
  };

  it("patches the one thread after threads.update instead of refetching", async () => {
    const updated = { ...entryOf("t1").thread, permissionMode: "manual" };
    const gw = fakeGateway({ ...base, "threads.update": () => ({ thread: updated }) });
    const store = new ShellStore(gw.port);
    await store.refresh();
    const before = gw.calls.length;
    await expect(store.updateThread("t1", { permissionMode: "manual" }, "n/a")).resolves.toBe(true);
    await flush();
    expect(gw.calls.slice(before).map((c) => c[0])).toEqual(["threads.update"]);
    const threads = store.getState().threads;
    expect(threads.map((x) => x.thread.id)).toEqual(["t1", "t2"]);
    expect(threads[0]?.thread.permissionMode).toBe("manual");
  });

  it("pages threads.list on refresh", async () => {
    const gw = fakeGateway(base);
    await new ShellStore(gw.port).refresh();
    const list = gw.calls.find((c) => c[0] === "threads.list");
    expect((list?.[1] as { limit?: number } | undefined)?.limit).toBe(50);
  });
});
