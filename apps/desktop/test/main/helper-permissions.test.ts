import { describe, expect, it } from "vitest";
import { createHelperPermissions } from "../../src/main/permissions/helper-permissions.ts";

type Row = { permission: string; status: string };

/** A helper whose `permissions.status` answers `rows()`; `onRequest` runs when it is asked. */
function helper(
  rows: () => Row[] | "offline",
  onRequest: () => void = () => undefined,
  notify: () => string = () => "notDetermined",
) {
  const calls: [string, unknown][] = [];
  const invoke = async (capability: string, params: unknown) => {
    calls.push([capability, params]);
    const r = rows();
    if (r === "offline") throw new Error("the Psyche helper is not running");
    if (capability === "permissions.request") onRequest();
    if (capability === "permissions.status") return { permissions: r };
    if (capability === "notify.authorization_status") return { authorization: notify() };
    return { status: "prompted" };
  };
  return { calls, perms: createHelperPermissions({ invoke }) };
}

describe("helper permissions (Settings → Computer use)", () => {
  it("reports what the helper has, not what Psyche.app has", async () => {
    const { perms } = helper(() => [
      { permission: "accessibility", status: "notDetermined" },
      { permission: "screenRecording", status: "granted" },
    ]);
    expect(await perms.status()).toEqual({
      helper: "online",
      accessibility: "not_determined",
      screenRecording: "granted",
      notifications: "not_determined",
    });
  });

  it("says offline instead of granted when the helper is not connected", async () => {
    const { perms, calls } = helper(() => "offline");
    expect(await perms.status()).toEqual({
      helper: "offline",
      accessibility: "not_determined",
      screenRecording: "not_determined",
      notifications: "not_determined",
    });
    // An offline helper is not asked and no pane opens.
    expect((await perms.request("accessibility")).helper).toBe("offline");
    expect(calls.map((c) => c[0])).toEqual(["permissions.status", "permissions.status"]);
  });

  it("treats a missing row as not granted", async () => {
    const { perms } = helper(() => []);
    expect(await perms.status()).toMatchObject({
      helper: "online",
      accessibility: "not_determined",
      screenRecording: "not_determined",
    });
  });

  it("asks through the helper, then opens its pane while still not granted", async () => {
    const { perms, calls } = helper(() => [
      { permission: "accessibility", status: "notDetermined" },
    ]);
    const after = await perms.request("accessibility");
    expect(after.accessibility).toBe("not_determined");
    expect(calls.map((c) => c[0])).toEqual([
      "permissions.status",
      "notify.authorization_status",
      "permissions.request",
      "permissions.status",
      "notify.authorization_status",
      "permissions.open_settings",
    ]);
    expect(calls[2]?.[1]).toEqual({ permission: "accessibility" });
    expect(calls[5]?.[1]).toEqual({ permission: "accessibility" });
  });

  it("sends the helper's vision_fallback purpose for Screen Recording, and opens no pane once granted", async () => {
    let granted = false;
    const { perms, calls } = helper(
      () => [{ permission: "screenRecording", status: granted ? "granted" : "notDetermined" }],
      () => {
        granted = true;
      },
    );
    const after = await perms.request("screenRecording");
    expect(after.screenRecording).toBe("granted");
    expect(calls.find((c) => c[0] === "permissions.request")?.[1]).toEqual({
      permission: "screenRecording",
      purpose: "vision_fallback",
    });
    expect(calls.some((c) => c[0] === "permissions.open_settings")).toBe(false);
  });

  it("reads notifications from the helper's notify status, and asks for the explicit prompt", async () => {
    let granted = false;
    const { perms, calls } = helper(
      () => [],
      () => undefined,
      () => (granted ? "authorized" : "notDetermined"),
    );
    expect((await perms.status()).notifications).toBe("not_determined");
    granted = true;
    expect((await perms.status()).notifications).toBe("granted");
    granted = false;
    const after = await perms.request("notifications");
    expect(after.notifications).toBe("not_determined");
    // Never the provisional (quiet) request, and the pane opens while it is still not allowed.
    expect(calls.find((c) => c[0] === "notify.request_authorization")?.[1]).toEqual({
      provisional: false,
    });
    expect(calls.some((c) => c[0] === "permissions.request")).toBe(false);
    expect(calls.at(-1)).toEqual(["permissions.open_settings", { permission: "notifications" }]);
  });

  it("a denied notification state reads as denied", async () => {
    const { perms } = helper(
      () => [],
      () => undefined,
      () => "denied",
    );
    expect((await perms.status()).notifications).toBe("denied");
  });
});
