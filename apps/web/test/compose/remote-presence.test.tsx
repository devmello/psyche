// @vitest-environment happy-dom

import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RemotePresencePanel, useRemotePresence } from "../../src/compose/remote-presence.tsx";
import { notifyPasskeysChanged } from "../../src/lib/passkey-state.ts";
import type { ShellPlatform } from "../../src/shell/platform.ts";

/**
 * Touch ID for approvals on a remote window (remote-gateway design §6.2, R2): the hook tells the
 * approval card whether this computer has a passkey; the Settings panel sets one up for the
 * Host's site, with the Host's own approval for the first one.
 */

afterEach(cleanup);

function platform(opts: {
  calls: Record<string, (p: unknown) => unknown>;
  withPasskeys?: boolean;
}): ShellPlatform & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    kind: "desktop",
    chrome: { titleBar: "native", remote: { hostName: "studio-mac" } },
    gateway: {
      call: async (method: string, params: unknown) => {
        seen.push(method);
        const fn = opts.calls[method];
        if (!fn) throw Object.assign(new Error(`no ${method}`), { code: "internal" });
        return fn(params);
      },
      onStatus: () => () => undefined,
      getStatus: async () => ({ phase: "paired" }),
      onEvent: () => () => undefined,
      onResync: () => () => undefined,
    },
    ...(opts.withPasskeys === false
      ? {}
      : {
          passkeys: {
            deviceId: async () => "dev-1",
            authenticator: {
              create: async () => ({ id: "cred" }),
              get: async () => ({ id: "cred" }),
            },
          },
        }),
  } as unknown as ShellPlatform & { seen: string[] };
}

describe("useRemotePresence", () => {
  it("is absent on a window of This Mac", () => {
    const p = platform({ calls: {} });
    delete (p.chrome as { remote?: unknown }).remote;
    expect(renderHook(() => useRemotePresence(p)).result.current).toBeUndefined();
  });

  it("says whether this computer has a passkey, and follows a change", async () => {
    let list: unknown[] = [];
    const p = platform({ calls: { "passkeys.list": () => ({ passkeys: list }) } });
    const { result } = renderHook(() => useRemotePresence(p));
    await waitFor(() => expect(p.seen).toContain("passkeys.list"));
    expect(result.current).toEqual({ hostName: "studio-mac", hasPasskey: false });
    list = [{ id: "pk1" }];
    await act(async () => notifyPasskeysChanged());
    await waitFor(() => expect(result.current?.hasPasskey).toBe(true));
  });

  it("never claims a passkey when the window has no way to make one", async () => {
    const p = platform({
      withPasskeys: false,
      calls: { "passkeys.list": () => ({ passkeys: [{ id: "pk1" }] }) },
    });
    const { result } = renderHook(() => useRemotePresence(p));
    expect(result.current).toEqual({ hostName: "studio-mac", hasPasskey: false });
    expect(p.seen).toEqual([]);
  });
});

describe("RemotePresencePanel", () => {
  const options = { challenge: "c" };

  it("asks the Host to approve the first passkey, then adds it with that approval", async () => {
    let finishes = 0;
    const finish = vi.fn((params: unknown) => {
      finishes += 1;
      if (finishes === 1)
        throw Object.assign(new Error("needs approval"), {
          code: "approval_required",
          details: { approvalId: "apr_1" },
        });
      expect((params as { approvalId?: string }).approvalId).toBe("apr_1");
      return { passkey: { id: "pk1" } };
    });
    let list: unknown[] = [];
    const p = platform({
      calls: {
        "passkeys.list": () => ({ passkeys: list }),
        "passkeys.reauth.begin": () => {
          throw Object.assign(new Error("none"), { code: "not_found" });
        },
        "passkeys.register.begin": () => ({ ceremonyId: "c1", options }),
        "passkeys.register.finish": finish,
      },
    });
    render(<RemotePresencePanel platform={p} />);
    const enable = await screen.findByRole("button", {
      name: "Use Touch ID for approvals on this computer",
    });
    expect(screen.getByTestId("remote-presence-state").textContent).toContain("isn't set up");
    fireEvent.click(enable);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("studio-mac"));
    expect(finish).toHaveBeenCalledTimes(1);

    list = [{ id: "pk1" }];
    fireEvent.click(
      await screen.findByRole("button", { name: "Use Touch ID for approvals on this computer" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("remote-presence-state").textContent).toContain("is on"),
    );
    expect(finish).toHaveBeenCalledTimes(2);
  });

  it("says so when the Host's Gateway has no https address", async () => {
    const p = platform({
      calls: {
        "passkeys.list": () => ({ passkeys: [] }),
        "passkeys.reauth.begin": () => {
          throw Object.assign(new Error("needs origin"), { code: "unavailable" });
        },
      },
    });
    render(<RemotePresencePanel platform={p} />);
    const note = await screen.findByTestId("remote-presence-unavailable");
    expect(note.textContent).toContain("studio-mac");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
