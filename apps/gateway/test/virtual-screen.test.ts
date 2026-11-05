import { PsycheError, type VscreenCapability } from "@psyche/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createVirtualScreen,
  type UnsavedChangesCard,
  type VirtualScreenDeps,
  type VscreenInvokeOptions,
} from "../src/compose/virtual-screen.ts";

interface Call {
  capability: VscreenCapability;
  params: Record<string, unknown>;
  options: VscreenInvokeOptions;
}

const STATUS = {
  state: "running",
  display: ":90",
  width: 1280,
  height: 800,
  apps: [] as unknown[],
  takenOver: false,
  frameSeq: 3,
  startedAt: "2026-11-05T10:00:00.000Z",
};
const FRAME = { changed: true, frameSeq: 4, image: "AAAA", width: 1280, height: 800 };

function setup(handler?: (c: Call) => unknown, extra: Partial<VirtualScreenDeps> = {}) {
  const calls: Call[] = [];
  const parked: UnsavedChangesCard[] = [];
  let t = 0;
  const clock = {
    advance: (ms: number) => {
      t += ms;
    },
  };
  const vs = createVirtualScreen({
    async invoke(capability, params, options) {
      const call = { capability, params, options };
      calls.push(call);
      const out = handler?.(call);
      if (out instanceof Error) throw out;
      if (out !== undefined) return out;
      if (capability === "vscreen.status" || capability === "vscreen.start") return STATUS;
      if (capability === "vscreen.frame") return FRAME;
      return { ok: true };
    },
    park: (card) => void parked.push(card),
    now: () => t,
    takeOverWaitMs: 1000,
    ...extra,
  });
  return { vs, calls, parked, clock };
}

const code = async (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => "no error",
    (e: unknown) => PsycheError.from(e).code,
  );

describe("virtual screen helper calls", () => {
  it("maps each call to its capability with the right side effect and target", async () => {
    const { vs, calls } = setup();
    await vs.start({ width: 1280, height: 800 });
    await vs.status();
    await vs.frame({ since: 1, maxWidth: 800 });
    await vs.input([{ type: "text", text: "hi" }]);
    await vs.stop({ closeApps: true });
    expect(calls.map((c) => [c.capability, c.options.sideEffect, c.options.target])).toEqual([
      ["vscreen.start", "write", "vscreen"],
      ["vscreen.status", "none", "vscreen"],
      ["vscreen.frame", "read", "vscreen"],
      ["vscreen.input", "write", "vscreen"],
      ["vscreen.stop", "write", "vscreen"],
    ]);
    expect(calls[2]?.params).toEqual({ since: 1, maxWidth: 800 });
  });

  it("rejects bad shapes before calling the helper", async () => {
    const { vs, calls } = setup();
    expect(await code(vs.start({ width: 10 }))).toBe("invalid_params");
    expect(await code(vs.frame({ maxWidth: "wide" }))).toBe("invalid_params");
    expect(await code(vs.input([{ type: "nope" }]))).toBe("invalid_params");
    expect(await code(vs.stop({ closeApps: "yes" }))).toBe("invalid_params");
    expect(calls).toHaveLength(0);
  });

  it("rejects a helper answer of the wrong shape", async () => {
    const { vs } = setup(() => ({ nonsense: true }));
    expect(await code(vs.status())).toBe("internal");
  });

  it("passes helper reason codes through untouched", async () => {
    const err = new PsycheError("conflict", "open elsewhere", {
      details: { reason: "opened_elsewhere" },
    });
    const { vs } = setup(() => err);
    const caught = await vs.start().catch((e: unknown) => e);
    expect(caught).toBe(err);
    expect((caught as PsycheError).details).toEqual({ reason: "opened_elsewhere" });
  });
});

