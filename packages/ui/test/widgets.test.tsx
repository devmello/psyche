import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Widget } from "@psyche/protocol";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { StoryWorld } from "../src/stories/harness.tsx";
import {
  dataWidget,
  frozenWidget,
  progressWidget,
  spoofWidget,
  tabsWidget,
  taintedWidget,
} from "../src/widgets/fixtures.ts";
import { widgetText } from "../src/widgets/text.ts";
import { WidgetBlockView } from "../src/widgets/WidgetBlock.tsx";

function mount(widgets: Widget[], id: string) {
  const ref: { gateway?: MockGateway } = {};
  const view = render(
    <StoryWorld
      edit={(w) => {
        w.widgets = widgets;
      }}
      onGateway={(g) => {
        ref.gateway = g;
      }}
    >
      <WidgetBlockView block={{ type: "ui", widgetId: id }} />
    </StoryWorld>,
  );
  return { ref, ...view };
}

describe("widget rendering", () => {
  it("loads by id through widgets.get and renders host chrome, progress and checklist roles", async () => {
    mount([progressWidget], progressWidget.id);
    const frame = await screen.findByTestId("widget");
    expect(within(frame).getByRole("heading", { name: "Inbox cleanup" })).toBeTruthy();
    const bar = within(frame).getByRole("progressbar", { name: "Cleanup" });
    expect(bar.getAttribute("aria-valuenow")).toBe("3");
    expect(bar.getAttribute("aria-valuemax")).toBe("5");
    expect(bar.getAttribute("aria-valuetext")).toMatch(/3 of 5/);
    // State is text, not only an icon.
    expect(within(frame).getAllByText("Done").length).toBeGreaterThan(0);
    expect(within(frame).getByText("Failed")).toBeTruthy();
    expect(within(frame).getByTestId("widget-state").textContent).toBe("Live");
  });

  it("shows a missing widget quietly", async () => {
    mount([], "nope");
    expect(await screen.findByTestId("widget-missing")).toBeTruthy();
  });

  it("applies widget.updated by rev and announces politely (throttled)", async () => {
    const { ref } = mount([progressWidget], progressWidget.id);
    await screen.findByTestId("widget");
    act(() =>
      ref.gateway?.emit("widget.updated", {
        widgetId: progressWidget.id,
        threadId: progressWidget.threadId,
        rev: 2,
        ops: [
          { op: "set", id: "p", props: { value: 4 } },
          { op: "meta", fallbackText: "Inbox cleanup: 4 of 5 steps done (80%)." },
        ],
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("4"),
    );
    const live = screen.getByTestId("widget-live");
    expect(live.getAttribute("aria-live")).toBe("polite");
    await waitFor(() => expect(live.textContent).toMatch(/80%/));
  });

  it("drops the snapshot on a rev gap and refetches it", async () => {
    const { ref } = mount([progressWidget], progressWidget.id);
    await screen.findByTestId("widget");
    act(() =>
      ref.gateway?.emit("widget.updated", {
        widgetId: progressWidget.id,
        threadId: progressWidget.threadId,
        rev: 5,
        ops: [{ op: "set", id: "p", props: { value: 5 } }],
      }),
    );
    // rev 5 != 2: not applied locally; the server's snapshot (still value 3) is loaded again.
    await waitFor(() =>
      expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("3"),
    );
  });

  it("marks a frozen widget and an untrusted one in host chrome", async () => {
    const a = mount([frozenWidget], frozenWidget.id);
    expect((await screen.findByTestId("widget-state")).textContent).toBe("Frozen");
    a.unmount();
    mount([taintedWidget], taintedWidget.id);
    const frame = await screen.findByTestId("widget");
    expect(frame.getAttribute("data-untrusted")).toBe("true");
    expect(frame.className).toContain("border-untrusted");
    expect(screen.getByTestId("widget-untrusted").getAttribute("title")).toMatch(
      /news\.example\.com/,
    );
  });

  it("renders a real table with scoped headers, host sorting and a 25-row cap", async () => {
    mount([dataWidget], dataWidget.id);
    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("columnheader").length).toBe(3);
    expect(within(table).getAllByRole("row").length).toBe(26); // header + 25
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Show all 30 rows" }));
    expect(within(table).getAllByRole("row").length).toBe(31);
    await user.click(screen.getByRole("button", { name: "Sort by Total" }));
    expect(
      within(table).getByRole("columnheader", { name: /Total/ }).getAttribute("aria-sort"),
    ).toBe("ascending");
  });

  it("tabs follow the tablist pattern with arrow keys", async () => {
    mount([tabsWidget], tabsWidget.id);
    const tabs = await screen.findAllByRole("tab");
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    const user = userEvent.setup();
    tabs[0]?.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getAllByRole("tab")[1]?.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").textContent).toMatch(/Casa Azul/);
  });

  it("copies a text rendering built from the spec", () => {
    const text = widgetText(progressWidget.spec);
    expect(text).toContain("Cleanup: 3/5 · 60%");
    expect(text).toContain("☑ Archive newsletters");
    expect(text).toContain("☐ Draft replies");
  });
});

describe("widget safety", () => {
  it("never renders markup, scripts or handlers from the spec", async () => {
    const evil: Widget = {
      ...progressWidget,
      id: "wdg_evil",
      spec: {
        ...progressWidget.spec,
        root: {
          id: "root",
          type: "stack",
          children: [
            {
              id: "t",
              type: "text",
              text: "<img src=x onerror=alert(1)><script>alert(2)</script>",
              onclick: "x()",
              style: "position:fixed",
            },
            { id: "m", type: "markdown", md: "<script>alert(3)</script> [x](javascript:alert(4))" },
            { id: "l", type: "link", label: "bad", url: "javascript:alert(5)" },
          ],
        },
      },
    };
    mount([evil], evil.id);
    const frame = await screen.findByTestId("widget");
    expect(frame.querySelector("script, img, [onclick], [style*='fixed']")).toBeNull();
    expect(frame.querySelector("a[href^='javascript']")).toBeNull();
    expect(frame.textContent).toContain("<script>alert(2)</script>");
  });

  it("a widget dressed as an approval card keeps widget chrome and has no route to approve", async () => {
    mount([spoofWidget], spoofWidget.id);
    const frame = await screen.findByTestId("widget");
    // Host chrome is present and unmistakable; the approval card's surface and icons are not.
    expect(frame.getAttribute("data-widget")).toBe(spoofWidget.id);
    expect(screen.getByTestId("widget-state")).toBeTruthy();
    expect(frame.className).not.toMatch(/surface-raised|shadow-elevation|approval/);
    expect(frame.innerHTML).not.toMatch(
      /approval-(surface|border|text)|lucide-shield-check|lucide-fingerprint|lucide-lock/,
    );
    expect(frame.className).toMatch(/\[contain:layout_paint\]/);
    expect(frame.className).toMatch(/overflow-clip/);
    // Interaction nodes do not render yet (P6), so there is no control at all.
    expect(
      within(frame)
        .queryAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Copy as text"]);
    expect(document.querySelector("[data-card='framed'][data-kind='approval']")).toBeNull();
  });
});

describe("widget code hygiene", () => {
  const read = (f: string) => readFileSync(join(import.meta.dirname, "../src/widgets", f), "utf8");
  const files = ["WidgetBlock.tsx", "WidgetView.tsx", "nodes.tsx", "tone.ts"];

  it("never uses approval tokens, approval icons, raw HTML or positioned layout", () => {
    for (const f of files) {
      const src = read(f);
      expect(src, f).not.toMatch(
        /approval-(text|surface|border)|\bShieldCheck\b|\bFingerprint\b|\bLock\b/,
      );
      expect(src, f).not.toMatch(
        /dangerouslySetInnerHTML|innerHTML|\bfixed\b|\bsticky\b|\babsolute\b|z-\[?\d|useApproval|approvals\.answer|answerToken/,
      );
    }
  });

  it("keeps the renderer out of the main bundle (lazy import only)", () => {
    const block = read("WidgetBlock.tsx");
    expect(block).toMatch(/lazy\(\(\) => import\("\.\/WidgetView\.tsx"\)\)/);
    expect(block).not.toMatch(/^import .*WidgetView/m);
    const registry = readFileSync(
      join(import.meta.dirname, "../src/blocks/MessageBlocks.tsx"),
      "utf8",
    );
    expect(registry).not.toMatch(/widgets\/(WidgetView|nodes)/);
  });
});
