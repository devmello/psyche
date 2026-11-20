import { describe, expect, it } from "vitest";
import {
  checkForVerifiedUpdate,
  DEFAULT_FEED,
  feedForChannel,
  RELEASE_CHANNELS,
  UPDATE_CHANNEL_KEY,
} from "../../src/main/update-flow.ts";
import { readUpdateChannel } from "../../src/main/updater.ts";

/**
 * The release channel only picks a feed. The pipeline publishes no beta manifest, so Stable is the
 * only channel, and any other stored value reads the stable feed. Verification is unchanged.
 */

describe("release channel", () => {
  it("has stable only, on the pinned latest feed", () => {
    expect(RELEASE_CHANNELS).toEqual(["stable"]);
    expect(UPDATE_CHANNEL_KEY).toBe("updates.channel");
    expect(feedForChannel("stable")).toBe(DEFAULT_FEED);
  });

  it("reads the stable feed for anything else, a saved beta included", () => {
    for (const v of ["beta", "nightly", "", undefined, null, 3, {}, "__proto__", "constructor"]) {
      expect(feedForChannel(v), String(v)).toBe(DEFAULT_FEED);
    }
  });

  it("a channel never skips the key check: no key embedded means no update", async () => {
    const fetched: string[] = [];
    const result = await checkForVerifiedUpdate({
      fetch: ((url: string) => {
        fetched.push(String(url));
        return Promise.reject(new Error("no network in tests"));
      }) as unknown as typeof fetch,
      currentVersion: "1.0.0",
      arch: "arm64",
      keys: [],
      feed: feedForChannel("beta"),
      dir: "/nonexistent",
      log: () => undefined,
    });
    expect(result.state).toBe("no_keys");
    expect(fetched).toEqual([]);
  });

  it("readUpdateChannel returns the saved value and falls back when the Gateway is unreachable", async () => {
    expect(
      await readUpdateChannel(async (method, params) => {
        expect(method).toBe("settings.get");
        expect(params).toEqual({ keys: ["updates.channel"] });
        return { settings: { "updates.channel": "stable" } };
      }),
    ).toBe("stable");
    expect(
      await readUpdateChannel(() => {
        throw new Error("not paired");
      }),
    ).toBeUndefined();
    expect(await readUpdateChannel(async () => Promise.reject(new Error("down")))).toBeUndefined();
  });
});
