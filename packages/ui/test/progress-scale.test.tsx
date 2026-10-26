import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Progress } from "../src/components/ui/progress.tsx";

afterEach(cleanup);

describe("Progress (smoothness C19)", () => {
  it("fills with transform, not width", () => {
    const { container } = render(<Progress value={60} aria-label="Milestones" />);
    const fill = container.querySelector<HTMLElement>("[data-slot=progress-indicator]");
    expect(fill?.style.transform).toBe("scaleX(0.6)");
    expect(fill?.style.width).toBe("100%");
    expect(fill?.className).toContain("transition-transform");
    expect(fill?.className).not.toContain("transition-[width]");
  });
});
