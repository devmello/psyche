// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { INITIAL_STATUS } from "../../src/client/status.ts";
import { PaneArea } from "../../src/shell/components/Panes.tsx";
import { ShellProvider } from "../../src/shell/context.tsx";
import { createLayoutStore, type LayoutAction } from "../../src/shell/layout/index.ts";
import type { ShellPlatform } from "../../src/shell/platform.ts";
import { ShellStore } from "../../src/shell/store.ts";
import { testEnv } from "../layout/helpers.ts";

afterEach(cleanup);

function setup() {
  const saved = new Map<string, string>();
  const storage = {
    get: (k: string) => saved.get(k) ?? null,
    set: (k: string, v: string) => void saved.set(k, v),
  };
  const platform: ShellPlatform = {
    kind: "web",
    gateway: {
      getStatus: async () => INITIAL_STATUS,
      onStatus: () => () => {},
      onEvent: () => () => {},
      onResync: () => () => {},
      call: async () => ({}),
    },
    storage,
    notify: { show: () => {} },
  };
  const layout = createLayoutStore(storage);
  const env = testEnv();
  const dispatch = (action: LayoutAction) => void layout.dispatch("t1", action, env);
  dispatch({ type: "open", pane: "files", target: null });
  render(
    <ShellProvider platform={platform} store={new ShellStore(platform.gateway)} mac={true}>
      <PaneArea
        layout={layout}
        threadId="t1"
        width={1600}
        covered={false}
        dispatch={dispatch}
        renderPane={() => <p>Files body</p>}
      />
    </ShellProvider>,
  );
  return { layout, storage };
}

describe("the pane beside the chat (#510)", () => {
  it("closes from its × and stays closed after a reload", () => {
    const { storage } = setup();
    expect(screen.getByTestId("pane-area")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close pane" }));
    expect(screen.queryByTestId("pane-area")).toBeNull();
    // A fresh store reads the saved layout: the pane is still closed (docs/06 §4.13 layout rules).
    const reloaded = createLayoutStore(storage);
    expect(reloaded.forThread("t1").groups.length).toBe(0);
  });
});