describe("endTask and parking", () => {
  const dirty = {
    appId: "org.gnome.TextEditor",
    pid: 42,
    windowTitle: "notes",
    hasUnsavedChanges: true,
  };
  const clean = { appId: "firefox", pid: 43, windowTitle: null };

  it("stops cleanly when the helper agrees", async () => {
    const { vs, calls, parked } = setup();
    expect(await vs.endTask()).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toEqual({ closeApps: true });
    expect(parked).toHaveLength(0);
  });

  it("parks the Task with only the apps that have unsaved changes", async () => {
    const { vs, parked, calls } = setup((c) =>
      c.capability === "vscreen.stop"
        ? { ok: false }
        : c.capability === "vscreen.status"
          ? { ...STATUS, apps: [dirty, clean] }
          : undefined,
    );
    const res = await vs.endTask({ closeApps: true });
    const card = {
      kind: "unsaved_changes",
      apps: [dirty],
      actions: ["look", "discard", "keep_open"],
    };
    expect(res).toEqual({ ok: false, parked: card });
    expect(parked).toEqual([card]);
    expect(vs.parkedCard()).toEqual(card);
    expect(calls.map((c) => c.capability)).toEqual(["vscreen.stop", "vscreen.status"]);
  });

  it("fails (does not park) when the stop is refused with nothing unsaved", async () => {
    const { vs, parked } = setup((c) =>
      c.capability === "vscreen.stop" ? { ok: false } : undefined,
    );
    expect(await code(vs.endTask())).toBe("conflict");
    expect(parked).toHaveLength(0);
  });

  function parkedSetup() {
    return setup((c) =>
      c.capability === "vscreen.stop" && c.params.force !== true
        ? { ok: false }
        : c.capability === "vscreen.status"
          ? { ...STATUS, apps: [dirty] }
          : undefined,
    );
  }

  it("look returns the watch view and keeps the card", async () => {
    const { vs, calls } = parkedSetup();
    await vs.endTask();
    expect(await vs.resolveParked("look")).toEqual({ action: "look", view: "computer-watch" });
    expect(vs.parkedCard()).not.toBeNull();
    expect(calls.filter((c) => c.capability === "vscreen.stop")).toHaveLength(1);
  });

  it("discard force-stops and clears the card", async () => {
    const { vs, calls } = parkedSetup();
    await vs.endTask();
    expect(await vs.resolveParked("discard")).toEqual({ action: "discard" });
    expect(calls.at(-1)?.capability).toBe("vscreen.stop");
    expect(calls.at(-1)?.params).toEqual({ closeApps: true, force: true });
    expect(vs.parkedCard()).toBeNull();
  });

  it("keep_open leaves the screen running and clears the card", async () => {
    const { vs, calls } = parkedSetup();
    await vs.endTask();
    const before = calls.length;
    expect(await vs.resolveParked("keep_open")).toEqual({ action: "keep_open" });
    expect(calls).toHaveLength(before);
    expect(vs.parkedCard()).toBeNull();
  });

  it("refuses to resolve when nothing is parked or the action is unknown", async () => {
    const { vs } = parkedSetup();
    expect(await code(vs.resolveParked("look"))).toBe("conflict");
    await vs.endTask();
    expect(await code(vs.resolveParked("explode" as never))).toBe("invalid_params");
  });
});

describe("take-over", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("holds agent calls until released, but never owner input", async () => {
    const { vs, calls } = setup();
    vs.setTakenOver(true);
    const pending = vs.status();
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toHaveLength(0);
    await vs.input([{ type: "move", x: 1, y: 2 }], { actor: "owner" });
    expect(calls.map((c) => c.capability)).toEqual(["vscreen.input"]);
    vs.setTakenOver(false);
    await pending;
    expect(calls.map((c) => c.capability)).toEqual(["vscreen.input", "vscreen.status"]);
  });

  it("fails with a retryable error after the bounded wait", async () => {
    const { vs } = setup();
    vs.setTakenOver(true);
    const caught = vs.agentGate().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1001);
    const err = (await caught) as PsycheError;
    expect(err.code).toBe("user_in_control");
    expect(err.retryable).toBe(true);
  });

  it("resolves at once when not taken over and honours abort", async () => {
    const { vs } = setup();
    await vs.agentGate();
    vs.setTakenOver(true);
    const ac = new AbortController();
    const caught = vs.agentGate(ac.signal).catch((e: unknown) => e);
    ac.abort();
    expect(((await caught) as PsycheError).code).toBe("cancelled");
  });
});

describe("watch pane frame limiter", () => {
  it("only serves a visible pane", async () => {
    const { vs, calls } = setup();
    expect(await code(vs.frame({}, { actor: "owner" }))).toBe("unavailable");
    vs.setPaneVisible(true);
    await vs.frame({}, { actor: "owner" });
    expect(calls).toHaveLength(1);
    vs.setPaneVisible(false);
    expect(await code(vs.frame({}, { actor: "owner" }))).toBe("unavailable");
  });

  it("allows 4 a second per caller, then rate limits", async () => {
    const { vs, clock } = setup();
    vs.setPaneVisible(true);
    for (let i = 0; i < 4; i++) await vs.frame({}, { actor: "owner" });
    expect(await code(vs.frame({}, { actor: "owner" }))).toBe("rate_limited");
    // Another caller has its own budget.
    await vs.frame({}, { actor: "owner", caller: "second" });
    clock.advance(1001);
    await vs.frame({}, { actor: "owner" });
  });

  it("does not limit the agent's own frames", async () => {
    const { vs } = setup();
    for (let i = 0; i < 10; i++) await vs.frame({});
  });
});
