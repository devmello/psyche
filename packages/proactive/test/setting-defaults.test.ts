import { MAIL_MEETING_SETTING_DEFAULTS as D } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { DEFAULT_DIGEST_SCHEDULE, MAIL_WATCH_SCHEDULE } from "../src/index.ts";

/**
 * The defaults Settings → Mail & meetings shows (`MAIL_MEETING_SETTING_DEFAULTS`) are the ones
 * the jobs use when a key is unset. These are the jobs' own constants, so a change to either
 * side fails here instead of the page quietly showing a value the Gateway does not use.
 */
describe("mail and meeting setting defaults", () => {
  it("matches the mail check cadence while the owner is active", () => {
    expect(MAIL_WATCH_SCHEDULE).toBe(`PT${D["mail.poll.activeMin"]}M`);
  });

  it("matches the digest's default schedule (time and weekdays)", () => {
    const [h, m] = D["mail.digest.time"].split(":").map(Number);
    const days = D["mail.digest.days"] === "weekdays" ? "1-5" : "*";
    expect(DEFAULT_DIGEST_SCHEDULE).toBe(`${m} ${h} * * ${days}`);
  });
});
