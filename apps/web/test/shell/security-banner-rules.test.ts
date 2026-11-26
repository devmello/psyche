import type { SecurityAlert, SecurityStateStatus } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { securityBannerView } from "../../src/shell/components/security-banner-rules.ts";

const alert = (kind: SecurityAlert["kind"], details: SecurityAlert["details"] = {}) =>
  ({
    id: kind,
    kind,
    severity: "warning",
    details,
    createdAt: "2026-11-05T10:00:00.000Z",
    acknowledgedAt: null,
  }) as SecurityAlert;

const state = (alerts: SecurityAlert[], extra: Partial<SecurityStateStatus> = {}) =>
  ({ status: "sealed", reason: null, alerts, recoveries: [], ...extra }) as SecurityStateStatus;

describe("securityBannerView", () => {
  it.each([
    ["first seal", alert("state_first_seal", { devices: 1 })],
    ["routine re-seal", alert("state_resealed", { restored: false })],
    ["re-seal without a flag", alert("state_resealed")],
  ])("does not raise a banner for the %s", (_n, a) => {
    expect(securityBannerView(state([a])).show).toBe(false);
  });

  it.each([
    ["outside change", alert("state_changed_outside", { changes: [] })],
    ["untrusted seal alert", alert("state_untrusted")],
    ["restore re-seal", alert("state_resealed", { restored: true })],
    ["first admin from the Mac", alert("local_first_admin")],
    ["recovery failed", alert("recovery_failed")],
  ])("still raises a banner for %s (positive control)", (_n, a) => {
    expect(securityBannerView(state([a])).show).toBe(true);
  });

  it("raises it for an untrusted status or a waiting recovery even with no alerts", () => {
    expect(securityBannerView(state([], { status: "untrusted" })).show).toBe(true);
    const waiting = {
      recoveries: [{ id: "r", status: "waiting", op: "seal.reset", notBefore: "x" }],
    } as unknown as Partial<SecurityStateStatus>;
    expect(securityBannerView(state([], waiting)).show).toBe(true);
  });

  it("a quiet alert next to a real one still counts the real one", () => {
    const v = securityBannerView(
      state([alert("state_first_seal"), alert("state_changed_outside")]),
    );
    expect(v.show).toBe(true);
    expect(v.openAlerts).toHaveLength(2);
  });
});
