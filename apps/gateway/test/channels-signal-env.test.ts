import { describe, expect, it } from "vitest";
import { channelsSetupFromEnv, signalSetupFromEnv } from "../src/compose/channels.ts";

const noFile = (): string => {
  throw new Error("no file");
};

describe("channelsSetupFromEnv: Signal (N7)", () => {
  it("is off unless configured", () => {
    expect(channelsSetupFromEnv({}, noFile).signal).toBeUndefined();
  });

  it("is on with both the socket and the number", () => {
    expect(
      channelsSetupFromEnv(
        {
          PSYCHE_SIGNAL_SOCKET: "/run/user/1000/signal-cli/socket",
          PSYCHE_SIGNAL_NUMBER: "+15550009999",
        },
        noFile,
      ).signal,
    ).toEqual({ socketPath: "/run/user/1000/signal-cli/socket", account: "+15550009999" });
  });

  it("one without the other stops boot", () => {
    expect(() => signalSetupFromEnv({ PSYCHE_SIGNAL_SOCKET: "/tmp/s.sock" })).toThrow(
      /PSYCHE_SIGNAL_NUMBER/,
    );
    expect(() => signalSetupFromEnv({ PSYCHE_SIGNAL_NUMBER: "+15550009999" })).toThrow(
      /PSYCHE_SIGNAL_SOCKET/,
    );
  });

  it("requires an E.164 number and an absolute socket path", () => {
    expect(() =>
      signalSetupFromEnv({ PSYCHE_SIGNAL_SOCKET: "/tmp/s.sock", PSYCHE_SIGNAL_NUMBER: "5551234" }),
    ).toThrow(/E\.164/);
    expect(() =>
      signalSetupFromEnv({ PSYCHE_SIGNAL_SOCKET: "s.sock", PSYCHE_SIGNAL_NUMBER: "+15550009999" }),
    ).toThrow(/absolute/);
  });
});
