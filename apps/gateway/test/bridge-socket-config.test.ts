import { describe, expect, it } from "vitest";
import { bridgeSocketSetup } from "../src/compose/parts.ts";

/** The browser bridge honours PSYCHE_BROWSER_BRIDGE_SOCKET like the desktop shell does. */

describe("bridgeSocketSetup", () => {
  it("uses PSYCHE_BROWSER_BRIDGE_SOCKET when set", () => {
    expect(bridgeSocketSetup({ PSYCHE_BROWSER_BRIDGE_SOCKET: "/tmp/psy/bridge.sock" })).toEqual({
      socketPath: "/tmp/psy/bridge.sock",
    });
  });

  it("leaves the default ($PSYCHE_HOME/run/browser-bridge.sock) when unset or blank", () => {
    expect(bridgeSocketSetup({})).toEqual({});
    expect(bridgeSocketSetup({ PSYCHE_BROWSER_BRIDGE_SOCKET: "  " })).toEqual({});
  });
});
