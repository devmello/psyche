import { describe, expect, it } from "vitest";
import { refusedOpenFromRemote, viewHandlers } from "../src/compose/view.ts";
import type { Call, HandlerDef } from "../src/context.ts";

type Emitted = { event: string; payload: { commandId?: string; command: string; args: object } };

interface FakeConn {
  open: boolean;
  identity: { desktopShell?: true } | null;
  peer: { remoteLoopback: boolean };
}

/** A fake call: `desktop` is the desktop shell on this Mac; `others` are other live connections. */
function fakeCall(opts: { desktop: boolean; others?: FakeConn[]; emitted?: Emitted[] }): Call {
  const self: FakeConn = {
    open: true,
    identity: opts.desktop ? { desktopShell: true } : {},
    peer: { remoteLoopback: opts.desktop },
  };
  const conns = [self, ...(opts.others ?? [])];
  const emitted = opts.emitted ?? [];
  return {
    ctx: { connections: () => conns },
    conn: self,
    identity: self.identity,
    method: "",
    emit(event: string, payload: object) {
      emitted.push({ event, payload: payload as Emitted["payload"] });
    },
    afterCommit() {},
  } as unknown as Call;
}

function handlers(): Record<string, HandlerDef> {
  return viewHandlers();
}

function run(h: Record<string, HandlerDef>, method: string, call: Call, params: object): unknown {
  const def = h[method];
  if (def === undefined) throw new Error(`no handler ${method}`);
  return (def.run as (c: Call, p: object) => unknown)(call, params);
}

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? "error";
  }
}

describe("view.open", () => {
  it("publishes view.command with a fresh commandId and returns it", () => {
    const h = handlers();
    const emitted: Emitted[] = [];
    const call = fakeCall({ desktop: true, emitted });
    const res = run(h, "view.open", call, { pane: "browser" }) as { commandId: string };
    expect(res.commandId).toMatch(/^[0-9a-f-]{36}$/);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.event).toBe("view.command");
    expect(emitted[0]?.payload).toMatchObject({
      commandId: res.commandId,
      command: "open",
      args: { pane: "browser" },
    });
    const second = run(h, "view.open", call, { pane: "browser" }) as { commandId: string };
    expect(second.commandId).not.toBe(res.commandId);
  });

  it("forwards a machine target for the Watch button (computer-watch)", () => {
    const h = handlers();
    const emitted: Emitted[] = [];
    const call = fakeCall({ desktop: false, emitted, others: [desktopOf()] });
    run(h, "view.open", call, { pane: "computer-watch", target: "machine-1" });
    expect(emitted[0]?.payload.args).toEqual({ pane: "computer-watch", target: "machine-1" });
  });

  it("answers unavailable when no desktop shell is connected", () => {
    const h = handlers();
    const emitted: Emitted[] = [];
    const call = fakeCall({ desktop: false, emitted });
    expect(codeOf(() => run(h, "view.open", call, { pane: "browser" }))).toBe("unavailable");
    expect(emitted).toHaveLength(0);
  });

  it("ignores a closed desktop connection", () => {
    const h = handlers();
    const closed: FakeConn = {
      open: false,
      identity: { desktopShell: true },
      peer: { remoteLoopback: true },
    };
    const call = fakeCall({ desktop: false, others: [closed] });
    expect(codeOf(() => run(h, "view.open", call, { pane: "browser" }))).toBe("unavailable");
  });

  it("refuses terminal from a non-desktop client, even without a target", () => {
    const h = handlers();
    const emitted: Emitted[] = [];
    const call = fakeCall({ desktop: false, emitted, others: [desktopOf()] });
    expect(codeOf(() => run(h, "view.open", call, { pane: "terminal" }))).toBe("forbidden");
    expect(codeOf(() => run(h, "view.open", call, { pane: "terminal", target: "/" }))).toBe(
      "forbidden",
    );
    expect(emitted).toHaveLength(0);
  });

  it("refuses targets on browser, files, editor and diff from a non-desktop client", () => {
    const h = handlers();
    const call = fakeCall({ desktop: false, others: [desktopOf()] });
    for (const pane of ["browser", "files", "editor", "diff"]) {
      expect(codeOf(() => run(h, "view.open", call, { pane, target: "x" }))).toBe("forbidden");
    }
  });

  it("allows pane-only browser/files opens and targets on show-only panes from a non-desktop client", () => {
    const h = handlers();
    const call = fakeCall({ desktop: false, others: [desktopOf()] });
    expect(codeOf(() => run(h, "view.open", call, { pane: "browser" }))).toBeNull();
    expect(codeOf(() => run(h, "view.open", call, { pane: "files" }))).toBeNull();
    expect(codeOf(() => run(h, "view.open", call, { pane: "sidechat", target: "t1" }))).toBeNull();
  });

  it("lets the desktop shell open refused panes and targets itself", () => {
    const h = handlers();
    const call = fakeCall({ desktop: true });
    expect(codeOf(() => run(h, "view.open", call, { pane: "terminal", target: "/x" }))).toBeNull();
    expect(codeOf(() => run(h, "view.open", call, { pane: "files", target: "/x" }))).toBeNull();
  });
});

