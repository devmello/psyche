// @vitest-environment happy-dom
import type { MethodName, MethodParams, MethodResult } from "@psyche/protocol";
import { type GatewayClient, GatewayProvider, GatewayRequestError } from "@psyche/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  BACKUP_SCHEDULE_KEY,
  BackupsPanel,
  formatBytes,
  isUnavailable,
  scheduleOf,
} from "../../src/compose/backups.tsx";
import { LogViewer, lineText, tailParams } from "../../src/compose/logs.tsx";

afterEach(cleanup);

type Handler = (params: unknown) => unknown;

/** A `GatewayClient` over a handler table; unknown methods fail like a Gateway without them. */
function fakeClient(handlers: Partial<Record<MethodName, Handler>>) {
  const calls: { method: string; params: unknown }[] = [];
  const client: GatewayClient = {
    async request<M extends MethodName>(method: M, params: MethodParams<M>) {
      calls.push({ method, params });
      const h = handlers[method];
      if (h === undefined)
        throw new GatewayRequestError(method, "unknown_method", `unknown method "${method}"`);
      return (await h(params)) as MethodResult<M>;
    },
    subscribe: () => () => {},
    connectionState: () => "open",
    onConnectionState: () => () => {},
  };
  return { client, calls };
}

const settings: Handler = () => ({ settings: {}, stateVersion: 1 });
const setSetting: Handler = (p) => {
  const { key, value } = p as { key: string; value: unknown };
  return { entry: { key, value, updatedAt: "2026-10-19T10:00:00.000Z" }, stateVersion: 2 };
};
const BACKUP = {
  file: "psyche-20261019-100000.tar.gz.age",
  createdAt: "2026-10-19T10:00:00.000Z",
  bytes: 2_500_000,
  encrypted: true,
  verifiedAt: null,
};

describe("backups helpers", () => {
  it("reads the schedule setting defensively", () => {
    expect(scheduleOf({})).toEqual({ interval: "off", keep: 7 });
    expect(scheduleOf({ [BACKUP_SCHEDULE_KEY]: { interval: "daily", keep: 3 } })).toEqual({
      interval: "daily",
      keep: 3,
    });
    expect(scheduleOf({ [BACKUP_SCHEDULE_KEY]: { interval: "hourly", keep: 0 } })).toEqual({
      interval: "off",
      keep: 7,
    });
  });

  it("formats sizes and recognises a Gateway without the methods", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2_500_000)).toBe("2.4 MB");
    expect(isUnavailable(new GatewayRequestError("backup.list", "unknown_method", "x"))).toBe(true);
    expect(isUnavailable(new Error('unknown method "backup.list"'))).toBe(true);
    expect(isUnavailable(new Error("disk full"))).toBe(false);
  });
});

