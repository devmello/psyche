// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type GatewayStatus, INITIAL_STATUS } from "../../src/client/status.ts";
import { StartupSplash } from "../../src/shell/components/StartupSplash.tsx";
import type { ShellPlatform } from "../../src/shell/platform.ts";

afterEach(cleanup);

const connecting: GatewayStatus = { health: "unknown", phase: "connecting", attempt: 0 };

function platform(restoredByHand?: () => Promise<void>): ShellPlatform {
  return {
    kind: "desktop",
    chrome: { titleBar: "inset", splash: true },
    gateway: {
      getStatus: async () => INITIAL_STATUS,
      onStatus: () => () => {},
      onEvent: () => () => {},
      onResync: () => () => {},
      call: async () => ({}),
      retry: async () => {},
      ...(restoredByHand === undefined ? {} : { restoredByHand }),
    },
    storage: { get: () => null, set: () => {} },
    notify: { show: () => {} },
  };
}

describe("the splash after a restore the Gateway could not finish", () => {
  it("offers 'I put my data back myself' and runs it", () => {
    const restoredByHand = vi.fn(async () => {});
    render(
      <StartupSplash
        platform={platform(restoredByHand)}
        status={connecting}
        run={{
          kind: "stopped",
          mode: "launchd",
          reason: "Psyche was putting your data back and could not finish",
          restoreInterrupted: true,
        }}
        helper={undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "I put my data back myself" }));
    expect(restoredByHand).toHaveBeenCalledOnce();
  });

  it("does not offer it for an ordinary failed start, or without the desktop's support", () => {
    const { rerender } = render(
      <StartupSplash
        platform={platform(async () => {})}
        status={connecting}
        run={{ kind: "stopped", mode: "launchd", reason: "The Gateway did not answer" }}
        helper={undefined}
      />,
    );
    expect(screen.queryByText("I put my data back myself")).toBeNull();
    rerender(
      <StartupSplash
        platform={platform()}
        status={connecting}
        run={{ kind: "stopped", mode: "launchd", reason: "x", restoreInterrupted: true }}
        helper={undefined}
      />,
    );
    expect(screen.queryByText("I put my data back myself")).toBeNull();
  });
});
