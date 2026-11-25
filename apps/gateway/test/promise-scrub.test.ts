import { openDb, type PsycheDb } from "@psyche/db";
import { createGraphHandlers, createLoopVisibility, GraphStore } from "@psyche/memory";
import type { DeviceToast } from "@psyche/notifications";
import {
  type GraphLoop,
  type MethodParams,
  type PromiseSummary,
  type PromiseView,
  PsycheError,
} from "@psyche/protocol";
import { FakeClock } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeviceNotifications } from "../src/compose/device-notify.ts";
import { withLoopViewer } from "../src/compose/people.ts";
import type { Call, HandlerDef } from "../src/context.ts";
import { EventBus, SKIP_EVENT } from "../src/event-bus.ts";
import { settingsHandlers } from "../src/handlers/settings.ts";
import { readerOf } from "../src/message-scrub.ts";
import {
  isPromiseSourceKey,
  type PromiseService,
  personalizeLoopEvent,
  personalizePromiseEvent,
  promiseHandlers,
  scrubDeviceToast,
  viewerOfCall,
} from "../src/promise-scrub.ts";

/**
 * The promise scrub (docs/design/promise-ledger-2026.md section 7.2): every method, event and
 * notification, for every viewer, over every source mix, on a real migrated SQLite database.
 *
 * The desktop shell is the only full viewer. A remote desktop, an iPhone, the web shell, a caller
 * that sends a `desktopShell` param and a connection that claims the shell from a non-loopback
 * peer are all remote.
 */

const QUOTE = "I will send you the deck by Friday";
const NAME = "Sam Lee";
const NOW = "2026-11-24T10:00:00.000Z";

interface Mix {
  kind: "mail" | "messages" | "meeting" | "chat" | null;
  visible: 0 | 1;
  cites: string[];
  /** What a remote viewer should get. */
  remote: boolean;
}

/** Each way a promise can be sourced. `mixed` says visible on the row but cites Messages. */
const MIXES: Record<string, Mix> = {
  mail: { kind: "mail", visible: 1, cites: ["mail"], remote: true },
  messages: { kind: "messages", visible: 0, cites: ["messages"], remote: false },
  mixed: { kind: "mail", visible: 1, cites: ["mail", "messages"], remote: false },
  meeting: { kind: "meeting", visible: 1, cites: ["transcripts"], remote: true },
  chat: { kind: "chat", visible: 1, cites: ["chats"], remote: true },
  // The migration default: remote_visible is 0 until the ledger sets it, so it is hidden.
  unset: { kind: "mail", visible: 0, cites: ["mail"], remote: false },
};

interface ViewerDef {
  shell: boolean;
  loopback: boolean;
  /** The identity says desktopShell. */
  claimsShell?: boolean;
  /** Params that try to claim the shell. */
  paramSpoof?: boolean;
  full: boolean;
}

const VIEWERS: Record<string, ViewerDef> = {
  "desktop shell": { shell: true, loopback: true, full: true, claimsShell: true },
  "remote desktop": { shell: false, loopback: false, full: false },
  iOS: { shell: false, loopback: false, full: false },
  web: { shell: false, loopback: true, full: false },
  "spoofed desktopShell param": { shell: false, loopback: true, full: false, paramSpoof: true },
  "shell identity from a non-loopback peer": {
    shell: true,
    loopback: false,
    claimsShell: true,
    full: false,
  },
};

let db: PsycheDb;
let g: GraphStore;
const ids: Record<string, string> = {};

function citation(loopId: string, source: string, n: number): void {
  db.sqlite
    .prepare(
      `INSERT INTO graph_citations (id, target_kind, target_id, source, source_ref, quote, start, "end",
         source_hash, provenance, observed_at, created_at)
       VALUES (?, 'loop', ?, ?, 'ref', ?, 0, 5, 'h', 'untrusted', ?, ?)`,
    )
    .run(`cit_${n}`, loopId, source, QUOTE, NOW, NOW);
}

let sam = "";

