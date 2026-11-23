import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  execReviewInAuto,
  policyWithExecReview,
} from "../src/screens/settings/FileAccessSection.tsx";
import { PermissionsPanel } from "../src/screens/settings/PermissionsSection.tsx";

/**
 * Settings → Permissions: "Let a reviewer approve safe terminal commands in Auto mode" (owner's
 * decision 2026-11-23), on by default, stored as `permissions.policy.exec.reviewInAuto`.
 */

const NAME = "Let a reviewer approve safe terminal commands in Auto mode";

function panel(values: Record<string, unknown>) {
  const onChange = vi.fn();
  render(<PermissionsPanel values={values} onChange={onChange} connectors={[]} grants={[]} />);
  return onChange;
}

describe("the exec reviewer switch", () => {
  it("is on by default and says each review is a small Haiku call on the owner's key", () => {
    panel({});
    const sw = screen.getByRole("switch", { name: NAME });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(/small Haiku call on your key/)).toBeTruthy();
  });

  it("turning it off writes exec.reviewInAuto false and keeps the rest of the policy", async () => {
    const policy = { exec: { execHostEnabled: true }, folders: [{ path: "/w", mode: "rw" }] };
    const onChange = panel({ "permissions.policy": policy });
    await userEvent.click(screen.getByRole("switch", { name: NAME }));
    expect(onChange).toHaveBeenCalledWith("permissions.policy", {
      ...policy,
      exec: { execHostEnabled: true, reviewInAuto: false },
    });
  });

  it("reads off only for exactly false", () => {
    expect(execReviewInAuto({})).toBe(true);
    expect(execReviewInAuto({ "permissions.policy": { exec: { reviewInAuto: false } } })).toBe(
      false,
    );
    expect(execReviewInAuto({ "permissions.policy": { exec: { reviewInAuto: true } } })).toBe(true);
    expect(policyWithExecReview({}, true)).toEqual({ exec: { reviewInAuto: true } });
  });
});
