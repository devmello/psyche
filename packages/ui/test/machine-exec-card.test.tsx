import type { ApprovalRequest } from "@psyche/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalDetails } from "../src/blocks/approval-details.tsx";

/**
 * A command on a paired machine (H5, review r1 D1/D3): the card says how the box runs it
 * (contained or on the full account), whether it has the network, and whether a read-only folder
 * holds, never "on your Mac".
 */

const card = (details: Record<string, unknown>): ApprovalRequest =>
  ({
    id: "ap_1",
    kind: "exec_host",
    summary: "Run `make` on lab-box",
    details: {
      onMachine: true,
      machine: { deviceId: "dev_a", name: "lab-box" },
      argv: ["make"],
      cwd: "/home/dev/proj",
      env: [],
      executable: "/usr/bin/make",
      executableSha256: `sha256:${"a".repeat(64)}`,
      folder: "/home/dev/proj",
      ...details,
    },
    surfaces: ["desktop"],
    status: "pending",
  }) as unknown as ApprovalRequest;

afterEach(cleanup);

describe("a machine command's card", () => {
  it("contained, network off, read-only folder: says so and nothing about the Mac", () => {
    render(
      <ApprovalDetails approval={card({ contained: true, network: "off", folderMode: "ro" })} />,
    );
    expect(screen.getByText(/contained, in the granted folder only/)).toBeTruthy();
    expect(screen.getByText("off")).toBeTruthy();
    expect(screen.getByText("/home/dev/proj, read-only")).toBeTruthy();
    expect(screen.queryByText(/your Mac/)).toBeNull();
    expect(screen.queryByText(/sha256:/)).toBeNull();
  });

  it("full account: says so, the network is on, and read-only is not enforced", () => {
    render(
      <ApprovalDetails approval={card({ contained: false, network: "on", folderMode: "ro" })} />,
    );
    expect(screen.getByText(/^on the full account: it can do anything/)).toBeTruthy();
    expect(screen.getByText("on")).toBeTruthy();
    expect(screen.getByText(/read-only is not enforced on the full account/)).toBeTruthy();
  });
});
