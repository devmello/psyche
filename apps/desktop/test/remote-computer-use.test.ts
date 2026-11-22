import { describe, expect, it } from "vitest";
import { IPC, REMOTE_REFUSED_CHANNELS } from "../src/lib/ipc.ts";

/**
 * B3 (linux-helper-only design §7.4): a Client may start and watch computer use on a remote
 * Linux Host's private screen, because it runs on the Host (G5 holds). The watch pane talks to
 * the Gateway over the window's own connection (`computerWatch.*`), so main has nothing to open
 * for it. Direct computer use stays off from a Client (the R1 gate): main still refuses every
 * channel that would reach this computer's own helper, permissions or presence.
 */
describe("computer use from a remote window", () => {
  it("keeps the R1 gate for direct: this computer's helper and permissions stay refused", () => {
    for (const channel of [
      IPC.helperLaunch,
      IPC.permissionsRequest,
      IPC.touchIdApprove,
      IPC.passwordApprove,
      IPC.teachAppStart,
    ]) {
      expect(REMOTE_REFUSED_CHANNELS.has(channel)).toBe(true);
    }
  });

  it("has no local channel for the private screen: the watch goes over the Gateway connection", () => {
    const channels = Object.values(IPC) as string[];
    expect(channels.some((c) => /vscreen|computerWatch|computer-watch/i.test(c))).toBe(false);
    expect(REMOTE_REFUSED_CHANNELS.has(IPC.call)).toBe(false);
  });
});
