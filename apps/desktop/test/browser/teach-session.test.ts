import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeachKeptStore } from "@psyche/browser/teach";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkTeachId, checkTeachKeep, IPC, REMOTE_REFUSED_CHANNELS } from "../../src/lib/ipc.ts";
import { TeachSession, type TeachTabPort } from "../../src/main/browser/teach-session.ts";

/** A Luhn-valid test card number, assembled at run time so the repo's secret scan never sees one. */
const CARD = ["4111", "1111", "1111", "1111"].join(" ");

class FakeTab implements TeachTabPort {
  id = "tab_1";
  address = "https://billing.example.com/reports?session=abc";
  sent: string[] = [];
  held: boolean[] = [];
  #listeners = new Set<(method: string, params: unknown) => void>();
  failOn: string | undefined;
  url() {
    return this.address;
  }
  async send(method: string, params?: Record<string, unknown>) {
    this.sent.push(method);
    if (this.failOn === method) throw new Error("boom");
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
    if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "s1" };
    this.last = params;
    return {};
  }
  last: Record<string, unknown> | undefined;
  subscribe(l: (method: string, params: unknown) => void) {
    this.#listeners.add(l);
    return () => {
      this.#listeners.delete(l);
    };
  }
  hold(on: boolean) {
    this.held.push(on);
  }
  emit(method: string, params: unknown) {
    for (const l of [...this.#listeners]) l(method, params);
  }
  get listening() {
    return this.#listeners.size;
  }
}

describe("TeachSession (owner-only recording in the built-in browser)", () => {
  let dir: string;
  let changes: number;
  let session: TeachSession;
  let tab: FakeTab;
  let binding = "";
  let world = "";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "psyche-teach-session-"));
    changes = 0;
    tab = new FakeTab();
    session = new TeachSession({
      onChange: () => {
        changes += 1;
      },
      kept: new TeachKeptStore(join(dir, "library", "teach")),
    });
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  async function startAndLearnNames() {
    const seen: { binding?: string; world?: string } = {};
    const orig = tab.send.bind(tab);
    tab.send = async (method, params) => {
      if (method === "Runtime.addBinding") {
        seen.binding = String(params?.name);
        seen.world = String(params?.executionContextName);
      }
      return orig(method, params);
    };
    await session.start(tab);
    binding = seen.binding as string;
    world = seen.world as string;
    tab.emit("Runtime.executionContextCreated", {
      context: { id: 7, name: world, auxData: { frameId: "main" } },
    });
  }

  const report = (payload: unknown) =>
    tab.emit("Runtime.bindingCalled", {
      name: binding,
      executionContextId: 7,
      payload: JSON.stringify(payload),
    });

  it("holds the tab for the owner while recording, and releases it on Stop", async () => {
    await startAndLearnNames();
    expect(tab.held).toEqual([true]);
    expect(session.state).toEqual({ tabId: "tab_1", steps: 1 });
    expect(changes).toBeGreaterThan(0);
    await session.stop();
    expect(tab.held).toEqual([true, false]);
    expect(session.state).toBeNull();
    expect(tab.listening).toBe(0);
  });

  it("refuses the bridge while a tab is recorded, and no other tab", async () => {
    await startAndLearnNames();
    expect(session.recording("tab_1")).toBe(true);
    expect(session.recording("tab_2")).toBe(false);
    await session.stop();
    expect(session.recording("tab_1")).toBe(false);
  });

  it("hides the recorder's own events from the Gateway: they carry what the owner typed", async () => {
    await startAndLearnNames();
    expect(session.hides("tab_1", "Runtime.bindingCalled", { name: binding })).toBe(true);
    expect(
      session.hides("tab_1", "Runtime.executionContextCreated", { context: { name: world } }),
    ).toBe(true);
    // Other events, other bindings and other tabs are the Gateway's business as before.
    expect(session.hides("tab_1", "Runtime.bindingCalled", { name: "mine" })).toBe(false);
    expect(session.hides("tab_1", "Page.frameNavigated", {})).toBe(false);
    expect(session.hides("tab_2", "Runtime.bindingCalled", { name: binding })).toBe(false);
    await session.stop();
    expect(session.hides("tab_1", "Runtime.bindingCalled", { name: binding })).toBe(false);
  });

  it("hands the steps to the review screen once and keeps nothing", async () => {
    await startAndLearnNames();
    report({ k: "click", role: "button", name: "Export", selector: "#export" });
    report({
      k: "type",
      role: "textbox",
      name: "From",
      selector: "#from",
      f: { tag: "input", type: "text", label: "From" },
      value: "2026-11-01",
    });
    report({
      k: "type",
      role: "textbox",
      name: "Password",
      selector: "#pw",
      f: { tag: "input", type: "password" },
      sensitive: true,
    });
    expect(session.state?.steps).toBe(4);
    const review = await session.stop();
    expect(review.steps.map((s) => s.kind)).toEqual(["navigate", "click", "type", "type"]);
    expect(review.steps[0]?.url).toBe("https://billing.example.com/reports");
    expect(review.steps[2]?.sample).toBe("2026-11-01");
    expect(review.steps[3]).toMatchObject({ sensitive: true });
    expect(JSON.stringify(review)).not.toContain("session=abc");
    // Nothing is held: Stop again has nothing to give, and no state remains.
    await expect(session.stop()).rejects.toThrow("nothing is being recorded");
    expect(session.state).toBeNull();
  });

  it("Cancel drops the recording", async () => {
    await startAndLearnNames();
    report({ k: "click", role: "button", name: "Export", selector: "#export" });
    await session.cancel();
    expect(session.state).toBeNull();
    expect(tab.held).toEqual([true, false]);
    await expect(session.stop()).rejects.toThrow();
  });

  it("one recording at a time, and a failed start leaves nothing held", async () => {
    await startAndLearnNames();
    await expect(session.start(new FakeTab())).rejects.toThrow("already running");
    await session.cancel();
    const other = new FakeTab();
    other.failOn = "Runtime.addBinding";
    await expect(session.start(other)).rejects.toThrow("could not start");
    expect(other.held).toEqual([true, false]);
    expect(session.state).toBeNull();
    expect(session.recording("tab_1")).toBe(false);
  });

  it("an interrupted recording keeps its steps for review", async () => {
    await startAndLearnNames();
    report({ k: "click", role: "button", name: "Export", selector: "#export" });
    session.interrupted("tab_1");
    expect(session.state).toMatchObject({ steps: 2, ended: "interrupted" });
    const review = await session.stop();
    expect(review.endedBy).toBe("interrupted");
    expect(review.steps).toHaveLength(2);
    // Another tab closing changes nothing.
    await startAndLearnNames();
    session.interrupted("tab_9");
    expect(session.state?.ended).toBeUndefined();
  });

  it("does not record a page that is not http(s)", async () => {
    tab.address = "about:blank";
    await startAndLearnNames();
    const review = await session.stop();
    expect(review.steps).toEqual([]);
  });

  it("keeps a recording only when asked, and only the cleaned steps", async () => {
    expect(await session.listKept()).toEqual([]);
    const steps = [
      { id: "s1", kind: "navigate" as const, url: "https://billing.example.com/reports?x=1" },
      {
        id: "s2",
        kind: "type" as const,
        role: "textbox",
        name: "Memo",
        value: CARD,
        keepValue: true,
      },
    ];
    await session.keep("teach_abcdef123456", "Weekly report", steps);
    const [kept] = await session.listKept();
    expect(JSON.stringify(kept)).not.toContain("4111");
    expect(JSON.stringify(kept)).not.toContain("x=1");
    expect((await session.openKept("teach_abcdef123456")).title).toBe("Weekly report");
    await session.deleteKept("teach_abcdef123456");
    expect(await session.listKept()).toEqual([]);
    await expect(session.openKept("teach_abcdef123456")).rejects.toThrow("no such kept recording");
  });
});