beforeEach(() => {
  db = openDb(":memory:");
  g = new GraphStore({ sqlite: db.sqlite, clock: new FakeClock() });
  sam = g.createEntity({ kind: "person", name: NAME, linkedBy: "rule", source: "mail" }).id;
  let n = 0;
  for (const [name, mix] of Object.entries(MIXES)) {
    n += 1;
    const loop = g.addLoop({
      direction: "i_owe",
      text: `Send the deck ${name}`,
      evidence: QUOTE,
      counterpartId: sam,
      status: "open",
      provenance: "owner",
      detectedBy: "owner",
    });
    if (loop === undefined) throw new Error("loop not added");
    ids[name] = loop.id;
    db.sqlite
      .prepare("UPDATE graph_loops SET source_kind = ?, remote_visible = ? WHERE id = ?")
      .run(mix.kind, mix.visible, loop.id);
    for (const c of mix.cites) citation(loop.id, c, n * 10 + mix.cites.indexOf(c));
  }
});
afterEach(() => db.close());

const vis = () => createLoopVisibility(db.sqlite);

function view(name: string, full: boolean): PromiseView {
  const mix = MIXES[name] as Mix;
  const id = ids[name] as string;
  return {
    id,
    direction: "i_owe",
    what: `Send the deck ${name}`,
    status: "open",
    state: "open",
    basis: "promise",
    whatAction: "send",
    counterpartLabel: NAME,
    counterpartId: sam,
    projectId: "proj_1",
    dueAt: "2026-11-27T17:00:00.000Z",
    dueText: "by Friday",
    dueKind: "explicit",
    dueConfidence: 0.9,
    proposedDueAt: null,
    snoozedUntil: null,
    brokenAt: null,
    warnedAt: null,
    nudgeCount: 0,
    lastNudgeAt: null,
    sourceKind: mix.kind,
    link: mix.kind === "mail" ? "message://%3Cm1%40acme.com%3E" : "/memory/people/sam",
    provenance: "owner",
    confidence: 0.9,
    createdAt: NOW,
    closedAt: null,
    closedBy: null,
    ...(full
      ? {
          citations: [
            {
              id: "c1",
              source: "mail" as const,
              quote: QUOTE,
              sourceRef: "ref",
              observedAt: NOW,
              provenance: "untrusted" as const,
            },
          ],
          events: [
            {
              id: "e1",
              at: NOW,
              kind: "created" as const,
              from: null,
              to: null,
              by: "model" as const,
              citationId: "c1",
            },
          ],
        }
      : {}),
  };
}

/** A service over the table. `honest` filters for a remote audience; `leaky` ignores it. */
function fakeService(honest: boolean) {
  const calls: string[] = [];
  const all = Object.keys(MIXES);
  const svc: PromiseService = {
    list(_p, audience) {
      const shown =
        honest && audience === "remote" ? all.filter((n) => (MIXES[n] as Mix).remote) : all;
      return {
        promises: shown.map((n) => view(n, audience === "full")),
        hiddenCount: honest && audience === "remote" ? all.length - shown.length : 0,
        nextCursor: null,
      };
    },
    get(id, audience) {
      const name = all.find((n) => ids[n] === id);
      if (name === undefined) throw new PsycheError("not_found", "no such promise");
      return view(name, audience === "full");
    },
    summary(audience): PromiseSummary {
      const shown =
        honest && audience === "remote" ? all.filter((n) => (MIXES[n] as Mix).remote) : all;
      return {
        enabled: true,
        yours: shown.length,
        theirs: 0,
        toConfirm: 0,
        dueSoon: shown.length,
        missed: 0,
        late: 0,
        nextDueAt: "2026-11-27T17:00:00.000Z",
        hiddenCount: honest && audience === "remote" ? all.length - shown.length : 0,
        upcoming: shown.map((n) => ({
          id: ids[n] as string,
          warnAt: "2026-11-26T16:00:00.000Z",
          title: `Send the deck ${n}`,
        })),
      };
    },
    act(p) {
      calls.push(`act:${p.id}`);
      return svc.get(p.id, "full") as PromiseView;
    },
    add(p) {
      calls.push("add");
      return { ...view("mail", true), what: p.what, sourceKind: "manual" };
    },
    delete(p) {
      calls.push(`delete:${p.id}`);
      return { ok: true };
    },
    mute() {
      calls.push("mute");
      return { ok: true };
    },
  };
  return { svc, calls };
}

function callOf(v: ViewerDef, method: string): Call {
  return {
    method,
    identity: {
      deviceId: "dev_1",
      role: "client",
      scopes: ["operator.read", "operator.write", "operator.admin"],
      ...(v.claimsShell ? { desktopShell: true } : {}),
    },
    conn: { peer: { remoteLoopback: v.loopback } },
    ctx: {},
    emit() {},
    afterCommit() {},
  } as unknown as Call;
}