describe("BackupsPanel", () => {
  it("lists backups, creates one with a passphrase sent once, verifies and deletes", async () => {
    const backups = [BACKUP];
    const { client, calls } = fakeClient({
      "settings.get": settings,
      "settings.set": setSetting,
      "backup.list": () => ({ backups, dir: "/home/h/backups" }),
      "backup.create": (p) => {
        const created = { ...BACKUP, file: "psyche-new.tar.gz.age" };
        backups.unshift(created);
        return { backup: created, files: 42, params: p };
      },
      "backup.verify": () => ({ ok: true, files: 42, problems: [], backup: BACKUP }),
      "backup.delete": () => ({ ok: true }),
    });
    render(
      <GatewayProvider client={client}>
        <BackupsPanel />
      </GatewayProvider>,
    );
    const list = await screen.findByRole("list", { name: "Backups" });
    expect(within(list).getByText(BACKUP.file)).toBeTruthy();
    expect(screen.getByText(/2\.4 MB/)).toBeTruthy();

    const create = screen.getByRole("button", { name: "Back up now" });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Passphrase"), {
      target: { value: "correct horse battery" },
    });
    expect((create as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(create);
    await screen.findByText(/Backed up 42 files to psyche-new/);
    expect(calls.find((c) => c.method === "backup.create")?.params).toEqual({
      passphrase: "correct horse battery",
    });
    expect((screen.getByLabelText("Passphrase") as HTMLInputElement).value).toBe("");
    await within(await screen.findByRole("list", { name: "Backups" })).findByText(
      "psyche-new.tar.gz.age",
    );

    fireEvent.click(screen.getByRole("button", { name: `Verify ${BACKUP.file}` }));
    await screen.findByText(/verified: 42 files match/);
    fireEvent.click(screen.getByRole("button", { name: `Delete ${BACKUP.file}` }));
    await screen.findByText(`Deleted ${BACKUP.file}.`);
    expect(calls.find((c) => c.method === "backup.delete")?.params).toEqual({
      file: BACKUP.file,
    });

    fireEvent.click(screen.getByLabelText("Daily"));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "settings.set")?.params).toEqual({
        key: BACKUP_SCHEDULE_KEY,
        value: { interval: "daily", keep: 7 },
      }),
    );
    expect(screen.getByText(/psyche backup restore \/home\/h\/backups/)).toBeTruthy();
  });

  it("says backups need a newer Gateway when the methods are missing", async () => {
    const { client } = fakeClient({ "settings.get": settings });
    render(
      <GatewayProvider client={client}>
        <BackupsPanel />
      </GatewayProvider>,
    );
    await screen.findByText(/Backups need a newer Gateway/);
  });
});

describe("LogViewer", () => {
  it("shows filtered lines with their fields and refetches on filter changes", async () => {
    const lines = [
      {
        ts: "2026-10-19T10:00:00.000Z",
        level: "info" as const,
        subsystem: "gateway",
        msg: "rpc",
        fields: { method: "chat.send", ms: 12 },
      },
      {
        ts: "2026-10-19T10:00:01.000Z",
        level: "error" as const,
        subsystem: "agent",
        msg: "tool call failed",
        fields: { tool: "browser_click", code: "cdp_error", callId: "c1" },
      },
    ];
    const { client, calls } = fakeClient({
      "logs.tail": (p) => {
        const { level } = p as { level: string };
        return {
          lines: level === "error" ? lines.slice(1) : lines,
          subsystems: ["gateway", "agent"],
          truncated: false,
        };
      },
    });
    render(
      <GatewayProvider client={client}>
        <LogViewer />
      </GatewayProvider>,
    );
    const list = await screen.findByRole("list", { name: "Log lines" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getByText("tool call failed")).toBeTruthy();
    expect(within(list).getByText(/tool=browser_click code=cdp_error/)).toBeTruthy();
    expect(calls[0]?.params).toEqual({ lines: 200, level: "info" });

    fireEvent.change(screen.getByLabelText("Level"), { target: { value: "error" } });
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: " cdp_error " } });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(calls.at(-1)?.params).toEqual({ lines: 200, level: "error", search: "cdp_error" }),
    );
    // The query key changed, so the list is a new element.
    await waitFor(() =>
      expect(
        within(screen.getByRole("list", { name: "Log lines" })).getAllByRole("listitem"),
      ).toHaveLength(1),
    );
    // The subsystem menu lists what the Gateway saw.
    expect(within(screen.getByLabelText("Subsystem")).getAllByRole("option")).toHaveLength(3);
  });

  it("says the viewer needs a newer Gateway without logs.tail", async () => {
    const { client } = fakeClient({});
    render(
      <GatewayProvider client={client}>
        <LogViewer />
      </GatewayProvider>,
    );
    await screen.findByText(/log viewer needs a newer Gateway/);
  });

  it("formats params and lines", () => {
    expect(tailParams({ level: "warn", subsystem: "", search: "  ", lines: 50 })).toEqual({
      lines: 50,
      level: "warn",
    });
    expect(
      lineText({ ts: "t", level: "warn", subsystem: "agent", msg: "m", fields: { a: 1 } }),
    ).toBe('t WARN [agent] m {"a":1}');
    expect(lineText({ ts: "t", level: "info", msg: "m" })).toBe("t INFO m");
  });
});