describe("refusedOpenFromRemote", () => {
  it("is a table of pane/target shapes, with near-misses allowed", () => {
    const cases: [object, boolean][] = [
      [{ pane: "terminal" }, true],
      [{ pane: "terminal", target: "/" }, true],
      [{ pane: "browser", target: "https://example.com" }, true],
      [{ pane: "files", target: "/etc" }, true],
      [{ pane: "editor", target: "/x" }, true],
      [{ pane: "diff", target: "/x" }, true],
      [{ pane: "browser" }, false],
      [{ pane: "files" }, false],
      [{ pane: "computer-watch", target: "machine-1" }, false],
      [{ pane: "sidechat", target: "thread-1" }, false],
      [{ pane: "artifact", artifactId: "a1" }, false],
    ];
    for (const [params, refused] of cases) {
      expect(refusedOpenFromRemote(params as never) !== null).toBe(refused);
    }
  });
});

describe("view.close and view.focus", () => {
  it("publish with a fresh commandId and answer ok", () => {
    const h = handlers();
    const emitted: Emitted[] = [];
    const call = fakeCall({ desktop: false, emitted, others: [desktopOf()] });
    expect(run(h, "view.close", call, { pane: "browser" })).toEqual({ ok: true });
    expect(run(h, "view.focus", call, { paneId: "p1" })).toEqual({ ok: true });
    expect(emitted.map((e) => e.payload.command)).toEqual(["close", "focus"]);
    expect(emitted.every((e) => typeof e.payload.commandId === "string")).toBe(true);
  });

  it("answer unavailable without a desktop", () => {
    const h = handlers();
    const call = fakeCall({ desktop: false });
    expect(codeOf(() => run(h, "view.close", call, { pane: "browser" }))).toBe("unavailable");
    expect(codeOf(() => run(h, "view.focus", call, { pane: "browser" }))).toBe("unavailable");
  });
});

describe("view.report and view.layout", () => {
  const layout = {
    panes: [
      {
        paneId: "chat",
        pane: "chat",
        placement: "main",
        threadId: null,
        target: null,
      },
    ],
    focusedPaneId: "chat",
    updatedAt: "2026-11-23T10:00:00.000Z",
  };

  it("refuses a report from a non-desktop client", () => {
    const h = handlers();
    const call = fakeCall({ desktop: false, others: [desktopOf()] });
    expect(codeOf(() => run(h, "view.report", call, { layout }))).toBe("forbidden");
  });

  it("round-trips the desktop's last layout, and returns null without a desktop", () => {
    const h = handlers();
    const desk = fakeCall({ desktop: true });
    expect(run(h, "view.report", desk, { layout })).toEqual({ ok: true });
    expect(run(h, "view.layout", fakeCall({ desktop: false, others: [desktopOf()] }), {})).toEqual({
      layout,
    });
    expect(run(h, "view.layout", fakeCall({ desktop: false }), {})).toEqual({ layout: null });
  });

  it("returns null before any report", () => {
    const h = handlers();
    expect(run(h, "view.layout", fakeCall({ desktop: true }), {})).toEqual({ layout: null });
  });
});

