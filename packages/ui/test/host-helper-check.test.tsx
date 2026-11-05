import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DevicesPanel } from "../src/screens/settings/DevicesSection.tsx";
import {
  HostHelperCheckGroup,
  parseHostHelperStatus,
  refusedText,
} from "../src/screens/settings/HostHelperCheckGroup.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

describe("Settings → Devices: the Linux helper check", () => {
  it("says a root-owned helper is verified", () => {
    render(<HostHelperCheckGroup status={{ peerCheck: "root_owned" }} />);
    expect(screen.getByTestId("host-helper-check-state").textContent).toContain(
      "Verified: installed system helper",
    );
  });

  it("says a helper from the home folder, or one that couldn't be checked, is unverified", () => {
    const { rerender } = render(<HostHelperCheckGroup status={{ peerCheck: "user_owned" }} />);
    expect(screen.getByTestId("host-helper-check-state").textContent).toContain(
      "Unverified: helper from your home folder",
    );
    rerender(<HostHelperCheckGroup status={{ peerCheck: "unverified" }} />);
    expect(screen.getByTestId("host-helper-check-state").textContent).toContain(
      "Unverified: Psyche couldn't check the helper",
    );
  });

  it("says why a helper was refused, in words", () => {
    render(
      <HostHelperCheckGroup
        status={{ refused: { peerCheck: "mismatch", reason: "loader_env" } }}
      />,
    );
    expect(screen.getByTestId("host-helper-check-refused").textContent).toBe(
      "Refused: it was started with a library path or a preloaded library",
    );
    expect(screen.queryByTestId("host-helper-check-state")).toBeNull();
  });

  it("has a sentence for every reason the Gateway gives, and a plain one for an unknown reason", () => {
    const reasons = [
      "not_helper",
      "user_binary",
      "loader_env",
      "foreign_mapping",
      "many_holders",
      "inherited_socket",
      "not_ready",
      "stopped_or_traced",
      "library_replaced",
      "binary_replaced",
      "root_owned_outside_package",
      "helper_writable",
      "dir_writable",
      "path_remounted",
      "other_namespace",
      "busy",
    ];
    for (const r of reasons) {
      expect(refusedText(r), r).not.toContain("couldn't verify");
      expect(refusedText(r), r).toMatch(/^Refused: /);
    }
    expect(refusedText("ss_ambiguous")).toBe("Refused: Psyche couldn't verify the helper");
    expect(refusedText("something_new")).toBe("Refused: Psyche couldn't verify the helper");
  });

  it("shows both the connected helper's check and a refusal of another process", () => {
    render(
      <HostHelperCheckGroup
        status={{
          peerCheck: "root_owned",
          refused: { peerCheck: "user_owned", reason: "user_binary" },
        }}
      />,
    );
    expect(screen.getByTestId("host-helper-check-state")).toBeTruthy();
    expect(screen.getByTestId("host-helper-check-refused").textContent).toContain(
      "outside the system install",
    );
  });

  it("reads the Gateway's setting defensively", () => {
    expect(parseHostHelperStatus(undefined)).toBeUndefined();
    expect(parseHostHelperStatus({ ambiguous: false, helpers: 0 })).toBeUndefined();
    expect(parseHostHelperStatus("x")).toBeUndefined();
    expect(
      parseHostHelperStatus({
        ambiguous: false,
        helpers: 1,
        peerCheck: "user_owned",
        peerCheckReason: "user_binary",
      }),
    ).toEqual({ peerCheck: "user_owned" });
    expect(
      parseHostHelperStatus({ refused: { peerCheck: "mismatch", reason: "not_helper", at: "x" } }),
    ).toEqual({ refused: { peerCheck: "mismatch", reason: "not_helper" } });
    expect(parseHostHelperStatus({ refused: { reason: 3 } })).toBeUndefined();
  });

  it("shows nothing on a Gateway that records no check (macOS, Windows)", () => {
    render(
      <StoryWorld>
        <DevicesPanel devices={[]} pairing={[]} nodes={[]} />
      </StoryWorld>,
    );
    expect(screen.queryByTestId("host-helper-check")).toBeNull();
  });

  it("is part of the devices panel when the Gateway records one", () => {
    render(
      <StoryWorld>
        <DevicesPanel
          devices={[]}
          pairing={[]}
          nodes={[]}
          hostHelperStatus={{ peerCheck: "root_owned" }}
        />
      </StoryWorld>,
    );
    expect(screen.getByTestId("host-helper-check")).toBeTruthy();
  });
});
