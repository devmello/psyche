import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { calendarAdapter } from "../../src/night-shift/adapters/calendar.ts";
import {
  type FileGrant,
  filesAdapter,
  splitFilesCall,
} from "../../src/night-shift/adapters/files.ts";
import {
  adapterFor,
  type ConnectorTypes,
  createAdapters,
} from "../../src/night-shift/adapters/index.ts";
import { remindersAdapter } from "../../src/night-shift/adapters/reminders.ts";
import type { CaptureOk, StagedCall } from "../../src/night-shift/adapters/types.ts";
import { event, FakeRegistry, reminder } from "./adapters-registry.ts";

const PREFIXES = ["", "mcp__apple__", "mcp__google__"] as const;

describe.each(PREFIXES)("reminders under prefix %j", (p) => {
  const t = (name: string, args: Record<string, unknown>): StagedCall => ({
    tool: `${p}${name}`,
    args,
  });
  function setup() {
    const reg = new FakeRegistry();
    reg.reminders.set("r-1", reminder());
    return { reg, adapter: remindersAdapter(reg) };
  }

  it("captures, checks and goes stale like the bare name", async () => {
    for (const call of [
      t("reminders_update", { id: "r-1", notes: "after" }),
      t("reminders_complete", { id: "r-1" }),
    ]) {
      const { reg, adapter } = setup();
      const cap = (await adapter.capture(call)) as CaptureOk;
      expect(cap.ok).toBe(true);
      expect(await adapter.check(call, cap)).toEqual({ fresh: true });
      reg.reminders.set("r-1", reminder({ modifiedAt: "2026-11-25T00:00:00Z" }));
      expect(await adapter.check(call, cap)).toEqual({ fresh: false, reason: "changed" });
    }
  });

  it("create: duplicate refused, and the inverse keeps the prefix", async () => {
    const { reg, adapter } = setup();
    const create = t("reminders_create", { title: "Pay rent", listId: "L" });
    const cap = (await adapter.capture(create)) as CaptureOk;
    expect(cap.ok).toBe(true);
    expect(adapter.inverse?.(create, cap)).toBeUndefined();
    expect(adapter.inverse?.(create, cap, { id: "r-new" })).toEqual({
      tool: `${p}reminders_delete`,
      args: { id: "r-new" },
      destructive: true,
    });
    reg.reminders.set("r-3", reminder({ id: "r-3", title: "Pay rent", listId: "L" }));
    expect(await adapter.capture(create)).toEqual({ ok: false, reason: "duplicate" });
  });

  it("complete and update inverses keep the prefix; complete previews as completing", async () => {
    const { adapter } = setup();
    const complete = t("reminders_complete", { id: "r-1" });
    const cc = (await adapter.capture(complete)) as CaptureOk;
    expect(adapter.inverse?.(complete, cc)).toEqual({
      tool: `${p}reminders_complete`,
      args: { id: "r-1", completed: false },
    });
    expect(adapter.preview(complete, cc).title).toBe("Complete a reminder");
    const update = t("reminders_update", { id: "r-1", notes: "after" });
    const uc = (await adapter.capture(update)) as CaptureOk;
    expect(adapter.inverse?.(update, uc)).toEqual({
      tool: `${p}reminders_update`,
      args: { id: "r-1", notes: "before" },
    });
  });
});

describe.each(["", "mcp__apple__"] as const)("calendar (flat shape) under prefix %j", (p) => {
  const adapter = (reg: FakeRegistry) =>
    calendarAdapter(reg, { flavorOf: (id) => (id === "apple" ? "apple" : undefined) });

  it("judges solo events, attendees and series like the bare name", async () => {
    const reg = new FakeRegistry();
    reg.events.set("e-1", event());
    const a = adapter(reg);
    const upd = { tool: `${p}calendar_update_event`, args: { id: "e-1", location: "Room 4" } };
    const cap = (await a.capture(upd)) as CaptureOk;
    expect(cap).toMatchObject({ ok: true, target: "e-1" });
    expect(a.inverse?.(upd, cap)).toEqual({
      tool: `${p}calendar_update_event`,
      args: { id: "e-1", location: "Desk" },
    });
    expect(await a.capture({ ...upd, args: { ...upd.args, attendees: ["a@x.com"] } })).toEqual({
      ok: false,
      reason: "unknown_key:attendees",
    });
    expect(await a.capture({ ...upd, args: { ...upd.args, span: "future" } })).toEqual({
      ok: false,
      reason: "series_refused",
    });
    const create = {
      tool: `${p}calendar_create_event`,
      args: { title: "Plan", start: "2026-11-26T09:00:00Z", end: "2026-11-26T10:00:00Z" },
    };
    const cc = (await a.capture(create)) as CaptureOk;
    expect(a.inverse?.(create, cc, { id: "e-new" })).toEqual({
      tool: `${p}calendar_delete_event`,
      args: { id: "e-new" },
      destructive: true,
    });
  });

  it("an unknown connector prefix is refused, never guessed from its name", async () => {
    const reg = new FakeRegistry();
    reg.events.set("e-1", event());
    const upd = {
      tool: "mcp__google-fake__calendar_update_event",
      args: { event: {}, eventId: "e-1" },
    };
    expect(await adapter(reg).capture(upd)).toEqual({ ok: false, reason: "unknown_connector" });
  });
});

