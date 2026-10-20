// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  hasInsetTitleBar,
  TITLEBAR_HEIGHT,
  TitleBar,
  titleBarInset,
} from "../../src/shell/components/TitleBar.tsx";
import { sectionTitle } from "../../src/shell/ShellApp.tsx";

afterEach(cleanup);

describe("TitleBar", () => {
  it("renders a drag bar that clears the traffic lights only for inset windows", () => {
    render(
      <TitleBar chrome={{ titleBar: "inset", trafficLights: { x: 18, y: 19 } }}>
        <span>Main chat</span>
      </TitleBar>,
    );
    const bar = screen.getByTestId("titlebar");
    expect(bar.style.height).toBe(`${TITLEBAR_HEIGHT}px`);
    expect(bar.style.paddingLeft).toBe("86px");
    expect(bar.className).toBe("titlebar");
    expect(screen.getByText("Main chat")).toBeTruthy();
  });

  it("renders nothing for native title bars and the web client", () => {
    const { container } = render(
      <>
        <TitleBar chrome={{ titleBar: "native" }}>x</TitleBar>
        <TitleBar chrome={undefined}>y</TitleBar>
      </>,
    );
    expect(container.innerHTML).toBe("");
    expect(hasInsetTitleBar(undefined)).toBe(false);
    expect(titleBarInset({ titleBar: "inset" })).toBe(86);
  });

  it("labels non-chat routes", () => {
    expect(sectionTitle("/settings/files")).toBe("Settings");
    expect(sectionTitle("/agent/activity")).toBe("Agent");
    expect(sectionTitle("/")).toBe("Psyche");
  });
});
