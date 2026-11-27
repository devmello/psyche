// @vitest-environment happy-dom

import { PROTOCOL_VERSION } from "@psyche/protocol";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type GatewayStatus, INITIAL_STATUS } from "../../src/client/status.ts";
import { StartupSplash, splashLine } from "../../src/shell/components/StartupSplash.tsx";
import type { SavedGatewayView, ShellPlatform } from "../../src/shell/platform.ts";

afterEach(cleanup);

const HOST = "studio-mac";
const line = (status: GatewayStatus, over: { waited?: boolean; hasLocal?: boolean } = {}) =>
  splashLine({ status, run: undefined, helper: undefined, remote: { hostName: HOST, ...over } });
const base: GatewayStatus = { health: "unknown", phase: "connecting", attempt: 0 };

describe("splash line for a Gateway on another computer (design §4.6)", () => {
  it("names the Host while it finds it, checks it and waits for approval", () => {
    expect(line(base)).toEqual({ tone: "progress", text: "Finding studio-mac…", step: 0 });
    expect(line({ ...base, health: "ok", phase: "challenge" })).toEqual({
      tone: "progress",
      text: "Checking it's really studio-mac…",
      step: 1,
    });
    const pending = line({
      health: "ok",
      phase: "pending",
      attempt: 0,
      pairingCode: "ABCD-2345",
      gatewayFingerprint: `sha256:${"ab12".repeat(16)}`,
    });
    expect(pending).toMatchObject({
      tone: "progress",
      text: "Waiting for approval on studio-mac…",
    });
    expect((pending as { detail: string[] }).detail).toEqual([
      "Pairing code ABCD-2345",
      "Gateway key ab12 ab12 ab12 ab12 ab12 ab12",
      "Compare both with the request in studio-mac's Settings → Devices, then approve it there.",
    ]);
    expect(line({ health: "ok", phase: "paired", attempt: 0, scopes: [] })).toEqual({
      tone: "ready",
      text: "Ready",
    });
  });

  it("says the Host isn't answering after ten seconds, with Try again, Switch and Use This Mac", () => {
    const down: GatewayStatus = { health: "unreachable", phase: "disconnected", attempt: 3 };
    expect(line(down)).toMatchObject({ tone: "progress" });
    expect(line(down, { waited: true })).toMatchObject({
      tone: "error",
      text: "studio-mac isn't answering.",
      actions: ["retry", "switch"],
    });
    expect(line(down, { waited: true, hasLocal: true })).toMatchObject({
      actions: ["retry", "switch", "useThisMac"],
    });
  });

  it("is a full-window refusal, with no retry, when the identity changed", () => {
    for (const code of [
      "gateway_identity_changed",
      "gateway_identity_missing",
      "gateway_identity_invalid",
      "gateway_origin_mismatch",
    ]) {
      const l = line({ health: "ok", phase: "error", attempt: 0, lastError: code });
      expect(l).toMatchObject({
        tone: "error",
        text: "This isn't the studio-mac you paired with.",
        actions: ["switch", "pairAgain"],
        fatal: true,
      });
      expect((l as { actions: string[] }).actions).not.toContain("retry");
    }
  });

  it("says which side is older on a protocol mismatch", () => {
    const mismatch = (server: number): GatewayStatus => ({
      health: "ok",
      phase: "error",
      attempt: 0,
      lastError: "protocol_version_mismatch",
      serverProtocolVersion: server,
    });
    expect(line(mismatch(PROTOCOL_VERSION - 1))).toMatchObject({
      text: "studio-mac runs an older Psyche.",
      reason: "Update Psyche on studio-mac, then try again.",
    });
    expect(line(mismatch(PROTOCOL_VERSION + 1))).toMatchObject({
      text: "This app is older than studio-mac.",
      reason: "Update Psyche on this computer, then try again.",
    });
  });

  it("says this computer was removed when the Host revoked it", () => {
    expect(
      line({ health: "ok", phase: "denied", attempt: 0, lastError: "device revoked" }),
    ).toMatchObject({
      text: "This computer was removed from studio-mac.",
      actions: ["pairAgain", "forget"],
      fatal: true,
    });
  });

  it("says a pairing link was refused when the Host denied its setup token", () => {
    expect(
      line({
        health: "ok",
        phase: "denied",
        attempt: 0,
        lastError: "This pairing link was already used, has expired or was revoked.",
        deniedCode: "setup_token_invalid",
      }),
    ).toMatchObject({
      text: "studio-mac refused this pairing link.",
      reason:
        "It was already used, has expired or was revoked. Make a new one on studio-mac and add it again.",
      actions: ["switch", "forget"],
      fatal: true,
    });
  });
});

describe("StartupSplash for a remote Gateway", () => {
  const saved: SavedGatewayView[] = [
    { id: "this-mac", name: "This Mac", origin: null, remote: false, active: false, pinned: false },
    {
      id: "gw_0123456789ab",
      name: HOST,
      origin: "https://studio-mac.tail1234.ts.net",
      remote: true,
      active: true,
      pinned: true,
    },
  ];
  function platform(over: Partial<NonNullable<ShellPlatform["gateways"]>> = {}): ShellPlatform {
    return {
      kind: "desktop",
      chrome: { titleBar: "inset", splash: true, remote: { hostName: HOST } },
      gateway: {
        getStatus: async () => INITIAL_STATUS,
        onStatus: () => () => {},
        onEvent: () => () => {},
        onResync: () => () => {},
        call: async () => ({}),
        retry: async () => {},
      },
      gateways: {
        list: async () => saved,
        add: async () => saved[1] as SavedGatewayView,
        rename: async () => {},
        remove: async () => {},
        switchTo: async () => {},
        repair: async () => {},
        ...over,
      },
      storage: { get: () => null, set: () => {} },
      notify: { show: () => {} },
    };
  }

  it("offers Switch Gateway and Forget and pair again, and no way past an identity refusal", async () => {
    const repair = vi.fn(async () => {});
    const changed: GatewayStatus = {
      health: "ok",
      phase: "error",
      attempt: 0,
      lastError: "gateway_identity_changed",
    };
    render(
      <StartupSplash
        platform={platform({ repair })}
        status={changed}
        run={undefined}
        helper={undefined}
      />,
    );
    await act(async () => {});
    expect(screen.getByText("This isn't the studio-mac you paired with.")).toBeTruthy();
    expect(screen.queryByText("Open Psyche anyway")).toBeNull();
    expect(screen.queryByText("Try again")).toBeNull();
    expect(screen.getByRole("button", { name: "Switch Gateway" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Forget and pair again" }));
    expect(repair).toHaveBeenCalledWith("gw_0123456789ab");
  });

  it("opens the saved Gateways under the splash from Switch Gateway", async () => {
    const changed: GatewayStatus = {
      health: "ok",
      phase: "error",
      attempt: 0,
      lastError: "gateway_identity_changed",
    };
    render(
      <StartupSplash platform={platform()} status={changed} run={undefined} helper={undefined} />,
    );
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Switch Gateway" }));
    expect(await screen.findByRole("button", { name: "Switch to This Mac" })).toBeTruthy();
  });
});