const paramsOf = (v: ViewerDef, p: object): object =>
  v.paramSpoof ? { ...p, desktopShell: true, local: true, full: true } : p;

async function run<T>(
  handlers: Record<string, HandlerDef>,
  v: ViewerDef,
  method: string,
  params: object = {},
): Promise<{ ok: true; value: T } | { ok: false; code: string; reason?: string }> {
  try {
    const def = handlers[method] as HandlerDef;
    return {
      ok: true,
      value: (await def.run(callOf(v, method), paramsOf(v, params) as never)) as T,
    };
  } catch (err) {
    const e = PsycheError.from(err);
    return {
      ok: false,
      code: e.code,
      reason: (e.details as { reason?: string } | undefined)?.reason,
    };
  }
}

const leaks = (value: unknown): string[] => {
  const s = JSON.stringify(value);
  return [QUOTE, "citations", "events", "proj_1", sam, "/memory/"].filter((x) => s.includes(x));
};

const viewerNames = Object.keys(VIEWERS);
const mixNames = Object.keys(MIXES);
const cross = viewerNames.flatMap((v) => mixNames.map((m) => [v, m] as const));

describe.each([true, false])("promises.* handlers (service honours the audience: %s)", (honest) => {
  const setup = () => {
    const { svc, calls } = fakeService(honest);
    return { handlers: promiseHandlers(svc, vis()), calls };
  };

  it.each(viewerNames)("promises.list for %s", async (vn) => {
    const v = VIEWERS[vn] as ViewerDef;
    const { handlers } = setup();
    const r = await run<{ promises: PromiseView[]; hiddenCount: number }>(
      handlers,
      v,
      "promises.list",
      { view: "all" },
    );
    if (!r.ok) throw new Error(r.code);
    const got = r.value.promises.map((p) => p.id).sort();
    const want = mixNames
      .filter((m) => v.full || (MIXES[m] as Mix).remote)
      .map((m) => ids[m] as string)
      .sort();
    expect(got).toEqual(want);
    expect(r.value.hiddenCount).toBe(v.full ? 0 : mixNames.length - want.length);
    if (v.full) {
      // Positive control: the desktop shell sees the quote.
      expect(JSON.stringify(r.value)).toContain(QUOTE);
      expect(r.value.promises.find((p) => p.id === ids.mail)?.counterpartId).toBe(sam);
    } else {
      expect(leaks(r.value)).toEqual([]);
      // Positive control: a remote viewer sees a mail promise, with the name as written.
      const mail = r.value.promises.find((p) => p.id === ids.mail);
      expect(mail).toMatchObject({ what: "Send the deck mail", counterpartLabel: NAME });
      expect(mail?.link).toBe("message://%3Cm1%40acme.com%3E");
    }
  });

  it.each(cross)("promises.get for %s, %s source", async (vn, mn) => {
    const v = VIEWERS[vn] as ViewerDef;
    const mix = MIXES[mn] as Mix;
    const { handlers } = setup();
    const r = await run<{ promise: PromiseView }>(handlers, v, "promises.get", {
      id: ids[mn],
    });
    if (v.full || mix.remote) {
      if (!r.ok) throw new Error(r.code);
      expect(r.value.promise.id).toBe(ids[mn]);
      expect(JSON.stringify(r.value).includes(QUOTE)).toBe(v.full);
      if (!v.full) expect(leaks(r.value)).toEqual([]);
    } else {
      expect(r).toMatchObject({ ok: false, code: "not_found" });
    }
  });

  it("get on an id that does not exist answers like a hidden one", async () => {
    const { handlers } = setup();
    const a = await run(handlers, VIEWERS.iOS as ViewerDef, "promises.get", { id: "nope" });
    const b = await run(handlers, VIEWERS.iOS as ViewerDef, "promises.get", {
      id: ids.messages,
    });
    expect(a).toEqual(b);
  });

  it.each(cross)("promises.act for %s, %s source", async (vn, mn) => {
    const v = VIEWERS[vn] as ViewerDef;
    const mix = MIXES[mn] as Mix;
    const { handlers, calls } = setup();
    const r = await run<{ promise: PromiseView }>(handlers, v, "promises.act", {
      id: ids[mn],
      action: { type: "done" },
    });
    if (v.full || mix.remote) {
      if (!r.ok) throw new Error(r.code);
      expect(calls).toEqual([`act:${ids[mn]}`]);
      if (!v.full) expect(leaks(r.value)).toEqual([]);
    } else {
      // Refused before the service is called: a hidden promise is not acted on.
      expect(r).toMatchObject({ ok: false, code: "not_found" });
      expect(calls).toEqual([]);
    }
  });

  it("act on an id the table has no row for refuses a remote viewer", async () => {
    const { handlers, calls } = setup();
    const r = await run(handlers, VIEWERS.iOS as ViewerDef, "promises.act", {
      id: "loop_missing",
      action: { type: "done" },
    });
    expect(r).toMatchObject({ ok: false, code: "not_found" });
    expect(calls).toEqual([]);
  });

  it.each(viewerNames)("promises.summary and upcoming for %s", async (vn) => {
    const v = VIEWERS[vn] as ViewerDef;
    const { handlers } = setup();
    const r = await run<{ summary: PromiseSummary }>(handlers, v, "promises.summary");
    if (!r.ok) throw new Error(r.code);
    const got = r.value.summary.upcoming.map((u) => u.id).sort();
    const want = mixNames
      .filter((m) => v.full || (MIXES[m] as Mix).remote)
      .map((m) => ids[m] as string)
      .sort();
    expect(got).toEqual(want);
    if (!v.full) {
      expect(r.value.summary.hiddenCount).toBe(mixNames.length - want.length);
      expect(JSON.stringify(r.value)).not.toContain("Send the deck messages");
    } else {
      expect(JSON.stringify(r.value)).toContain("Send the deck messages");
    }
  });

  it.each(["promises.delete", "promises.mute"])("%s is desktop shell only", async (method) => {
    for (const vn of viewerNames) {
      const v = VIEWERS[vn] as ViewerDef;
      const { handlers, calls } = setup();
      const params =
        method === "promises.delete" ? { id: ids.mail } : { entityId: sam, muted: true };
      const r = await run(handlers, v, method, params);
      if (v.full) {
        expect(r).toMatchObject({ ok: true });
        expect(calls).toHaveLength(1);
      } else {
        expect(r).toMatchObject({ ok: false, code: "forbidden", reason: "owner_only" });
        expect(calls).toEqual([]);
      }
    }
  });

  it("promises.add answers a remote caller without Memory links", async () => {
    const { handlers } = setup();
    const r = await run<{ promise: PromiseView }>(
      handlers,
      VIEWERS.iOS as ViewerDef,
      "promises.add",
      { direction: "i_owe", what: "Call Sam" },
    );
    if (!r.ok) throw new Error(r.code);
    expect(r.value.promise.what).toBe("Call Sam");
    expect(leaks(r.value)).toEqual([]);
  });
});

