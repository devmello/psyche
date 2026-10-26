import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScreenAskView } from "../src/screen-ask/ScreenAskView.tsx";

let fire: () => void = () => {};

describe("ScreenAskView height reports", () => {
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
    vi.stubGlobal(
      "requestAnimationFrame",
      (cb: () => void) => setTimeout(cb, 0) as unknown as number,
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("sends one stepped height per frame, and nothing when it did not change", () => {
    const onHeight = vi.fn();
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    rect.mockReturnValue({ height: 101 } as DOMRect);
    render(
      <ScreenAskView
        text=""
        onText={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
        destination="new"
        onDestination={() => {}}
        onHeight={onHeight}
      />,
    );
    act(() => {
      fire();
      fire();
      fire();
      vi.advanceTimersByTime(20);
    });
    expect(onHeight).toHaveBeenCalledTimes(1);
    expect(onHeight).toHaveBeenLastCalledWith(104);

    rect.mockReturnValue({ height: 103 } as DOMRect); // same 8 px step
    act(() => {
      fire();
      vi.advanceTimersByTime(20);
    });
    expect(onHeight).toHaveBeenCalledTimes(1);

    rect.mockReturnValue({ height: 130 } as DOMRect);
    act(() => {
      fire();
      vi.advanceTimersByTime(20);
    });
    expect(onHeight).toHaveBeenCalledTimes(2);
    expect(onHeight).toHaveBeenLastCalledWith(136);
  });
});
