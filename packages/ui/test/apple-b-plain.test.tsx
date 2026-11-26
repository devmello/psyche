import type { ApprovalRequest, TaskStatus } from "@psyche/protocol";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApprovalCard } from "../src/blocks/ApprovalCard.tsx";
import { plainReason, plainTitle } from "../src/blocks/approval-plain.ts";
import { TaskStatusIcon } from "../src/blocks/TaskCard.tsx";
import {
  plainToolLine,
  spokenAction,
  summarizeRun,
  ToolCallRow,
  ToolRun,
} from "../src/blocks/ToolRun.tsx";
import { createFixtureWorld, FIXTURE_NOW, IDS } from "../src/fixtures/index.ts";

/**
 * Apple-design batch B: the approval card and tool rows in plain words, pending without amber.
 * Each "stays as sent" case is paired with one that does change.
 */

const NOW = Date.parse(FIXTURE_NOW);

function exec(details: Record<string, unknown>): ApprovalRequest {
  const base = createFixtureWorld().approvals.find((a) => a.kind === "exec");
  if (!base) throw new Error("no exec approval fixture");
  return {
    ...base,
    status: "pending",
    requestedBy: { ...base.requestedBy, agent: "Wren" },
    details: { ...base.details, ...details },
  } as ApprovalRequest;
}

describe("plainTitle", () => {
  it("says who wants to run what and where, folder by its name", () => {
    expect(plainTitle(exec({}), "Wren")).toBe("Wren wants to run `npm install` in psyche.");
  });

  it("leaves a long command and a paired machine's command to the Gateway summary", () => {
    const long = exec({ argv: ["echo", "x".repeat(200)] });
    expect(plainTitle(long, "Wren")).toBeNull();
    expect(plainTitle(exec({ onMachine: true }), "Wren")).toBeNull();
  });

  it("names a file save by its file and folder, create or change", () => {
    const save = {
      kind: "file_write",
      details: { path: "~/Documents/Taxes/letter.md", mode: "create" },
    } as const;
    expect(plainTitle(save as never, "Wren")).toBe("Wren wants to save letter.md in Taxes.");
    const edit = { ...save, details: { ...save.details, mode: "overwrite" } };
    expect(plainTitle(edit as never, "Wren")).toBe("Wren wants to change letter.md in Taxes.");
  });
});

describe("plainReason", () => {
  const mapped: [string, RegExp][] = [
    ["balanced mode; exec always asks", /^You asked to approve commands before they run\.$/],
    ["pushes always ask", /Publishing your work always needs your OK/],
    ["user ask rule", /You set a rule to ask first/],
    ["balanced mode; write outside the workspace", /outside the folder Psyche works in/],
    ["balanced mode; protected memory files always ask", /protected/],
    ["a command on this Mac in a tainted turn", /read something from outside/],
  ];
  it.each(mapped)("maps %s", (reason, plain) => {
    expect(plainReason(reason)).toMatch(plain);
    expect(plainReason(reason)).not.toMatch(/\bexec\b|tainted|\bask rule\b/);
  });

  it("returns null for a reason with no mapping, and for near misses", () => {
    expect(plainReason("the form posts to https://x.test")).toBeNull();
    expect(plainReason("exec asks about something else")).toBeNull();
    expect(plainReason("pushes ask")).toBeNull();
  });
});