/** A caller with explicit identity and loopback flag, and other live connections. */
function callFrom(self: FakeConn, others: FakeConn[] = [], emitted: Emitted[] = []): Call {
  return {
    ctx: { connections: () => [self, ...others] },
    conn: self,
    identity: self.identity,
    method: "",
    emit(event: string, payload: object) {
      emitted.push({ event, payload: payload as Emitted["payload"] });
    },
    afterCommit() {},
  } as unknown as Call;
}

const phone: FakeConn = { open: true, identity: {}, peer: { remoteLoopback: false } };
const hostCli: FakeConn = { open: true, identity: {}, peer: { remoteLoopback: true } };
const nonLoopbackDesktop: FakeConn = {
  open: true,
  identity: { desktopShell: true },
  peer: { remoteLoopback: false },
};

const emptyLayout = {
  panes: [],
  focusedPaneId: null,
  updatedAt: "2026-11-23T10:00:00.000Z",
};

describe("reviewer probes: refusals from non-desktop callers (desktop connected)", () => {
  const h = handlers();
  const cases: [string, string, object, FakeConn][] = [
    ["phone opens terminal", "view.open", { pane: "terminal" }, phone],
    ["phone opens terminal with a target", "view.open", { pane: "terminal", target: "/" }, phone],
    [
      "phone opens browser with a url",
      "view.open",
      { pane: "browser", target: "https://x" },
      phone,
    ],
    ["phone opens files with /etc", "view.open", { pane: "files", target: "/etc" }, phone],
    ["phone opens files with an empty target", "view.open", { pane: "files", target: "" }, phone],
    ["phone opens editor with a path", "view.open", { pane: "editor", target: "/x" }, phone],
    ["phone opens diff with a path", "view.open", { pane: "diff", target: "/x" }, phone],
    ["host CLI (loopback, not desktop) opens terminal", "view.open", { pane: "terminal" }, hostCli],
    [
      "non-loopback desktopShell opens terminal",
      "view.open",
      { pane: "terminal" },
      nonLoopbackDesktop,
    ],
    [
      "non-loopback desktopShell opens files with a target",
      "view.open",
      { pane: "files", target: "/etc" },
      nonLoopbackDesktop,
    ],
    ["phone closes terminal", "view.close", { pane: "terminal" }, phone],
  ];
  for (const [name, method, params, self] of cases) {
    it(`refuses: ${name}`, () => {
      const call = callFrom(self, [desktopOf()]);
      expect(codeOf(() => run(h, method, call, params))).toBe("forbidden");
    });
  }

  it("refuses view.report from a non-loopback desktopShell caller", () => {
    const call = callFrom(nonLoopbackDesktop, [desktopOf()]);
    expect(codeOf(() => run(h, "view.report", call, { layout: emptyLayout }))).toBe("forbidden");
  });

  it("refuses view.close by paneId for a terminal pane the desktop reported", () => {
    const layout = {
      ...emptyLayout,
      panes: [
        { paneId: "t1", pane: "terminal", placement: "side", threadId: null, target: null },
        { paneId: "b1", pane: "browser", placement: "side", threadId: null, target: null },
      ],
    };
    const local = callFrom(
      { open: true, identity: { desktopShell: true }, peer: { remoteLoopback: true } },
      [],
      [],
    );
    expect(run(h, "view.report", local, { layout })).toEqual({ ok: true });
    const call = callFrom(phone, [desktopOf()]);
    expect(codeOf(() => run(h, "view.close", call, { paneId: "t1" }))).toBe("forbidden");
    expect(codeOf(() => run(h, "view.close", call, { paneId: "b1" }))).toBeNull();
    expect(codeOf(() => run(h, "view.close", call, { paneId: "unknown" }))).toBe("forbidden");
  });

  it("refuses a phone view.close by paneId when no layout was reported", () => {
    const h2 = handlers();
    const call = callFrom(phone, [desktopOf()]);
    expect(codeOf(() => run(h2, "view.close", call, { paneId: "b1" }))).toBe("forbidden");
  });
});

