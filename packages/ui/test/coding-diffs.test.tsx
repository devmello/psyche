import type { ApprovalRequest, Receipt } from "@psyche/protocol";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ApprovalDetails } from "../src/blocks/approval-details.tsx";
import { DiffBlock, diffMarkdown } from "../src/blocks/DiffBlock.tsx";
import { ToolCallRow } from "../src/blocks/ToolRun.tsx";

/** V10: the coding helper's diffs in the kit's code block; git cards show their binding. */

const PATCH =
  "--- a/src/add.js\n+++ b/src/add.js\n@@ -1,3 +1,3 @@\n export function add(a, b) {\n-  return a - b;\n+  return a + b;\n }\n";

describe("DiffBlock", () => {
  it("fences a diff so its own backticks never close the block, and counts cut lines", () => {
    const md = diffMarkdown("+ ```js\n+ x\n+ ```");
    expect(md.startsWith("````diff\n")).toBe(true);
    expect(md.endsWith("\n````")).toBe(true);
    const long = Array.from({ length: 10 }, (_, i) => `+${i}`).join("\n");
    expect(diffMarkdown(long, 4).split("\n").slice(-2)).toEqual(["… 6 more lines", "```"]);
  });

  it("renders the diff text as code, not markdown", async () => {
    const { container } = render(<DiffBlock diff={"+ **bold** [x](https://evil.example)\n"} />);
    await waitFor(() => expect(container.textContent).toContain("**bold**"));
    expect(container.querySelector("a")).toBeNull();
  });
});

describe("tool rows with a change", () => {
  it("offers the receipt's diff under the row", async () => {
    const receipt = {
      id: "rcp_1",
      kind: "file_write",
      taskId: null,
      toolCallId: "tc1",
      approvalId: null,
      outcome: "ok",
      summary: "Edited 1 file(s) in repo (+1 −1)",
      externalRefs: {},
      payload: { diff: PATCH },
      createdAt: "2026-10-19T15:30:00.000Z",
    } as Receipt;
    const item = {
      block: {
        type: "tool_call" as const,
        toolCallId: "tc1",
        tool: "code.edit",
        status: "ok" as const,
        level1: "Edited 1 file(s) in repo (+1 −1)",
      },
      receipt,
    };
    const { container } = render(<ToolCallRow item={item} />);
    await userEvent.click(screen.getByText("View diff"));
    await waitFor(() => expect(container.textContent).toContain("+  return a + b;"));
    const none = render(<ToolCallRow item={{ ...item, receipt: { ...receipt, payload: null } }} />);
    expect(none.container.textContent).not.toContain("View diff");
  });
});

describe("git approval details", () => {
  const base = {
    id: "apr_1",
    summary: "",
    bindingHash: "sha256:x",
    grantKey: null,
    scopesOffered: ["once"],
    deviceOnly: false,
    requiresAuthentication: false,
    taint: true,
    status: "pending",
    requestedAt: "2026-10-19T15:30:00.000Z",
    expiresAt: "2026-10-19T15:45:00.000Z",
    surfaces: ["desktop"],
    sideEffect: "write",
    requestedBy: { runId: "run_1", taskId: null, threadId: "thr_1", toolCallId: "c1" },
  };

  it("shows a push's remote, URL, branch and full commit as rows", () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const a = {
      ...base,
      kind: "git_push",
      details: {
        remote: "origin",
        remoteUrl: "git@github.com:avery/app.git",
        branch: "main",
        commit,
        repo: "/Users/o/app",
      },
    } as unknown as ApprovalRequest;
    const { container } = render(<ApprovalDetails approval={a} />);
    const text = container.textContent ?? "";
    for (const v of ["origin", "git@github.com:avery/app.git", "main", commit, "never"]) {
      expect(text).toContain(v);
    }
  });

  it("shows a commit's message and paths", () => {
    const a = {
      ...base,
      kind: "git_write",
      details: { repo: "/Users/o/app", operation: "commit", message: "Fix add()", paths: ["."] },
    } as unknown as ApprovalRequest;
    const { container } = render(<ApprovalDetails approval={a} />);
    expect(container.textContent).toContain("Fix add()");
  });
});