describe("who is the desktop shell", () => {
  it.each(viewerNames)("%s", (vn) => {
    const v = VIEWERS[vn] as ViewerDef;
    expect(viewerOfCall(callOf(v, "x")).full).toBe(v.full);
  });

  it("a node connection is never the shell", () => {
    const call = callOf(VIEWERS["desktop shell"] as ViewerDef, "x");
    (call.identity as { role: string }).role = "node";
    expect(viewerOfCall(call).full).toBe(false);
  });
});

describe("a link a remote viewer gets", () => {
  it.each([
    ["message://%3Cm1%40acme.com%3E", true],
    ["https://mail.example.com/t/1", true],
    ["/memory/people/sam", false],
    ["psyche://memory/people/sam", false],
    ["javascript:alert(1)", false],
  ])("%s", async (link, kept) => {
    const { svc } = fakeService(true);
    const orig = svc.get;
    svc.get = (id, a) => ({ ...(orig(id, a) as PromiseView), link });
    const r = await run<{ promise: PromiseView }>(
      promiseHandlers(svc, vis()),
      VIEWERS.iOS as ViewerDef,
      "promises.get",
      { id: ids.mail },
    );
    if (!r.ok) throw new Error(r.code);
    expect(r.value.promise.link).toBe(kept ? link : undefined);
  });
});

