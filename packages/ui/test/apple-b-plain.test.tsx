import type { ApprovalRequest, TaskStatus } from "@psyche/protocol";
import { cleanup, render, screen } from "@testing-library/react";
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

/** An approval as the Gateway sends it for `exec_host` (compose/exec-host.ts describeCall). */
function execHost(details: Record<string, unknown> = {}): ApprovalRequest {
  const base = createFixtureWorld().approvals.find((a) => a.kind === "exec");
  if (!base) throw new Error("no exec approval fixture");
  return {
    ...base,
    kind: "exec_host",
    status: "pending",
    requestedBy: { ...base.requestedBy, agent: "Wren" },
    details: {
      argv: ["git", "log"],
      cwd: "~/Projects/psyche",
      env: ["GIT_PAGER=sh -c evil-pager"],
      executable: "/usr/bin/git",
      allowedDomains: ["registry.example.org"],
      network: "proxy",
      ...details,
    },
  } as ApprovalRequest;
}

/** `code.run` (coding/tools.ts): sandbox cwd, the host repository in `repo`. */
const codeRun = (details: Record<string, unknown> = {}) =>
  ({
    ...execHost(),
    kind: "exec",
    details: {
      argv: ["pnpm", "test"],
      cwd: "/workspace/repo",
      network: "none",
      repo: "/Users/me/Projects/atlas",
      ...details,
    },
  }) as ApprovalRequest;

/** `code.edit` (coding/tools.ts): the repository root, every file, `operation: "patch"`. */
const codeEdit = () =>
  ({
    ...execHost(),
    kind: "file_write",
    summary: "Edit src/a.ts, .husky/pre-commit in psyche (+3 \u22120)",
    details: {
      path: "/Users/me/Projects/psyche",
      operation: "patch",
      files: ["src/a.ts", ".husky/pre-commit"],
    },
  }) as ApprovalRequest;

/** Not hidden: no ancestor is a closed `<details>` (jsdom's getByText sees closed content). */
function visible(el: Element): boolean {
  for (let n: Element | null = el; n; n = n.parentElement) {
    if (n.tagName === "DETAILS" && !(n as HTMLDetailsElement).open) {
      const inSummary = el.closest("summary")?.parentElement === n;
      if (!inSummary) return false;
    }
  }
  return true;
}

describe("plainTitle", () => {
  it("says who wants to run what and where, folder by its name", () => {
    expect(plainTitle(execHost(), "Wren")).toBe("Wren wants to run `git log` in psyche.");
  });

  it("names the host repository of a coding run, never the sandbox path", () => {
    expect(plainTitle(codeRun(), "Wren")).toBe("Wren wants to run `pnpm test` in atlas.");
    // No `repo` (a harness Bash card): no folder, never "repo".
    const noRepo = codeRun({ repo: undefined });
    expect(plainTitle(noRepo, "Wren")).toBe("Wren wants to run `pnpm test`.");
  });

  it("leaves a long command and a paired machine's command to the Gateway summary", () => {
    expect(plainTitle(execHost({ argv: ["echo", "x".repeat(200)] }), "Wren")).toBeNull();
    expect(plainTitle(execHost({ onMachine: true }), "Wren")).toBeNull();
  });

  it("names a file save by its file and folder, and leaves a patch to its summary", () => {
    const save = { kind: "file_write", details: { path: "~/Documents/Taxes/letter.md" } } as const;
    expect(plainTitle(save as never, "Wren")).toBe("Wren wants to change letter.md in Taxes.");
    const create = { ...save, details: { ...save.details, mode: "create" } };
    expect(plainTitle(create as never, "Wren")).toBe("Wren wants to save letter.md in Taxes.");
    expect(plainTitle(codeEdit(), "Wren")).toBeNull();
    const patchOnly = { kind: "file_write", details: { path: "/x/y", operation: "patch" } };
    expect(plainTitle(patchOnly as never, "Wren")).toBeNull();
  });
});

