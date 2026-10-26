import type { ToolCall } from "@psyche/protocol";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { toolViewFor } from "../src/blocks/registry.tsx";
import { parseOutput, ToolResultPreview } from "../src/blocks/ToolResultPreview.tsx";
import "../src/blocks/tool-views.tsx";

const show = (tool: string, result: unknown) => {
  const View = toolViewFor(tool);
  if (View === undefined) throw new Error(`no view for ${tool}`);
  return render(<View call={{ tool } as ToolCall} result={result} />);
};

describe("tool views", () => {
  it("matches connector-prefixed names", () => {
    expect(toolViewFor("mcp__apple-calendar__calendar_list_events")).toBe(
      toolViewFor("calendar_list_events"),
    );
    expect(toolViewFor("mcp__x__nothing")).toBeUndefined();
  });

  it("shows Apple and Google events, and folds past six", () => {
    show("calendar_list_events", {
      events: Array.from({ length: 8 }, (_, i) => ({
        title: `Standup ${i}`,
        start: "2026-10-27T09:00:00Z",
      })),
    });
    expect(screen.getByText("Standup 0")).toBeTruthy();
    expect(screen.queryByText("Standup 7")).toBeNull();
    expect(screen.getByText("2 more")).toBeTruthy();
    show("calendar_list_events", [
      { summary: "Dentist", start: { dateTime: "2026-10-27T14:30:00Z" } },
    ]);
    expect(screen.getByText("Dentist")).toBeTruthy();
  });

  it("draws outside text as plain text, never markup", () => {
    const { container } = show("web.search", {
      results: [{ title: "<img src=x onerror=alert(1)>", url: "https://www.example.com/a" }],
    });
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(container.textContent).toContain("example.com");
    expect(container.querySelector("a")).toBeNull();
  });

  it("copes with the wrong shape", () => {
    show("mail_search", "oops");
    expect(screen.getByText("No results.")).toBeTruthy();
    show("list_dir", {
      entries: [
        { name: "notes", kind: "dir" },
        { name: "a.md", kind: "file" },
      ],
    });
    expect(screen.getByText("notes")).toBeTruthy();
  });

  it("parses JSON output strings and leaves plain text", () => {
    expect(parseOutput('{"a":1}')).toEqual({ a: 1 });
    expect(parseOutput("1\tline")).toBe("1\tline");
  });

  it("offers a preview only for finished calls with a view and a step", () => {
    const base = { tool: "web.search", status: "ok", stepId: "stp_1", runId: "run_1" } as ToolCall;
    const yes = render(<ToolResultPreview call={base} />);
    expect(yes.container.querySelector("details")).not.toBeNull();
    yes.unmount();
    for (const call of [
      { ...base, status: "failed" },
      { ...base, stepId: undefined },
      { ...base, tool: "unknown.tool" },
    ] as ToolCall[]) {
      const r = render(<ToolResultPreview call={call} />);
      expect(r.container.querySelector("details")).toBeNull();
      r.unmount();
    }
  });
});