describe("memory.loops.* by viewer, through the Gateway's mount", () => {
  const mounted = () => {
    const base = createGraphHandlers(g, { loopVisibility: vis() });
    const m: Record<string, HandlerDef> = {};
    for (const [n, fn] of Object.entries(base)) {
      m[n] = { run: (_c: Call, p: never) => (fn as (p: never) => Promise<unknown>)(p) };
    }
    return withLoopViewer(m, base);
  };

  it.each(viewerNames)("list for %s", async (vn) => {
    const v = VIEWERS[vn] as ViewerDef;
    const r = await run<{ loops: GraphLoop[] }>(mounted(), v, "memory.loops.list", { limit: 50 });
    if (!r.ok) throw new Error(r.code);
    const want = mixNames.filter((m) => v.full || (MIXES[m] as Mix).remote).map((m) => ids[m]);
    expect(r.value.loops.map((l) => l.id).sort()).toEqual([...want].sort());
    if (v.full) expect(JSON.stringify(r.value)).toContain(QUOTE);
    else {
      expect(JSON.stringify(r.value)).not.toContain(QUOTE);
      expect(r.value.loops.every((l) => l.counterpartId === null && l.evidence === null)).toBe(
        true,
      );
    }
  });

  it.each(cross)("update for %s, %s source", async (vn, mn) => {
    const v = VIEWERS[vn] as ViewerDef;
    const mix = MIXES[mn] as Mix;
    const r = await run<{ loop: GraphLoop }>(mounted(), v, "memory.loops.update", {
      id: ids[mn],
      status: "done",
    });
    if (v.full || mix.remote) {
      if (!r.ok) throw new Error(r.code);
      expect(r.value.loop.status).toBe("done");
      expect(JSON.stringify(r.value).includes(QUOTE)).toBe(v.full);
    } else {
      expect(r).toMatchObject({ ok: false, code: "not_found" });
      expect(g.getLoop(ids[mn] as string)?.status).toBe("open");
    }
  });

  it.each(viewerNames)("memory.entities.get open loops for %s", async (vn) => {
    const v = VIEWERS[vn] as ViewerDef;
    const r = await run<{ openLoops: GraphLoop[] }>(mounted(), v, "memory.entities.get", {
      id: sam,
    });
    if (!r.ok) throw new Error(r.code);
    const want = mixNames.filter((m) => v.full || (MIXES[m] as Mix).remote).length;
    expect(r.value.openLoops).toHaveLength(want);
    expect(JSON.stringify(r.value.openLoops).includes(QUOTE)).toBe(v.full);
  });
});