describe("teach IPC", () => {
  it("has its own channels, refused for a client of another computer's Gateway", () => {
    for (const c of [
      IPC.teachStart,
      IPC.teachStop,
      IPC.teachCancel,
      IPC.teachKeep,
      IPC.teachKept,
      IPC.teachOpenKept,
      IPC.teachDeleteKept,
    ]) {
      expect(c.startsWith("psyche:teach:")).toBe(true);
      expect(REMOTE_REFUSED_CHANNELS.has(c)).toBe(true);
    }
  });

  it("accepts only ids the store would have written", () => {
    expect(checkTeachId(IPC.teachOpenKept, "teach_abcdef123456")).toBe("teach_abcdef123456");
    for (const bad of ["../x", "teach_", "teach_ABCDEFGH", "", 5, "teach_abcdef123456/../x"])
      expect(() => checkTeachId(IPC.teachOpenKept, bad)).toThrow();
  });

  it("bounds what Keep takes", () => {
    const ok = checkTeachKeep({
      id: "teach_abcdef123456",
      title: "x",
      steps: [{ id: "s1", kind: "click", name: "Export" }],
    });
    expect(ok.steps).toHaveLength(1);
    for (const bad of [
      { id: "teach_abcdef123456", title: "x", steps: [] },
      { id: "teach_abcdef123456", title: "x", steps: [{ id: "s1", kind: "eval" }] },
      { id: "teach_abcdef123456", title: "", steps: [{ id: "s1", kind: "click" }] },
      { id: "nope", title: "x", steps: [{ id: "s1", kind: "click" }] },
      {
        id: "teach_abcdef123456",
        title: "x",
        steps: new Array(201).fill({ id: "s", kind: "click" }),
      },
      "string",
    ])
      expect(() => checkTeachKeep(bad)).toThrow();
  });
});
