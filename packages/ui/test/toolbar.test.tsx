import { act, cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  ToolbarGroup,
  ToolbarProvider,
  ToolbarSlot,
  ToolbarStore,
  useToolbar,
} from "../src/components/ui/toolbar.tsx";

afterEach(cleanup);

function Screen({ title, onRender }: { title: string; onRender?: () => void }) {
  onRender?.();
  useToolbar({ title, trailing: <button type="button">Act on {title}</button> });
  return <p>{title} body</p>;
}

describe("toolbar slot (docs/design/redesign-2026.md §4)", () => {
  it("renders what the mounted screen registered, and the fallback otherwise", () => {
    const store = new ToolbarStore();
    const { rerender } = render(
      <ToolbarProvider store={store}>
        <ToolbarSlot fallback={{ title: "Psyche" }} />
        <Screen title="Feed" />
      </ToolbarProvider>,
    );
    const bar = screen.getByRole("toolbar");
    expect(bar.textContent).toContain("Feed");
    expect(screen.getByRole("button", { name: "Act on Feed" })).toBeTruthy();
    rerender(
      <ToolbarProvider store={store}>
        <ToolbarSlot fallback={{ title: "Psyche" }} />
      </ToolbarProvider>,
    );
    expect(screen.getByRole("toolbar").textContent).toBe("Psyche");
  });

  it("shows the most recently mounted screen and falls back when it unmounts", () => {
    const store = new ToolbarStore();
    function Host() {
      const [sheet, setSheet] = useState(false);
      return (
        <ToolbarProvider store={store}>
          <ToolbarSlot />
          <Screen title="Chat" />
          {sheet ? <Screen title="Activity" /> : null}
          <button type="button" onClick={() => setSheet((s) => !s)}>
            toggle
          </button>
        </ToolbarProvider>
      );
    }
    render(<Host />);
    expect(screen.getByRole("toolbar").textContent).toContain("Chat");
    act(() => screen.getByRole("button", { name: "toggle" }).click());
    expect(screen.getByRole("toolbar").textContent).toContain("Activity");
    act(() => screen.getByRole("button", { name: "toggle" }).click());
    expect(screen.getByRole("toolbar").textContent).toContain("Chat");
  });

  it("updates the slot without re-rendering the screen (no render loop)", () => {
    let renders = 0;
    render(
      <ToolbarProvider>
        <ToolbarSlot />
        <Screen title="Goals" onRender={() => renders++} />
      </ToolbarProvider>,
    );
    expect(screen.getByRole("toolbar").textContent).toContain("Goals");
    expect(renders).toBeLessThanOrEqual(2); // StrictMode-free mount: one render (two at most)
  });

  it("does nothing outside a provider, so screens render alone", () => {
    render(<Screen title="Ideas" />);
    expect(screen.getByText("Ideas body")).toBeTruthy();
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("draws control groups as glass capsules, never the row itself", () => {
    render(
      <ToolbarProvider>
        <ToolbarSlot
          fallback={{
            title: "Wren",
            trailing: (
              <ToolbarGroup>
                <button type="button">Balanced</button>
              </ToolbarGroup>
            ),
          }}
        />
      </ToolbarProvider>,
    );
    const group = screen.getByRole("group");
    expect(group.getAttribute("data-glass-impl")).toBeTruthy();
    expect(screen.getByRole("toolbar").className).not.toContain("material-glass");
  });
});
