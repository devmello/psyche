import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Disclosure, WorkingPulse } from "../src/motion/index.ts";

afterEach(cleanup);

describe("Disclosure (smoothness C10)", () => {
  it("mounts its detail only while open", () => {
    const { rerender } = render(<Disclosure open={false}>detail</Disclosure>);
    expect(screen.queryByText("detail")).toBeNull();
    rerender(<Disclosure open>detail</Disclosure>);
    expect(screen.getByText("detail")).toBeTruthy();
  });
});

describe("WorkingPulse", () => {
  it("is one decorative dot", () => {
    render(<WorkingPulse />);
    expect(screen.getByTestId("working-pulse").getAttribute("aria-hidden")).toBe("true");
  });
});
