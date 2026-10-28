// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { INITIAL_STATUS } from "../../src/client/status.ts";
import { PaneArea } from "../../src/shell/components/Panes.tsx";
import { ShellProvider } from "../../src/shell/context.tsx";
import { CHAT_MIN_PX, createLayoutStore } from "../../src/shell/layout/index.ts";
import type { ShellPlatform } from "../../src/shell/platform.ts";
import { ShellStore } from "../../src/shell/store.ts";
import { testEnv } from "../layout/helpers.ts";

afterEach(cleanup);

const platform: ShellPlatform = {
  kind: "web",
  gateway: {
    getStatus: async () => INITIAL_STATUS,
    onStatus: () => () => {},
    onEvent: () => () => {},
    onResync: () => () => {},
    call: async () => ({}),
  },
  storage: { get: () => null, set: () => {} },
  notify: { show: () => {} },
};

function renderPanes(contentWidth: number, chatFraction: number) {
  const layout = createLayoutStore({ get: () => null, set: () => {} });
  layout.dispatch("t1", { type: "open", pane: "terminal" }, testEnv(1600));
  // A width saved on a wider window: it reaches the render without a re-fit.
  layout.replace("t1", { ...layout.forThread("t1"), chatFraction });
  return render(
    <ShellProvider platform={platform} store={new ShellStore(platform.gateway)} mac={true}>
      <PaneArea
        layout={layout}
        threadId="t1"
        width={contentWidth + 248}
        contentWidth={contentWidth}
        covered={false}
        dispatch={() => {}}
      />
    </ShellProvider>,
  );
}

describe("PaneArea column width", () => {
  it("clamps a saved pane width that is wider than the room it has", () => {
    const { container } = renderPanes(1000, 0.1);
    const column = container.querySelector<HTMLElement>(".pane-presence");
    expect(column?.style.width).toBe(`${1000 - CHAT_MIN_PX}px`);
  });

  it("keeps a width that fits", () => {
    const { container } = renderPanes(1200, 0.5);
    expect(container.querySelector<HTMLElement>(".pane-presence")?.style.width).toBe("600px");
  });
});

describe("pane header layout", () => {
  const css = readFileSync(resolve(process.cwd(), "src/shell/shell.css"), "utf8");
  const rule = (selector: string): string =>
    new RegExp(`${selector.replace(/[.>]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";

  it("renders the actions after the tab strip", () => {
    renderPanes(1200, 0.5);
    const header = screen.getByTestId("pane-group").querySelector("header");
    expect(header?.querySelector(".tabs")).not.toBeNull();
    expect(header?.querySelectorAll(":scope > button").length).toBeGreaterThan(0);
  });

  it("lets the title strip shrink and never shrinks the action buttons", () => {
    expect(rule(".pane > header .tabs")).toMatch(/min-width:\s*0/);
    expect(rule(".pane > header .tabs button")).toMatch(/text-overflow:\s*ellipsis/);
    expect(rule(".pane > header > button")).toMatch(/flex-shrink:\s*0/);
  });

  it("never lets a pane be wider than its column", () => {
    expect(rule(".pane")).toMatch(/min-width:\s*min\(360px,\s*100%\)/);
  });
});
