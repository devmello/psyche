import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentGlow } from "../src/motion/AgentGlow.tsx";

describe("AgentGlow", () => {
  it("is decorative, pointer-transparent and toggles with `active`", () => {
    const { rerender } = render(<AgentGlow active />);
    const glow = screen.getByTestId("agent-glow");
    expect(glow.getAttribute("aria-hidden")).toBe("true");
    expect(glow.className).toContain("pointer-events-none");
    expect(glow.getAttribute("data-active")).toBe("true");
    rerender(<AgentGlow active={false} />);
    expect(glow.getAttribute("data-active")).toBe("false");
  });

  it("pulses opacity only", () => {
    const css = readFileSync(join(process.cwd(), "src/styles/design.css"), "utf8");
    const block = css.slice(css.indexOf("@keyframes psy-agent-glow"));
    const frames = block.slice(0, block.indexOf("\n}\n") + 3);
    expect(frames).toContain("opacity");
    expect(frames).not.toMatch(/transform|width|height|box-shadow/);
  });
});