describe.each(PREFIXES)("files under prefix %j", (p) => {
  let base: string;
  let share: string;
  let grants: FileGrant[];
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "ns-prefix-")));
    share = join(base, "share");
    mkdirSync(join(share, "Inbox"), { recursive: true });
    mkdirSync(join(share, "Filed"));
    mkdirSync(join(share, "Archive"));
    writeFileSync(join(share, "Inbox", "bill.pdf"), "pdf");
    grants = [{ root: share, mode: "rw" }];
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const a = () => filesAdapter({ grants: () => grants });
  const move = (path: string, to: string, name?: string): StagedCall => ({
    tool: `${p}files_move`,
    args: { items: [{ path, to, ...(name ? { name } : {}) }] },
  });

  it("rename and move are captured and judged, not skipped for the prefix", async () => {
    const rename = {
      tool: `${p}files_rename`,
      args: { path: join(share, "Inbox", "bill.pdf"), name: "b.pdf" },
    };
    const rc = (await a().capture(rename)) as CaptureOk;
    expect(a().preview(rename, rc).title).toBe("Rename a file");
    const mv = move(join(share, "Inbox", "bill.pdf"), join(share, "Filed"));
    expect(a().preview(mv, (await a().capture(mv)) as CaptureOk).title).toBe("Move a file");
    // Refusals still fire under the prefix.
    expect(await a().capture(move(join(share, "Inbox", "bill.pdf"), base))).toEqual({
      ok: false,
      reason: "outside_grant",
    });
    expect(await a().capture(move(`${share}/Inbox/../x`, join(share, "Filed")))).toEqual({
      ok: false,
      reason: "dotdot",
    });
  });

  it("splits a multi-item move keeping the tool name, folds, and inverts with the prefix", async () => {
    const two: StagedCall = {
      tool: `${p}files_move`,
      args: {
        items: [
          { path: "/a", to: "/b" },
          { path: "/c", to: "/d" },
        ],
      },
    };
    expect(splitFilesCall(two).map((c) => c.tool)).toEqual([`${p}files_move`, `${p}files_move`]);

    const first = move(join(share, "Inbox", "bill.pdf"), join(share, "Filed"));
    const cap1 = (await a().capture(first)) as CaptureOk;
    const second = move(join(share, "Filed", "bill.pdf"), join(share, "Archive"), "final.pdf");
    const cap2 = (await a().capture(second, {
      pending: [{ call: first, capture: cap1 }],
    })) as CaptureOk;
    expect(cap2).toMatchObject({ ok: true, folds: [cap1.target] });
    expect(cap2.call?.tool).toBe(`${p}files_move`);

    const { call, cap } = { call: first, cap: cap1 };
    renameSync(join(share, "Inbox", "bill.pdf"), join(share, "Filed", "bill.pdf"));
    expect(a().inverse?.(call, cap)?.tool).toBe(`${p}files_move`);
    expect(await a().postState?.(call, cap)).toMatchObject({ id: expect.any(String) });
  });
});

// R2-3: a prefix is stageable only when it names a live connector of a stageable type.
describe("adapterFor", () => {
  const reg = new FakeRegistry();
  const adapters = createAdapters(reg, { grants: () => [] }, new Map());
  const connectors: ConnectorTypes = new Map([
    ["apple", "apple"],
    ["google", "google"],
    ["work-mail", "mail"],
    ["shop", "shopping"],
    ["notes", "obsidian"],
  ]);

  it("returns an adapter for bare names and for live stageable connectors", () => {
    for (const tool of [
      "mail_reply_draft",
      "files_move",
      "reminders_create",
      "calendar_update_event",
      "mcp__apple__mail_reply_draft",
      "mcp__apple__files_move",
      "mcp__google__gmail_create_draft",
      "mcp__google__calendar_create_event",
      "mcp__work-mail__mail_create_draft",
    ]) {
      expect(adapterFor(adapters, tool, connectors), tool).toBeDefined();
    }
  });

  it("returns undefined for third-party MCP servers and non-stageable connector types", () => {
    for (const tool of [
      "mcp__some-mcp-server__files_move",
      "mcp__evil__mail_create_draft",
      "mcp__evil__calendar_update_event",
      "mcp__evil__reminders_create",
      "mcp__apple-fake__files_move", // looks like apple, is not a live connector
      "mcp__shop__mail_create_draft", // a live connector, but not a stageable type
      "mcp__notes__files_rename",
      "mcp__google__mail_send", // no adapter for the bare name
      "mcp__apple__calendar_delete_event",
    ]) {
      expect(adapterFor(adapters, tool, connectors), tool).toBeUndefined();
    }
  });

  it("returns undefined for everything prefixed when no connector is live", () => {
    expect(adapterFor(adapters, "mcp__apple__files_move", new Map())).toBeUndefined();
    expect(adapterFor(adapters, "files_move", new Map())).toBeDefined();
  });

  it("builds calendar flavours from the injected types only", async () => {
    const adapters2 = createAdapters(reg, { grants: () => [] }, new Map([["g1", "google"]]));
    reg.events.set("e-1", event());
    const call = {
      tool: "mcp__g1__calendar_update_event",
      args: { eventId: "e-1", event: { location: "x" } },
    };
    expect(
      (await adapterFor(adapters2, call.tool, new Map([["g1", "google"]]))?.capture(call))?.ok,
    ).toBe(true);
    // Same call, but the connector id "google" is not registered in this map: refused.
    const named = { ...call, tool: "mcp__google__calendar_update_event" };
    expect(await adapters2.get("calendar_update_event")?.capture(named)).toEqual({
      ok: false,
      reason: "unknown_connector",
    });
  });
});
