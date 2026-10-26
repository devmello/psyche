import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReflowColumn } from "../src/shell/motion.tsx";
import { ThemeProvider } from "../src/theme/ThemeProvider.tsx";

let fire: () => void = () => {};
let width = 800;

describe("ReflowColumn", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          fire = cb;
        }
        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ width }) as DOMRect,
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("observes its own width and survives a change of it", () => {
    const { container } = render(
      <ThemeProvider>
        <ReflowColumn>content</ReflowColumn>
      </ThemeProvider>,
    );
    expect(container.querySelector("main")?.textContent).toBe("content");
    width = 540;
    expect(() => fire()).not.toThrow();
  });
});
