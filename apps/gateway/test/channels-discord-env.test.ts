import { describe, expect, it } from "vitest";
import { channelsSetupFromEnv } from "../src/compose/channels.ts";

const noFile = (): string => {
  throw new Error("no file");
};

describe("channelsSetupFromEnv: Discord (N8)", () => {
  it("is off unless configured; the account alone reads the token from the vault", () => {
    expect(channelsSetupFromEnv({}, noFile).discord).toBeUndefined();
    expect(channelsSetupFromEnv({ PSYCHE_DISCORD_ACCOUNT: "psyche" }, noFile).discord).toEqual({
      account: "psyche",
    });
  });

  it("requires PSYCHE_DISCORD_ACCOUNT with a token", () => {
    expect(() => channelsSetupFromEnv({ PSYCHE_DISCORD_BOT_TOKEN: "tok" }, noFile)).toThrow(
      /PSYCHE_DISCORD_ACCOUNT/,
    );
  });

  it("reads the token file on each use, never exposing it in the setup", async () => {
    let contents = "first-token\n";
    const setup = channelsSetupFromEnv(
      { PSYCHE_DISCORD_BOT_TOKEN_FILE: "/run/secrets/discord", PSYCHE_DISCORD_ACCOUNT: "psyche" },
      () => contents,
    ).discord;
    expect(setup?.account).toBe("psyche");
    expect(JSON.stringify(setup)).not.toContain("first-token");
    expect(await setup?.token?.use(async (t) => t)).toBe("first-token");
    contents = "rotated";
    expect(await setup?.token?.use(async (t) => t)).toBe("rotated");
  });
});
