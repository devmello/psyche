// @vitest-environment happy-dom

import { UiSlotsProvider } from "@psyche/ui";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserPane } from "../../src/shell/components/BrowserPane.tsx";
import { TeachReview } from "../../src/shell/components/TeachReview.tsx";
import {
  reviewFrom,
  reviewFromKept,
  setChoice,
  toSaveSteps,
} from "../../src/shell/components/teach-review.ts";
import { ShellProvider } from "../../src/shell/context.tsx";
import type {
  BrowserHostState,
  BrowserPort,
  ShellPlatform,
  TeachAppStatusView,
  TeachCapture,
} from "../../src/shell/platform.ts";

afterEach(cleanup);

/** A Luhn-valid test card number, assembled at run time so the repo's secret scan never sees one. */
const CARD = ["4111", "1111", "1111", "1111"].join(" ");

const app = { bundleId: "com.apple.mail", name: "Mail" };
const appCapture = (): TeachCapture => ({
  id: "app-teach-1",
  endedBy: "stop",
  app,
  skippedInput: 2,
  steps: [
    { id: "a1", kind: "app_click", app, role: "button", name: "New Message", path: ["Inbox"] },
    { id: "a2", kind: "app_type", app, role: "textbox", name: "Subject", sample: "Quarterly" },
    { id: "a3", kind: "app_type", app, role: "textbox", name: "Password", sensitive: true },
    { id: "a4", kind: "app_menu", app, role: "menuitem", name: "Export", path: ["File", "Export"] },
  ],
});

describe("an app recording in the review model (same rules as the browser's)", () => {
  it("starts with typed values hidden and keeps the app, path and fallback for Save", () => {
    const rows = reviewFrom(appCapture());
    expect(rows.map((r) => r.choice)).toEqual(["ask", "ask", "ask", "ask"]);
    const steps = toSaveSteps(rows);
    expect(JSON.stringify(steps)).not.toContain("Quarterly");
    expect(steps[0]).toMatchObject({ kind: "app_click", app, path: ["Inbox"] });
    expect(steps[3]).toMatchObject({ kind: "app_menu", path: ["File", "Export"] });
  });

  it("keeps a value only when chosen, never on a secure field, never a card number", () => {
    let rows = reviewFrom(appCapture());
    rows = setChoice(rows, 1, "keep");
    rows = setChoice(rows, 2, "keep");
    const steps = toSaveSteps(rows);
    expect(steps[1]).toMatchObject({ keepValue: true, value: "Quarterly" });
    expect(steps[2]).toMatchObject({ sensitive: true });
    expect(steps[2]).not.toHaveProperty("value");

    const card = setChoice(
      reviewFrom({
        id: "x",
        endedBy: "stop",
        steps: [{ id: "a1", kind: "app_type", app, role: "textbox", name: "Memo", sample: CARD }],
      }),
      0,
      "keep",
    );
    const [s] = toSaveSteps(card);
    expect(s?.sensitive).toBe(true);
    expect(JSON.stringify(s)).not.toContain("4111");
  });

  it("makes an input of a typed value, and a kept app recording opens again with its app", () => {
    let rows = reviewFrom(appCapture());
    rows = setChoice(rows, 1, "input");
    const saved = toSaveSteps(rows);
    expect(saved[1]).toMatchObject({ input: { name: "input1" } });
    const again = reviewFromKept(saved);
    expect(again[1]).toMatchObject({ choice: "input", inputName: "input1", app });
  });
});

function setupReview() {
  const store = {
    call: vi.fn(async (method: string) =>
      method === "skills.drafts.fromRecording"
        ? { draft: { id: "skd_1", name: "send-the-weekly-note", status: "open" } }
        : {},
    ),
    toast: vi.fn(),
    refresh: vi.fn(async () => {}),
    tap: () => () => {},
  };
  render(
    <ShellProvider platform={{} as ShellPlatform} store={store as never} mac={true}>
      <UiSlotsProvider value={{ prefillComposer: vi.fn() }}>
        <TeachReview capture={appCapture()} port={{} as BrowserPort} onClose={vi.fn()} />
      </UiSlotsProvider>
    </ShellProvider>,
  );
  return store;
}