describe("events", () => {
  const readerFor = (v: ViewerDef) =>
    readerOf({
      role: "client",
      ...(v.full ? { desktopShell: true as const } : {}),
    });

  it.each(cross)("promise.updated for %s, %s source", (vn, mn) => {
    const v = VIEWERS[vn] as ViewerDef;
    const mix = MIXES[mn] as Mix;
    const out = personalizePromiseEvent({ promise: view(mn, true) }, readerFor(v), vis());
    if (v.full) {
      expect(JSON.stringify(out)).toContain(QUOTE);
    } else if (mix.remote) {
      expect(out).not.toBe(SKIP_EVENT);
      expect(leaks(out)).toEqual([]);
      expect((out as { promise: PromiseView }).promise.what).toBe(`Send the deck ${mn}`);
    } else {
      expect(out).toBe(SKIP_EVENT);
    }
  });

  it.each(cross)("memory.loop.updated for %s, %s source", (vn, mn) => {
    const v = VIEWERS[vn] as ViewerDef;
    const mix = MIXES[mn] as Mix;
    const loop = g.getLoop(ids[mn] as string) as GraphLoop;
    const out = personalizeLoopEvent({ loop }, readerFor(v), vis());
    if (v.full) expect(JSON.stringify(out)).toContain(QUOTE);
    else if (mix.remote) {
      expect(JSON.stringify(out)).not.toContain(QUOTE);
      expect((out as { loop: GraphLoop }).loop.counterpartId).toBeNull();
    } else expect(out).toBe(SKIP_EVENT);
  });

  it("a part of the Gateway (no paired device) and a missing reader are never full", () => {
    const gatewayPart = readerOf(null);
    expect(personalizePromiseEvent({ promise: view("messages", true) }, gatewayPart, vis())).toBe(
      SKIP_EVENT,
    );
    expect(
      personalizePromiseEvent(
        { promise: view("mail", true) },
        readerFor(VIEWERS.iOS as ViewerDef),
        undefined,
      ),
    ).toBe(SKIP_EVENT);
    const node = readerOf({ role: "node", desktopShell: true });
    expect(
      personalizeLoopEvent({ loop: g.getLoop(ids.messages as string) as GraphLoop }, node, vis()),
    ).toBe(SKIP_EVENT);
  });

  it("a row id that is missing hides the event too", () => {
    const ghost = { ...view("mail", true), id: "loop_ghost" };
    expect(
      personalizePromiseEvent({ promise: ghost }, readerFor(VIEWERS.iOS as ViewerDef), vis()),
    ).toBe(SKIP_EVENT);
  });

  describe("on the bus", () => {
    const frames = (bus: EventBus, v: ViewerDef, sink: string[]) =>
      bus.subscribe(["operator.read"], (f) => sink.push(f), "dev", readerFor(v));

    it("promise.updated needs only operator.read, and each subscriber gets its own form", () => {
      const bus = new EventBus();
      bus.setPersonalizer((event, payload, sub) =>
        event === "promise.updated"
          ? personalizePromiseEvent(payload as { promise: PromiseView }, sub.reader, vis())
          : undefined,
      );
      const shell: string[] = [];
      const phone: string[] = [];
      frames(bus, VIEWERS["desktop shell"] as ViewerDef, shell);
      frames(bus, VIEWERS.iOS as ViewerDef, phone);
      bus.publish("promise.updated", { promise: view("mail", true) });
      bus.publish("promise.updated", { promise: view("messages", true) });
      expect(shell).toHaveLength(2);
      expect(shell.join("")).toContain(QUOTE);
      // The phone has one frame, for the mail promise, with the stripped form and its own count.
      expect(phone).toHaveLength(1);
      expect(phone.join("")).not.toContain(QUOTE);
      expect(JSON.parse(phone[0] as string)).toMatchObject({ seq: 1 });
    });

    it.each(["promise.updated", "memory.loop.updated"] as const)(
      "%s is sent to nobody while no personalizer is installed",
      (event) => {
        const bus = new EventBus();
        const sink: string[] = [];
        frames(bus, VIEWERS["desktop shell"] as ViewerDef, sink);
        if (event === "promise.updated") bus.publish(event, { promise: view("mail", true) });
        else bus.publish(event, { loop: g.getLoop(ids.mail as string) as GraphLoop });
        expect(sink).toEqual([]);
      },
    );

    it("a personalizer that answers undefined does not fall back to the shared frame", () => {
      const bus = new EventBus();
      bus.setPersonalizer(() => undefined);
      const sink: string[] = [];
      frames(bus, VIEWERS.iOS as ViewerDef, sink);
      bus.publish("promise.updated", { promise: view("messages", true) });
      expect(sink).toEqual([]);
    });

    it("publishToDevice never carries these events", () => {
      const bus = new EventBus();
      const sink: string[] = [];
      frames(bus, VIEWERS.iOS as ViewerDef, sink);
      bus.publishToDevice("dev", "promise.updated", { promise: view("mail", true) });
      expect(sink).toEqual([]);
    });

    it("other events are unchanged (positive control)", () => {
      const bus = new EventBus();
      const sink: string[] = [];
      frames(bus, VIEWERS.iOS as ViewerDef, sink);
      bus.publish("gateway.shutdown", {} as never);
      expect(sink).toHaveLength(1);
    });
  });
});

