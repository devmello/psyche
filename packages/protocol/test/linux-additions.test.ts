import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  ComputerSurface,
  ErrorCode,
  Methods,
  NodeKind,
  OsPermission,
  PROTOCOL_VERSION,
  PresenceAssertionSchema,
  PsycheError,
  VSCREEN_CAPABILITIES,
  VscreenFrame,
  VscreenInputParams,
  VscreenStatus,
} from "../src/index.ts";

describe("linux desktop additions (L0)", () => {
  it("keeps protocolVersion", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it("accepts the new enum values and keeps the old ones", () => {
    for (const k of ["mac-helper", "vm-guest", "remote", "phone", "host-helper", "guest"]) {
      expect(Value.Check(NodeKind, k)).toBe(true);
    }
    for (const s of ["direct", "virtual_screen", "separate_desktop"]) {
      expect(Value.Check(ComputerSurface, s)).toBe(true);
    }
    expect(Value.Check(ComputerSurface, "other")).toBe(false);
    for (const p of ["a11yBus", "screenCastPortal", "remoteDesktopPortal", "x11"]) {
      expect(Value.Check(OsPermission, p)).toBe(true);
    }
    const presence = (kind: string) => ({ kind, deviceId: "dev_1", signature: "c2ln" });
    for (const k of ["webauthn", "helper", "password"]) {
      expect(Value.Check(PresenceAssertionSchema, presence(k))).toBe(true);
    }
  });

  it("has the four presence error codes", () => {
    for (const c of [
      "presence_unavailable_here",
      "presence_agent_missing",
      "presence_policy_missing",
      "presence_not_enforced",
    ] as const) {
      expect(Value.Check(ErrorCode, c)).toBe(true);
      expect(new PsycheError(c, "x").code).toBe(c);
    }
  });

  it("registers approvals.approveWithPassword and devices.presence.status", () => {
    expect(Methods["approvals.approveWithPassword"].scope).toBe("operator.approvals");
    expect(Methods["devices.presence.status"].scope).toBe("operator.admin");
    expect(
      Value.Check(Methods["approvals.approveWithPassword"].params, {
        approvalId: "apr_1",
        answerToken: "t",
      }),
    ).toBe(true);
    expect(
      Value.Check(Methods["devices.presence.status"].result, {
        verifiers: [
          { kind: "password", state: "agent_missing", detail: "No polkit agent" },
          { kind: "touch_id_key", state: "ready" },
        ],
      }),
    ).toBe(true);
  });

  it("describes the vscreen shapes", () => {
    expect(VSCREEN_CAPABILITIES).toContain("vscreen.frame");
    expect(
      Value.Check(VscreenStatus, {
        state: "running",
        display: ":90",
        width: 1280,
        height: 800,
        apps: [{ appId: "firefox", pid: 12, windowTitle: null }],
        takenOver: false,
        frameSeq: 3,
        startedAt: "2026-11-05T00:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      Value.Check(VscreenFrame, { changed: false, frameSeq: 3, image: null, width: 0, height: 0 }),
    ).toBe(true);
    expect(
      Value.Check(VscreenInputParams, { events: [{ type: "down", x: 1, y: 2, button: "left" }] }),
    ).toBe(true);
  });
});
