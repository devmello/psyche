import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The production bus factory reads no environment (a same-user process can set variables for a
 * user service), while the test-only constructor takes its address from the caller.
 */

const opened: string[] = [];

vi.mock("dbus-next", () => ({
  sessionBus: (opts: { busAddress: string }) => {
    opened.push(opts.busAddress);
    return { on: () => undefined, disconnect: () => undefined };
  },
  Message: class {},
  Variant: class {},
}));

const { presenceBusAt, SYSTEM_BUS_ADDRESS, systemPresenceBus } = await import(
  "../src/compose/password-presence.ts"
);

const FAKE = "unix:path=/tmp/evil-bus";

afterEach(() => {
  opened.length = 0;
  vi.unstubAllEnvs();
});

describe("the system bus address", () => {
  it("is the fixed socket", () => {
    expect(SYSTEM_BUS_ADDRESS).toBe("unix:path=/run/dbus/system_bus_socket");
  });

  it("is used by the production factory whatever the environment says", async () => {
    vi.stubEnv("DBUS_SYSTEM_BUS_ADDRESS", FAKE);
    vi.stubEnv("PSYCHE_TEST_SYSTEM_BUS", "1");
    const bus = await systemPresenceBus();
    bus.close();
    expect(opened).toEqual(["unix:path=/run/dbus/system_bus_socket"]);
  });

  it("is chosen by the caller only in the test-only constructor", async () => {
    vi.stubEnv("DBUS_SYSTEM_BUS_ADDRESS", "unix:path=/tmp/other");
    const bus = await presenceBusAt(FAKE)();
    bus.close();
    expect(opened).toEqual([FAKE]);
  });

  it("is never read from process.env by the production module", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL("../src/compose/password-presence.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toMatch(/process\.env|PSYCHE_TEST_SYSTEM_BUS|DBUS_SYSTEM_BUS_ADDRESS\s*[=!?]/);
  });
});
