// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserPane } from "../../src/shell/components/BrowserPane.tsx";
import { ShellProvider } from "../../src/shell/context.tsx";
import type {
  BrowserHostState,
  BrowserPort,
  BrowserTabView,
  ShellPlatform,
  TeachCapture,
} from "../../src/shell/platform.ts";

afterEach(cleanup);

const tab = (over: Partial<BrowserTabView> = {}): BrowserTabView => ({
  tabId: "tab_1",
  url: "https://billing.example.com/reports",
  title: "Reports",
  profile: "logged-in",
  controller: "agent",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  zoomFactor: 1,
  status: null,
  taskId: null,
  taskTitle: null,
  openerTabId: null,
  ...over,
});

function setup(initial: BrowserHostState, teach: Partial<BrowserPort> = {}) {
  let push: (s: BrowserHostState) => void = () => {};
  const port = {
    getState: async () => initial,
    onState: (cb: (s: BrowserHostState) => void) => {
      push = cb;
      return () => {};
    },
    onDownload: () => () => {},
    setViewport: vi.fn(),
    teachStart: vi.fn(async () => {}),
    teachStop: vi.fn(),
    teachCancel: vi.fn(async () => {}),
    teachKept: vi.fn(async () => []),
    ...teach,
  } as unknown as BrowserPort;
  const shellState = { approvals: [] };
  const store = {
    getState: () => shellState,
    subscribe: () => () => {},
    toast: vi.fn(),
    call: vi.fn(async () => ({})),
    tap: () => () => {},
    refresh: vi.fn(async () => {}),
  };
  render(
    <ShellProvider platform={{ browser: port } as ShellPlatform} store={store as never} mac>
      <BrowserPane covered={false} onClose={() => {}} />
    </ShellProvider>,
  );
  return { port, store, push: (s: BrowserHostState) => act(() => push(s)) };
}

const state = (over: Partial<BrowserHostState> = {}): BrowserHostState => ({
  tabs: [tab()],
  activeTabId: "tab_1",
  bridgeConnected: true,
  ...over,
});

describe("the browser pane: Record and Stop (owner only)", () => {
  it("shows a Record button on the owner's own tab, and starts recording that tab", async () => {
    const { port } = setup(state());
    const record = await screen.findByTestId("teach-record");
    await act(async () => fireEvent.click(record));
    expect(port.teachStart).toHaveBeenCalledWith("tab_1");
  });

  it("disables Record on a tab the agent is working in", async () => {
    setup(state({ tabs: [tab({ taskId: "task_1", taskTitle: "Research" })] }));
    const record = (await screen.findByTestId("teach-record")) as HTMLButtonElement;
    expect(record.disabled).toBe(true);
    expect(record.title).toContain("agent is using this tab");
  });

  it("has no Record button where the host cannot record", async () => {
    setup(state(), { teachStart: undefined });
    await screen.findByTestId("browser-address");
    expect(screen.queryByTestId("teach-record")).toBeNull();
  });

  it("shows a recording indicator with a step count, and what is never recorded", async () => {
    const { push } = setup(state());
    await screen.findByTestId("teach-record");
    await push(state({ recording: { tabId: "tab_1", steps: 3 } }));
    const bar = await screen.findByTestId("teach-bar");
    expect(bar.textContent).toContain("Recording");
    expect(bar.textContent).toContain("3 steps so far");
    expect(bar.textContent).toContain("Passwords, card numbers and codes are never recorded");
    // Record is replaced by Stop while recording.
    expect(screen.queryByTestId("teach-record")).toBeNull();
  });

  it("Stop opens the review screen with the steps; Discard drops them", async () => {
    const capture: TeachCapture = {
      id: "teach_abcdef123456",
      endedBy: "stop",
      steps: [
        { id: "s1", kind: "navigate", url: "https://billing.example.com/reports" },
        { id: "s2", kind: "click", role: "button", name: "Export" },
      ],
    };
    const teachStop = vi.fn(async () => capture);
    const { push } = setup(state(), { teachStop });
    await screen.findByTestId("teach-record");
    await push(state({ recording: { tabId: "tab_1", steps: 2 } }));
    await act(async () => fireEvent.click(await screen.findByTestId("teach-stop")));
    expect(teachStop).toHaveBeenCalled();
    expect((await screen.findAllByTestId("teach-words")).map((n) => n.textContent)).toEqual([
      "Open billing.example.com/reports",
      "Click ‘Export’",
    ]);
    // The native page view is hidden while the review is up.
    await act(async () => fireEvent.click(screen.getByTestId("teach-discard")));
    expect(screen.queryByTestId("teach-review")).toBeNull();
  });

  it("says so when nothing but the start page was recorded", async () => {
    const teachStop = vi.fn(async () => ({
      id: "teach_abcdef123456",
      endedBy: "stop" as const,
      steps: [{ id: "s1", kind: "navigate" as const, url: "https://billing.example.com/" }],
    }));
    const { push, store } = setup(state(), { teachStop });
    await screen.findByTestId("teach-record");
    await push(state({ recording: { tabId: "tab_1", steps: 1 } }));
    await act(async () => fireEvent.click(await screen.findByTestId("teach-stop")));
    expect(screen.queryByTestId("teach-review")).toBeNull();
    expect(store.toast).toHaveBeenCalledWith("Nothing was recorded.", "info");
  });

  it("offers review when recording ended by itself", async () => {
    const { push } = setup(state());
    await screen.findByTestId("teach-record");
    await push(state({ recording: { tabId: "tab_1", steps: 200, ended: "limit" } }));
    const bar = await screen.findByTestId("teach-bar");
    expect(bar.textContent).toContain("limit of 200 steps");
    expect(screen.getByTestId("teach-stop").textContent).toBe("Review");
  });

  it("Discard on the bar cancels the recording", async () => {
    const { port, push } = setup(state());
    await screen.findByTestId("teach-record");
    await push(state({ recording: { tabId: "tab_1", steps: 2 } }));
    await act(async () => fireEvent.click(await screen.findByTestId("teach-cancel")));
    expect(port.teachCancel).toHaveBeenCalled();
  });

  it("lists kept recordings on request, and opens one for review", async () => {
    const teachKept = vi.fn(async () => [
      {
        id: "teach_abcdef123456",
        title: "Weekly report",
        keptAt: 1,
        steps: [
          { id: "s1", kind: "click" as const, role: "button", name: "Export" },
          {
            id: "s2",
            kind: "type" as const,
            role: "textbox",
            name: "To",
            keepValue: true,
            value: "x",
          },
        ],
      },
    ]);
    setup(state(), { teachKept });
    const toggle = await screen.findByTestId("teach-kept-toggle");
    await act(async () => fireEvent.click(toggle));
    const list = await screen.findByTestId("teach-kept");
    expect(list.textContent).toContain("Weekly report");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Open" })));
    expect((screen.getByTestId("teach-title") as HTMLInputElement).value).toBe("Weekly report");
    expect(screen.getAllByTestId("teach-words")[1]?.textContent).toBe("Type “x” into ‘To’");
  });
});