describe("reviewer probes: no desktop shell on loopback", () => {
  const h = handlers();
  it("open, close and focus answer unavailable when the only desktopShell is non-loopback", () => {
    const call = callFrom(nonLoopbackDesktop);
    expect(codeOf(() => run(h, "view.open", call, { pane: "chat" }))).toBe("unavailable");
    expect(codeOf(() => run(h, "view.close", call, { pane: "browser" }))).toBe("unavailable");
    expect(codeOf(() => run(h, "view.focus", call, { pane: "browser" }))).toBe("unavailable");
  });
});

describe("reviewer probes: allowed from non-desktop callers", () => {
  const h = handlers();
  const allowed: [string, object][] = [
    ["browser pane only", { pane: "browser" }],
    ["files pane only", { pane: "files" }],
    ["files with artifactId", { pane: "files", artifactId: "a1" }],
    ["files with taskId and threadId, no target", { pane: "files", taskId: "t1", threadId: "th1" }],
    ["computer-watch with a machine", { pane: "computer-watch", target: "m1" }],
    ["sidechat with a thread", { pane: "sidechat", target: "t1" }],
    ["artifact by artifactId", { pane: "artifact", artifactId: "a1" }],
    ["artifact by target", { pane: "artifact", target: "a1" }],
    ["vm", { pane: "vm" }],
    ["plan", { pane: "plan" }],
    ["tasks", { pane: "tasks" }],
    ["subagents", { pane: "subagents" }],
    ["chat", { pane: "chat" }],
  ];
  for (const [name, params] of allowed) {
    it(`allows: ${name}`, () => {
      const call = callFrom(phone, [desktopOf()]);
      expect(codeOf(() => run(h, "view.open", call, params))).toBeNull();
    });
  }
  it("allows a phone to close a non-terminal pane by name", () => {
    const call = callFrom(phone, [desktopOf()]);
    expect(codeOf(() => run(h, "view.close", call, { pane: "browser" }))).toBeNull();
  });
});

describe("reviewer probes: the desktop shell itself", () => {
  const h = handlers();
  it("opens terminal, files and browser with targets", () => {
    const call = callFrom(desktopOf(), []);
    expect(codeOf(() => run(h, "view.open", call, { pane: "terminal", target: "/x" }))).toBeNull();
    expect(codeOf(() => run(h, "view.open", call, { pane: "files", target: "/x" }))).toBeNull();
    expect(
      codeOf(() => run(h, "view.open", call, { pane: "browser", target: "https://x" })),
    ).toBeNull();
  });
  it("closes a terminal pane", () => {
    const call = callFrom(desktopOf(), []);
    expect(codeOf(() => run(h, "view.close", call, { pane: "terminal" }))).toBeNull();
  });
});

describe("view.layout after the desktop leaves", () => {
  it("returns the report while the desktop is connected, null after it leaves, and stays cleared", () => {
    const h = handlers();
    const layout = { ...emptyLayout, panes: [] };
    const desk = callFrom(desktopOf(), []);
    expect(run(h, "view.report", desk, { layout })).toEqual({ ok: true });
    expect(run(h, "view.layout", callFrom(phone, [desktopOf()]), {})).toEqual({ layout });
    // The desktop is gone: the layout is null, and it is cleared for a later reconnect.
    expect(run(h, "view.layout", callFrom(phone), {})).toEqual({ layout: null });
    expect(run(h, "view.layout", callFrom(phone, [desktopOf()]), {})).toEqual({ layout: null });
  });
});

/** A live desktop shell connection that is not the caller (the caller is a phone). */
function desktopOf(): FakeConn {
  return { open: true, identity: { desktopShell: true }, peer: { remoteLoopback: true } };
}
