import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { parseCommand } from "../src/chat/commands.ts";
import { sampleEvents, sampleReport } from "../src/research/fixtures.ts";
import { foldResearch } from "../src/research/model.ts";
import { ResearchProgress } from "../src/research/ResearchProgress.tsx";
import { ResearchReport } from "../src/research/ResearchReport.tsx";

describe("research progress", () => {
  it("shows the plan, step, sources and tokens, and stops on request", async () => {
    const onStop = vi.fn();
    render(<ResearchProgress view={foldResearch(sampleEvents)} onStop={onStop} />);
    expect(screen.getByText("How long do solar panels last?")).toBeTruthy();
    expect(screen.getByText(/1 source read · 4 claims found/)).toBeTruthy();
    expect(screen.getByText(/14,200 of about 40,000 tokens/)).toBeTruthy();
    expect(document.querySelector('[aria-current="step"]')?.textContent).toContain(
      "Extracting claims",
    );
    await userEvent.click(screen.getByRole("button", { name: "Stop research" }));
    expect(onStop).toHaveBeenCalled();
  });

  it("offers the report when done and reports a stop without one", async () => {
    const open = vi.fn();
    const done = foldResearch([...sampleEvents, { type: "done", artifactId: "art_1" }]);
    const { unmount } = render(<ResearchProgress view={done} onOpenReport={open} />);
    expect(screen.queryByRole("button", { name: "Stop research" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Open report" }));
    expect(open).toHaveBeenCalledWith("art_1");
    unmount();
    render(<ResearchProgress view={foldResearch([...sampleEvents, { type: "stopped" }])} />);
    expect(screen.getByText("Stopped. Nothing was saved.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open report" })).toBeNull();
  });
});

describe("research report", () => {
  it("links numbered citations to the sources list", async () => {
    const dig = vi.fn();
    render(<ResearchReport report={sampleReport} onDigDeeper={dig} />);
    const sources = screen.getByRole("heading", { name: "Sources" }).parentElement as HTMLElement;
    expect(
      within(sources)
        .getAllByRole("link")
        .map((a) => a.getAttribute("href")),
    ).toEqual(["https://energy.example/lifespan", "https://lab.example/degradation"]);
    const cite = screen.getAllByRole("link", { name: "Source 2" })[0] as HTMLAnchorElement;
    expect(cite.getAttribute("href")).toBe("#source-2");
    expect(document.getElementById("source-2")).toBeTruthy();
    expect(screen.getByText("How do panels age in very hot climates?")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Dig deeper on Degradation" }));
    expect(dig).toHaveBeenCalledWith(1);
  });
});

describe("/research", () => {
  it("is a command that needs a question", () => {
    expect(parseCommand("/research solar").type).toBe("command");
    expect(parseCommand("/research").type).toBe("error");
  });
});
