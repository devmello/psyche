import { describe, expect, it } from "vitest";
import { SystemZone } from "../src/compose/time-zone.ts";

/** A fake environment where deleting `TZ` makes the system zone show again, as in Node. */
function fakeNode(system: { zone: string }, env: Record<string, string | undefined>) {
  return { env, current: () => env.TZ ?? system.zone };
}

describe("SystemZone", () => {
  it("notices a new system zone on refresh and reports it once", () => {
    const system = { zone: "America/Los_Angeles" };
    const env: Record<string, string | undefined> = {};
    const z = new SystemZone(fakeNode(system, env));
    expect(z.zone).toBe("America/Los_Angeles");
    expect(z.refresh()).toMatchObject({ changed: false, zone: "America/Los_Angeles" });
    system.zone = "Europe/Berlin";
    expect(z.refresh()).toEqual({
      changed: true,
      zone: "Europe/Berlin",
      previous: "America/Los_Angeles",
    });
    expect(z.zone).toBe("Europe/Berlin");
    expect(z.refresh().changed).toBe(false);
  });

  it("forgets a zone Node cached by deleting TZ, the way Node re-detects it", () => {
    const system = { zone: "Asia/Tokyo" };
    const env: Record<string, string | undefined> = {};
    const z = new SystemZone(fakeNode(system, env));
    // Something set TZ after start (it was not set at start, so it is not the owner's choice).
    env.TZ = "Asia/Tokyo";
    system.zone = "America/New_York";
    expect(z.refresh().zone).toBe("America/New_York");
    expect(env.TZ).toBeUndefined();
  });

  it("a zone the process was started with is the owner's choice and is left alone", () => {
    const system = { zone: "America/New_York" };
    const env: Record<string, string | undefined> = { TZ: "Europe/London" };
    const z = new SystemZone(fakeNode(system, env));
    system.zone = "Asia/Tokyo";
    expect(z.refresh()).toMatchObject({ changed: false, zone: "Europe/London" });
    expect(env.TZ).toBe("Europe/London");
  });

  it("an empty TZ (UTC) counts as set and is never deleted", () => {
    const system = { zone: "America/New_York" };
    const env: Record<string, string | undefined> = { TZ: "" };
    const z = new SystemZone({
      env,
      current: () => (env.TZ === "" ? "UTC" : (env.TZ ?? system.zone)),
    });
    system.zone = "Asia/Tokyo";
    expect(z.refresh()).toMatchObject({ changed: false, zone: "UTC" });
    expect(env.TZ).toBe("");
  });

  it("with Node itself: setting then deleting TZ re-detects the zone", () => {
    const saved = process.env.TZ;
    try {
      delete process.env.TZ;
      const z = new SystemZone();
      const home = z.zone;
      process.env.TZ = home === "Asia/Tokyo" ? "Europe/Paris" : "Asia/Tokyo";
      // Node follows the assignment at once: that is the cache the Gateway must reset.
      expect(Intl.DateTimeFormat().resolvedOptions().timeZone).not.toBe(home);
      const r = z.refresh();
      expect(r.zone).toBe(home);
      expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(home);
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });
});
