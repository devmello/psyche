// @vitest-environment happy-dom

import type { Device } from "@psyche/protocol";
import { GatewayProvider } from "@psyche/ui";
import { MockGateway } from "@psyche/ui/testing";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FileAccessSettings,
  folderGrantsFromPolicy,
  POLICY_KEY,
  policyWithFolders,
  SystemVoiceSettings,
  settingsSectionOf,
  WebDevicesSettings,
} from "../../src/compose/settings.tsx";
import type {
  DictationPort,
  ShellPlatform,
  SystemDictationStatus,
} from "../../src/shell/platform.ts";

afterEach(cleanup);

describe("policy ↔ folder grants", () => {
  it("reads only well-formed folders out of permissions.policy", () => {
    const values = {
      [POLICY_KEY]: {
        defaultMode: "balanced",
        folders: [
          { path: "/Users/me/Notes", mode: "rw" },
          { path: "", mode: "ro" },
          { path: "/x", mode: "rwx" },
          "junk",
        ],
      },
    };
    expect(folderGrantsFromPolicy(values)).toEqual([{ path: "/Users/me/Notes", access: "rw" }]);
    expect(folderGrantsFromPolicy({})).toEqual([]);
    expect(folderGrantsFromPolicy({ [POLICY_KEY]: "nope" })).toEqual([]);
  });

  it("keeps the other policy keys and dedupes paths when writing", () => {
    const values = { [POLICY_KEY]: { defaultMode: "manual", folders: [] } };
    expect(
      policyWithFolders(values, [
        { path: "/a", access: "ro" },
        { path: " /a ", access: "rw" },
        { path: "/b", access: "rw" },
        { path: "", access: "ro" },
      ]),
    ).toEqual({
      defaultMode: "manual",
      folders: [
        { path: "/a", mode: "ro" },
        { path: "/b", mode: "rw" },
      ],
    });
  });

  it("maps /settings routes to kit sections with a fallback", () => {
    expect(settingsSectionOf("/settings/files")).toBe("files");
    expect(settingsSectionOf("/settings")).toBe("model");
    expect(settingsSectionOf("/settings/general")).toBe("model");
    expect(settingsSectionOf("/chat")).toBeNull();
  });
});

function platformWith(pickFolder: (() => Promise<string | null>) | undefined): ShellPlatform {
  return {
    kind: pickFolder ? "desktop" : "web",
    gateway: {
      getStatus: async () => ({ phase: "paired", health: "healthy" }) as never,
      onStatus: () => () => {},
      call: async () => ({}),
      onEvent: () => () => {},
      onResync: () => () => {},
    },
    storage: { get: () => null, set: () => {} },
    notify: { show: () => {} },
    ...(pickFolder ? { dialogs: { pickFolder } } : {}),
  };
}

describe("FileAccessSettings", () => {
  it("adds the picked folder as a read-only permissions.policy grant", async () => {
    const gw = new MockGateway();
    const pickFolder = vi.fn(async () => "/Users/me/Taxes");
    render(
      <GatewayProvider client={gw}>
        <FileAccessSettings platform={platformWith(pickFolder)} />
      </GatewayProvider>,
    );
    await waitFor(() => expect(gw.calls.some((c) => c.method === "settings.get")).toBe(true));
    fireEvent.click(await screen.findByRole("button", { name: "Choose a folder…" }));
    await waitFor(() => expect(gw.calls.some((c) => c.method === "settings.set")).toBe(true));
    const set = gw.calls.find((c) => c.method === "settings.set");
    expect(set?.params).toMatchObject({
      key: POLICY_KEY,
      value: { folders: [{ path: "/Users/me/Taxes", mode: "ro" }] },
    });
    expect(pickFolder).toHaveBeenCalledWith({ title: expect.stringMatching(/^Share a folder/) });
    await screen.findByText("/Users/me/Taxes");
  });

  it("has no picker on the web host; typed paths still write the policy", async () => {
    const gw = new MockGateway();
    render(
      <GatewayProvider client={gw}>
        <FileAccessSettings platform={platformWith(undefined)} />
      </GatewayProvider>,
    );
    expect(screen.queryByRole("button", { name: "Choose a folder…" })).toBeNull();
    const input = await screen.findByLabelText("Share a folder");
    fireEvent.change(input, { target: { value: "/srv/docs" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(gw.calls.some((c) => c.method === "settings.set")).toBe(true));
    expect(gw.calls.find((c) => c.method === "settings.set")?.params).toMatchObject({
      key: POLICY_KEY,
      value: { folders: [{ path: "/srv/docs", mode: "ro" }] },
    });
  });
});

describe("Settings → Devices on the web (#554)", () => {
  const webDevice = (id: string): Device =>
    ({
      id,
      name: "Psyche Web",
      platform: "web",
      role: "client",
      publicKey: "MCowBQYDK2VwAyEAx8x9Qm3h0Tq6vQ3m1gD4k2nqv9c3F0aY0bJ6m1s2t3U=",
      scopes: ["operator.read", "operator.write", "operator.admin"],
      pairedAt: "2026-10-20T10:00:00.000Z",
      lastSeenAt: "2026-10-20T10:00:00.000Z",
      revokedAt: null,
    }) as Device;

  it("marks this browser and revokes a stale one, never this one", async () => {
    const gw = new MockGateway({ devices: [webDevice("dev_me"), webDevice("dev_stale")] });
    const base = platformWith(undefined);
    const platform: ShellPlatform = {
      ...base,
      gateway: { ...base.gateway, deviceId: async () => "dev_me" },
    };
    render(
      <GatewayProvider client={gw}>
        <WebDevicesSettings platform={platform} />
      </GatewayProvider>,
    );
    const chip = await screen.findByText("This device");
    expect(screen.queryByTestId("this-mac-admin")).toBeNull();
    const menus = await screen.findAllByRole("button", { name: "More for Psyche Web" });
    expect(menus).toHaveLength(1);
    expect(chip.closest("li")?.contains(menus[0] as Node)).toBe(false);

    fireEvent.click(menus[0] as HTMLElement);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Revoke" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
    await waitFor(() =>
      expect(gw.calls.find((c) => c.method === "devices.revoke")?.params).toEqual({
        deviceId: "dev_stale",
      }),
    );
  });
});

describe("system-wide dictation in Voice & dictation (J9, Q2)", () => {
  it("shows the desktop's status, follows updates and re-checks", async () => {
    let push: ((s: SystemDictationStatus) => void) | undefined;
    const port: DictationPort = {
      getStatus: async () => ({ helper: "online", accessibility: "missing", watching: false }),
      onStatus: (cb) => {
        push = cb;
        return () => undefined;
      },
      recheck: vi.fn(async () => ({
        helper: "online" as const,
        accessibility: "granted" as const,
        watching: true,
      })),
      openAccessibilitySettings: vi.fn(),
    };
    render(
      <GatewayProvider client={new MockGateway()}>
        <SystemVoiceSettings dictation={port} />
      </GatewayProvider>,
    );
    expect(await screen.findByText("Needed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open System Settings" }));
    expect(port.openAccessibilitySettings).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByText("Granted")).toBeTruthy();
    push?.({ helper: "offline", accessibility: "unknown", watching: false });
    expect(await screen.findByText("Helper not running")).toBeTruthy();
  });
});