describe("the approval card in plain words", () => {
  const show = (a: ApprovalRequest) =>
    render(
      <ApprovalCard
        approval={a}
        canAnswer
        persona="Wren"
        now={NOW}
        armDelayMs={0}
        onAnswer={vi.fn()}
      />,
    );

  it("heads a command with one sentence, folds the table under Details and explains why plainly", () => {
    const { container } = show(exec({}));
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(
      "Wren wants to run `npm install` in psyche.",
    );
    const fold = screen.getByTestId("approval-details-fold");
    expect(fold.tagName).toBe("DETAILS");
    expect((fold as HTMLDetailsElement).open).toBe(false);
    expect(within(fold).getByText("Details")).toBeTruthy();
    expect(within(fold).getByText("Folder")).toBeTruthy();
    expect(container.textContent).toContain("You asked to approve commands before they run.");
    expect(container.textContent).not.toContain("exec always asks");
    expect(container.textContent).not.toContain("Run command in sandbox");
  });

  it("keeps the rows open and the summary as the heading for a command too long to quote", () => {
    show(exec({ argv: ["echo", "x".repeat(200)] }));
    expect(screen.queryByTestId("approval-details-fold")).toBeNull();
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(
      "Run `npm install` in ~/Projects/psyche",
    );
  });

  it("shows the label neutral while pending, and keeps the one amber hairline", () => {
    const { container } = show(exec({}));
    const label = screen.getByText("Approval needed");
    expect(label.className).toContain("text-label-secondary");
    expect(label.className).not.toContain("approval");
    expect(container.querySelector("fieldset")?.className).toContain("border-approval-border");
  });
});

describe("tool rows in plain words", () => {
  const item = (tool: string, level1: string, params?: Record<string, unknown>, status = "ok") =>
    ({
      block: { type: "tool_call", toolCallId: "tc", tool, status, level1 },
      call: params
        ? { paramsRedacted: params, startedAt: FIXTURE_NOW, endedAt: FIXTURE_NOW }
        : null,
    }) as never;

  it("names a save by file and folder, and cuts other paths to the file name", () => {
    const save = item("write.file", "Write ~/Documents/Taxes/letter-to-tax-office.md", {
      path: "~/Documents/Taxes/letter-to-tax-office.md",
    });
    expect(plainToolLine(save)).toBe("Save letter-to-tax-office.md in Taxes");
    expect(plainToolLine(item("read.file", "Read ~/Documents/Taxes/notes.md"))).toBe(
      "Read notes.md",
    );
    // Control: a line with no path is untouched.
    expect(plainToolLine(item("gmail.send", "Sent to jane"))).toBe("Sent to jane");
  });

  it("speaks an action, not the tool's family, and folds families into plain nouns", () => {
    expect(spokenAction("exec.run")).toBe("Ran a command");
    expect(spokenAction("write.file")).toBe("Saved a file");
    expect(spokenAction("mcp__notion__create")).toBe("Used a tool");
    const runs = [
      item("exec.run", "Run it"),
      item("write.file", "Save it"),
      item("mcp__notion__x", "Add"),
    ];
    expect(summarizeRun(runs)).toBe("3 actions · commands, files, notion");
    render(<ToolCallRow item={item("exec.run", "Run it")} />);
    expect(screen.getByText("Ran a command:")).toBeTruthy();
    expect(screen.queryByText("exec:")).toBeNull();
  });

  it("shows a waiting call as a neutral ring, never the amber clock", () => {
    const { container } = render(
      <ToolRun items={[item("write.file", "Save it", undefined, "pending")]} />,
    );
    expect(container.querySelector("[data-waiting='true']")).not.toBeNull();
    expect(container.querySelector("[data-testid='rail-node']")).toBeNull();
    expect(container.querySelector("[data-status='pending']")).not.toBeNull();
    expect(container.innerHTML).not.toContain("approval");
  });
});

describe("the task icon", () => {
  const cls = (s: TaskStatus) =>
    render(<TaskStatusIcon status={s} />)
      .container.querySelector("svg")
      ?.getAttribute("class") ?? "";
  it("keeps a queued task neutral, a running one ink, and amber only for a task that needs you", () => {
    expect(cls("queued")).toContain("text-label-tertiary");
    expect(cls("queued")).not.toContain("animate-spin");
    expect(cls("running")).toContain("text-accent-11");
    expect(cls("awaiting_approval")).toContain("text-approval-text");
  });
});

void IDS;
