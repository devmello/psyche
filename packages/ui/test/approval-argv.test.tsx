import type { ApprovalRequest } from "@psyche/protocol";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApprovalDetails } from "../src/blocks/approval-details.tsx";

/** A tool server's command, and a shared connector about to be signed, show one argument per item. */

const card = (details: Record<string, unknown>): ApprovalRequest =>
  ({
    id: "ap_1",
    kind: "skill_install",
    summary: "x",
    details,
    surfaces: ["desktop"],
    status: "pending",
  }) as unknown as ApprovalRequest;

describe("command arguments on approval cards", () => {
  it("lists every argument of a server on its own, quoting those with spaces, nothing cut off", () => {
    const long = `--note=${"x".repeat(900)}`;
    render(
      <ApprovalDetails
        approval={card({
          kind: "mcp_server",
          id: "echo",
          command: "node server.mjs a b",
          argv: ["node", "server.mjs", "two words", long, "--last"],
        })}
      />,
    );
    const list = screen.getByRole("list");
    const items = within(list).getAllByRole("listitem");
    expect(items.map((i) => i.textContent)).toEqual([
      "node",
      "server.mjs",
      '"two words"',
      long,
      "--last",
    ]);
  });

  it("does the same for the connector about to be signed", () => {
    render(
      <ApprovalDetails
        approval={card({
          kind: "connector_export",
          serverId: "notes",
          command: "node s.mjs",
          argv: ["node", "s.mjs"],
          signAs: "Ada",
        })}
      />,
    );
    expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(2);
  });
});