describe("notification.device", () => {
  const toast = (route: string | null, kind: DeviceToast["kind"] = "promise_due"): DeviceToast => ({
    id: "n1",
    kind,
    title: `Reply to ${NAME}`,
    body: QUOTE,
    message: { titleKey: "x", bodyKey: "y", params: { name: NAME } },
    route,
    interruption: "active",
    createdAt: NOW,
  });

  it.each(mixNames)("promise_due for a %s promise", (mn) => {
    const mix = MIXES[mn] as Mix;
    const out = scrubDeviceToast(toast(`/promises/${ids[mn]}`), vis());
    if (!mix.remote) {
      expect(out).toBeNull();
      return;
    }
    expect(out).not.toBeNull();
    const s = JSON.stringify(out);
    expect(s).not.toContain(NAME);
    expect(s).not.toContain(QUOTE);
    expect(out).toMatchObject({
      kind: "promise_due",
      route: `/promises/${ids[mn]}`,
      message: { titleKey: "notice.promise.due.title", bodyKey: "notice.promise.due.body" },
    });
  });

  it.each([null, "/chat/t1", "/promises/", "/promises/x y", "/memory/people/sam"])(
    "a promise_due toast with route %s is not sent",
    (route) => {
      expect(scrubDeviceToast(toast(route), vis())).toBeNull();
    },
  );

  it("is not sent while no visibility reader is bound", () => {
    expect(scrubDeviceToast(toast(`/promises/${ids.mail}`), undefined)).toBeNull();
  });

  it("another kind passes through untouched (positive control)", () => {
    const t = toast("/chat/t1", "task_done");
    expect(scrubDeviceToast(t, vis())).toBe(t);
  });

  it("DeviceNotifications.send scrubs, and sends nothing for a hidden promise", () => {
    const sent: { deviceId: string; event: string; payload: unknown }[] = [];
    const notes = new DeviceNotifications();
    notes.bind({
      bus: {
        publishToDevice: (deviceId: string, event: string, payload: unknown) =>
          sent.push({ deviceId, event, payload }),
      },
    } as never);
    notes.register({ id: "c1", open: true } as never, "dev_1", true);
    // Before the visibility reader is bound, a promise toast goes nowhere.
    expect(notes.send("dev_1", toast(`/promises/${ids.mail}`))).toBe(false);
    notes.bindPromiseVisibility(vis());
    expect(notes.send("dev_1", toast(`/promises/${ids.messages}`))).toBe(false);
    expect(notes.send("dev_1", toast(`/promises/${ids.mixed}`))).toBe(false);
    expect(sent).toEqual([]);
    expect(notes.send("dev_1", toast(`/promises/${ids.mail}`))).toBe(true);
    expect(JSON.stringify(sent)).not.toContain(NAME);
    expect(sent).toHaveLength(1);
    // Positive control: an ordinary toast is sent as it was.
    expect(notes.send("dev_1", toast("/chat/t1", "task_done"))).toBe(true);
    expect(JSON.stringify(sent[1])).toContain(NAME);
  });
});

describe("promises.sources.* settings are desktop shell only", () => {
  const settingCall = (v: ViewerDef): Call => {
    const call = callOf(v, "settings.set");
    return {
      ...call,
      ctx: {
        db,
        bus: { bumpStateVersion: () => 1, stateVersion: 1 },
        log: { log() {} },
      },
    } as unknown as Call;
  };
  const set = (v: ViewerDef, key: string) =>
    (settingsHandlers["settings.set"] as HandlerDef).run(settingCall(v), {
      key,
      value: true,
    } as never);

  it.each([
    "promises.sources.mail",
    "promises.sources.messages",
    "promises.sources.meetings",
    "promises.sources.chat",
    "promises.sources",
  ])("%s", async (key) => {
    expect(isPromiseSourceKey(key)).toBe(true);
    for (const vn of viewerNames) {
      const v = VIEWERS[vn] as ViewerDef;
      if (v.full) {
        // Positive control: the shell writes it.
        await expect(set(v, key)).resolves.toMatchObject({ entry: { key, value: true } });
      } else {
        await expect(set(v, key)).rejects.toMatchObject({
          code: "forbidden",
          details: { reason: "owner_only" },
        });
      }
    }
  });

  it.each(["promises.enabled", "promises.notify", "promises.sourcesX", "promises.source"])(
    "%s is not a source key, and a remote admin device may set it",
    async (key) => {
      expect(isPromiseSourceKey(key)).toBe(false);
      await expect(set(VIEWERS.iOS as ViewerDef, key)).resolves.toBeDefined();
    },
  );

  it("params that name the shell change nothing", async () => {
    const v = VIEWERS["spoofed desktopShell param"] as ViewerDef;
    await expect(set(v, "promises.sources.messages")).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("the typed params of promises.mute and delete come through unchanged", () => {
  it("the service gets exactly the caller's params", async () => {
    const seen: MethodParams<"promises.mute">[] = [];
    const { svc } = fakeService(true);
    svc.mute = (p) => {
      seen.push(p);
      return { ok: true };
    };
    const handlers = promiseHandlers(svc, vis());
    await run(handlers, VIEWERS["desktop shell"] as ViewerDef, "promises.mute", {
      threadRef: "mail|t1",
      muted: true,
    });
    expect(seen).toEqual([{ threadRef: "mail|t1", muted: true }]);
  });
});
