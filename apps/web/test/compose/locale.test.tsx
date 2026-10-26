// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayEvent, GatewayStatus } from "../../src/client/index.ts";
import { ONBOARDED_KEY, PsycheApp } from "../../src/compose/PsycheApp.tsx";
import type { ShellPlatform } from "../../src/shell/platform.ts";

afterEach(cleanup);

function platform() {
  const status: GatewayStatus = { phase: "paired", health: "ok", attempt: 0 };
  const listeners = new Set<(e: GatewayEvent) => void>();
  let seq = 0;
  const p: ShellPlatform = {
    kind: "web",
    gateway: {
      getStatus: async () => status,
      onStatus: () => () => {},
      call: async (method) => {
        if (method === "settings.get")
          return { settings: { [ONBOARDED_KEY]: "2026-10-19T09:00:00.000Z" }, stateVersion: 1 };
        if (method.endsWith(".list")) return { [method.split(".")[0] ?? "items"]: [] };
        return {};
      },
      onEvent: (cb: (e: GatewayEvent) => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      onResync: () => () => {},
    },
    storage: { get: () => null, set: () => {} },
    notify: { show: () => {} },
  };
  const changed = (key: string, value: unknown) => {
    seq += 1;
    const e = {
      event: "settings.changed",
      payload: { entries: [{ key, value }] },
      seq,
      stateVersion: seq + 1,
    } as GatewayEvent;
    act(() => {
      for (const l of listeners) l(e);
    });
  };
  return { platform: p, changed };
}

describe("Language and region in the composed app (#608)", () => {
  it("re-renders formats in the chosen region and flips the direction live", async () => {
    window.innerWidth = 1280;
    window.history.replaceState(null, "", "/settings/appearance");
    const { platform: p, changed } = platform();
    render(<PsycheApp platform={p} />);
    expect(await screen.findByText(/· 1,234\.5 ·/)).toBeTruthy();
    changed("ui.locale", "de-DE");
    expect(await screen.findByText(/· 1\.234,5 ·/)).toBeTruthy();
    changed("ui.direction", "rtl");
    await waitFor(() => expect(document.documentElement.dir).toBe("rtl"));
  });
});
