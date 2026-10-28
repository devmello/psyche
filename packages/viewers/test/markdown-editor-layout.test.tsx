// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryDocumentStore } from "../src/core/markdown.ts";
import { MarkdownEditor } from "../src/react/MarkdownEditor.tsx";

afterEach(cleanup);

const css = readFileSync(resolve(__dirname, "../src/styles.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** The declarations of the first rule whose selector list includes `selector`. */
function rule(selector: string): string {
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if ((m[1] ?? "").split(",").some((s) => s.trim() === selector)) return m[2] ?? "";
  }
  throw new Error(`no rule for ${selector}`);
}

const LONG = Array.from({ length: 300 }, (_, i) => `Line ${i + 1}`).join("\n");

describe("MarkdownEditor layout", () => {
  it("the editor body is the scroll container in Rich, Source and Diff", async () => {
    render(<MarkdownEditor path="AGENTS.md" store={new MemoryDocumentStore(LONG)} />);
    await screen.findByLabelText("AGENTS.md editor");
    for (const [mode, cls] of [
      ["Rich", "psy-md__editor"],
      ["Source", "psy-md__editor"],
      ["Diff", "psy-md__diff"],
    ] as const) {
      fireEvent.click(screen.getByText(mode));
      const body = document.querySelector(`.${cls}`);
      expect(body, mode).not.toBeNull();
      // The body is a child of the editor root, below the (non-scrolling) bar.
      expect(body?.parentElement?.className).toBe("psy-md");
      expect(body?.previousElementSibling?.className).not.toContain(cls);
    }
    const body = rule(".psy-md__editor");
    expect(body).toMatch(/overflow:\s*auto/);
    expect(body).toMatch(/min-height:\s*0/);
    expect(body).toMatch(/flex:\s*1/);
    expect(rule(".psy-md__diff")).toBe(body);
  });

  it("the editor root fills a bounded parent and never outgrows it", () => {
    const root = rule(".psy-md");
    expect(root).toMatch(/min-height:\s*0/);
    expect(root).toMatch(/flex-direction:\s*column/);
    expect(rule(".psy-md__bar")).toMatch(/flex:\s*none/);
  });

  it("Rich uses the app's body face; code keeps the monospace face", async () => {
    render(<MarkdownEditor path="notes.md" store={new MemoryDocumentStore("# Hi\n")} />);
    await screen.findByLabelText("notes.md editor");
    const styles = (): string =>
      [...document.querySelectorAll("style")].map((s) => s.textContent ?? "").join("\n");
    expect(styles()).toContain("var(--font-sans");
    expect(styles()).toMatch(/\.cm-md-code[^{]*\{[^}]*--font-mono/);
  });

  it("the mode switch is a labelled group of buttons with one pressed", async () => {
    render(
      <MarkdownEditor
        path="a.md"
        store={new MemoryDocumentStore("x")}
        modesLabel="Ansicht"
        modeLabels={{ rich: "Formatiert", source: "Quelle", diff: "Unterschied" }}
      />,
    );
    await screen.findByLabelText("a.md editor");
    const group = screen.getByRole("group", { name: "Ansicht" });
    const buttons = [...group.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["Formatiert", "Quelle", "Unterschied"]);
    expect(buttons.map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "false", "false"]);
    expect(rule('.psy-segmented > button[aria-pressed="true"]')).toMatch(/background/);
    expect(rule(".psy-segmented > button")).toMatch(/padding/);
  });
});
