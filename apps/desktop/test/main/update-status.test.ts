import { describe, expect, it } from "vitest";
import {
  getUpdateStatus,
  onUpdateStatus,
  restartRefusal,
  setUpdateStatus,
  type UpdateStatus,
  updateStatusFromOutcome,
} from "../../src/main/update-status.ts";

const ready: UpdateStatus = { state: "ready", release: "0.4.0", mandatory: false };

describe("update status mapping (macOS, Squirrel)", () => {
  it("a verified update handed to Squirrel is checking until it is downloaded", () => {
    expect(updateStatusFromOutcome({ state: "started" })).toEqual({ state: "checking" });
  });

  it("up to date, or no manifest published, is none", () => {
    expect(updateStatusFromOutcome({ state: "none", reason: "up to date" })).toEqual({
      state: "none",
    });
  });

  it("a refused check carries its reason, else its code", () => {
    expect(
      updateStatusFromOutcome({ state: "refused", reason: "bad signature", code: "x" }),
    ).toEqual({
      state: "refused",
      reason: "bad signature",
      code: "x",
    });
    expect(updateStatusFromOutcome({ state: "refused", code: "bad_hash" })).toEqual({
      state: "refused",
      reason: "bad_hash",
      code: "bad_hash",
    });
  });
  it("off, unpackaged and keyless runs are idle, never an error", () => {
    expect(updateStatusFromOutcome({ state: "disabled" })).toEqual({ state: "idle" });
    expect(updateStatusFromOutcome({ state: "no_keys" })).toEqual({ state: "idle" });
  });
});

describe("the restart gate", () => {
  it("refuses unless a verified update is ready, whatever the status", () => {
    const notReady: UpdateStatus[] = [
      { state: "idle" },
      { state: "checking" },
      { state: "none" },
      { state: "refused", reason: "bad signature" },
    ];
    for (const s of notReady) {
      expect(restartRefusal("darwin", s)).toBe("no verified update is ready to install");
    }
  });

  it("refuses on every other platform, even with a ready update", () => {
    expect(restartRefusal("linux", ready)).toBe("Restart to update is only available on macOS");
    expect(restartRefusal("win32", ready)).toBe("Restart to update is only available on macOS");
  });

  it("allows the restart only on macOS with a ready update", () => {
    expect(restartRefusal("darwin", ready)).toBeUndefined();
  });
});

describe("status store", () => {
  it("keeps the current status and tells subscribers about each change", () => {
    const seen: UpdateStatus[] = [];
    const off = onUpdateStatus((s) => seen.push(s));
    setUpdateStatus({ state: "checking" });
    setUpdateStatus(ready);
    off();
    setUpdateStatus({ state: "none" });
    expect(seen).toEqual([{ state: "checking" }, ready]);
    expect(getUpdateStatus()).toEqual({ state: "none" });
    setUpdateStatus({ state: "idle" });
  });
});