describe("plainReason", () => {
  const mapped: [string, RegExp][] = [
    [
      "read-only commands ask in this mode or with the setting off",
      /^You asked to approve commands before they run\.$/,
    ],
    ["pushes always ask", /Publishing your work always needs your OK/],
    ["user ask rule", /You set a rule to ask first/],
    ["protected memory files always ask", /protected/],
    ["a command on this Mac in a tainted turn", /read something from outside/],
  ];
  it.each(mapped)("maps %s", (reason, plain) => {
    expect(plainReason(reason)).toMatch(plain);
    expect(plainReason(reason)).not.toMatch(/\bexec\b|tainted|\bask rule\b/);
  });

  it("returns null for a reason with no mapping, and for near misses", () => {
    expect(plainReason("the form posts to https://x.test")).toBeNull();
    expect(plainReason("exec asks about something else")).toBeNull();
    expect(plainReason("exec always asks, and the form posts to https://x.test")).toBeNull();
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

  it("heads a command with one sentence and keeps every row visible", () => {
    const { container } = show(execHost());
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(
      "Wren wants to run `git log` in psyche.",
    );
    // The env value, the resolved program and the network are what the sentence leaves out.
    for (const text of [/GIT_PAGER=sh -c evil-pager/, /\/usr\/bin\/git/]) {
      const hit = screen.getAllByText(text);
      expect(hit.some(visible)).toBe(true);
    }
    expect(container.textContent).toContain("registry.example.org");
    expect(container.querySelector("details")).toBeNull();
    expect(container.textContent).not.toContain("Run command in sandbox");
  });

  it("names the host repository of a coding run and shows the sandbox path as a row", () => {
    const { container } = show(codeRun());
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(
      "Wren wants to run `pnpm test` in atlas.",
    );
    expect(container.textContent).toContain("/workspace/repo");
  });

  it("shows the Gateway summary naming the files for a patch, not a folder sentence", () => {
    show(codeEdit());
    const heading = screen.getByRole("heading", { level: 3 }).textContent ?? "";
    expect(heading).toContain("src/a.ts");
    expect(heading).not.toMatch(/wants to change psyche/);
  });

  it("keeps the Gateway's kind title when there is no sentence", () => {
    const { container } = show(codeEdit());
    expect(container.querySelector("[data-card-header]")?.textContent).toMatch(/^Write file · /);
    // Control: a plain sentence replaces the title.
    cleanup();
    const again = show(execHost());
    expect(again.container.querySelector("[data-card-header]")?.textContent).not.toMatch(
      /^Run command/,
    );
  });

  it("explains why in plain words when the engine's reason maps, as sent otherwise", () => {
    const mappedCard = execHost({
      reason: "read-only commands ask in this mode or with the setting off",
    });
    const { container } = show(mappedCard);
    expect(container.textContent).toContain("You asked to approve commands before they run.");
    cleanup();
    const raw = show(execHost({ reason: "the form posts to https://x.test" }));
    expect(raw.container.textContent).toContain("the form posts to https://x.test");
  });

  it("shows the label neutral while pending, and keeps the one amber hairline", () => {
    const { container } = show(execHost());
    const label = screen.getByText("Approval needed");
    expect(label.className).toContain("text-label-secondary");
    expect(label.className).not.toContain("approval");
    expect(container.querySelector("fieldset")?.className).toContain("border-approval-border");
  });

  it("lets a long unbroken command wrap inside the heading", () => {
    show(execHost({ argv: ["curl", "https://example.org/" + "a".repeat(90)] }));
    expect(screen.getByRole("heading", { level: 3 }).className).toContain(
      "[overflow-wrap:anywhere]",
    );
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
    // An address is never shortened; control: a line with no path is untouched.
    expect(
      plainToolLine(item("web.fetch", "Fetched https://evil.example/payload/install.sh")),
    ).toBe("Fetched https://evil.example/payload/install.sh");
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