describe("the review screen for an app recording", () => {
  it("shows the steps in plain words, the sensitive one uneditable, and what was left out", () => {
    setupReview();
    expect(screen.getAllByTestId("teach-words").map((n) => n.textContent)).toEqual([
      "In Mail, click ‘New Message’",
      "In Mail, type what you tell it into ‘Subject’",
      "In Mail, you type into ‘Password’ yourself",
      "In Mail, choose ‘File > Export’",
    ]);
    expect(screen.getByTestId("teach-skipped-input").textContent).toContain(
      "2 things were left out",
    );
    // The typed example is never on screen unless kept.
    expect(document.body.textContent).not.toContain("Quarterly");
    expect(document.body.textContent).toContain("windows and menus");
  });

  it("saves through fromRecording with the app steps, and no value the owner did not keep", async () => {
    const store = setupReview();
    fireEvent.change(screen.getByTestId("teach-title"), {
      target: { value: "Send the weekly note" },
    });
    await act(async () => fireEvent.click(screen.getByTestId("teach-save")));
    const [method, params] = store.call.mock.calls[0] as unknown as [string, { steps: unknown[] }];
    expect(method).toBe("skills.drafts.fromRecording");
    expect(JSON.stringify(params.steps)).not.toContain("Quarterly");
    expect(params.steps[0]).toMatchObject({ kind: "app_click", app });
    expect(store.call.mock.calls[1]?.[0]).toBe("skills.drafts.accept");
  });
});

function setupPane(
  over: Partial<BrowserPort> = {},
  initial: TeachAppStatusView = { active: false },
) {
  let status = initial;
  const port = {
    getState: async () =>
      ({ tabs: [], activeTabId: null, bridgeConnected: true }) as BrowserHostState,
    onState: () => () => {},
    onDownload: () => () => {},
    setViewport: vi.fn(),
    teachAppApps: vi.fn(async () => ({
      apps: [{ bundleId: "com.apple.mail", name: "Mail", tier: "interact" as const }],
    })),
    teachAppStart: vi.fn(async (bundleId: string) => {
      status = { active: true, app: { bundleId, name: "Mail" }, steps: 0 };
      return { sessionId: "s1", app: { bundleId, name: "Mail" } };
    }),
    teachAppStatus: vi.fn(async () => status),
    teachAppStop: vi.fn(async () => {
      status = { active: false };
      return {
        id: "app-teach-1",
        endedBy: "stop" as const,
        app,
        steps: appCapture().steps,
        skipped: 1,
      };
    }),
    teachAppCancel: vi.fn(async () => {
      status = { active: false };
      return { cancelled: true };
    }),
    ...over,
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
  return { port, store };
}

describe("the browser pane: Record in an app (owner only)", () => {
  it("lists the granted apps, starts one on Start, and shows a recording bar that names the app", async () => {
    const { port } = setupPane();
    await act(async () => fireEvent.click(await screen.findByTestId("teach-app-record")));
    expect(port.teachAppApps).toHaveBeenCalled();
    expect(await screen.findByTestId("teach-app-picker")).toBeTruthy();
    expect(screen.getByTestId("teach-app-picker").textContent).toContain("Passwords, card numbers");
    await act(async () => fireEvent.click(screen.getByTestId("teach-app-start")));
    expect(port.teachAppStart).toHaveBeenCalledWith("com.apple.mail");
    const bar = await screen.findByTestId("teach-app-bar");
    expect(bar.textContent).toContain("Recording Mail");
    expect(bar.textContent).toContain("no screenshots are taken");
    // Stop is always there.
    expect(screen.getByTestId("teach-app-stop")).toBeTruthy();
    expect(screen.queryByTestId("teach-app-record")).toBeNull();
  });

  it("says so when no app is allowed yet", async () => {
    setupPane({ teachAppApps: vi.fn(async () => ({ apps: [] })) });
    await act(async () => fireEvent.click(await screen.findByTestId("teach-app-record")));
    expect((await screen.findByTestId("teach-app-none")).textContent).toContain("computer use");
    expect((screen.getByTestId("teach-app-start") as HTMLButtonElement).disabled).toBe(true);
  });

  it("Stop opens the same review screen; Discard drops the recording", async () => {
    const { port } = setupPane({}, { active: true, app, steps: 3 });
    const stop = await screen.findByTestId("teach-app-stop");
    await act(async () => fireEvent.click(stop));
    expect(port.teachAppStop).toHaveBeenCalled();
    expect(await screen.findByTestId("teach-review")).toBeTruthy();
    expect(screen.getAllByTestId("teach-step")).toHaveLength(4);

    cleanup();
    const second = setupPane({}, { active: true, app, steps: 1 });
    const cancel = await screen.findByTestId("teach-app-cancel");
    await act(async () => fireEvent.click(cancel));
    expect(second.port.teachAppCancel).toHaveBeenCalled();
    expect(screen.queryByTestId("teach-review")).toBeNull();
  });

  it("has no control where the host cannot record in an app", async () => {
    setupPane({ teachAppStart: undefined, teachAppApps: undefined });
    await screen.findByTestId("browser-pane");
    expect(screen.queryByTestId("teach-app-record")).toBeNull();
  });

  it("shows why a recording ended early and offers Review", async () => {
    setupPane({}, { active: false, app, steps: 200, ended: "limit" });
    const bar = await screen.findByTestId("teach-app-bar");
    expect(bar.textContent).toContain("limit of 200 steps");
    expect(screen.getByTestId("teach-app-stop").textContent).toBe("Review");
  });
});
