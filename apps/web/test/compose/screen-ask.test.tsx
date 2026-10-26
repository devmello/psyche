// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayEvent, GatewayStatus } from "../../src/client/index.ts";
import {
  answerText,
  imageChoice,
  parseOpen,
  ScreenAsk,
  type ScreenAskBridge,
} from "../../src/compose/ScreenAsk.tsx";
import type { ShellPlatform } from "../../src/shell/platform.ts";

afterEach(cleanup);

const CAPTURE = {
  captureId: "cap_1",
  libraryItemId: "lib_1",
  thumbnail: "data:image/png;base64,AA==",
  width: 1600,
  height: 1000,
  mode: "window",
  context: {
    appName: "Safari",
    bundleId: "com.apple.Safari",
    windowTitle: "Docs",
    selectedText: null,
    url: "https://example.com",
  },
  expiresAt: "2026-10-26T10:10:00Z",
};

function setup(opts: { busyMain?: boolean } = {}) {
  const listeners = new Set<(e: GatewayEvent) => void>();
  const status: GatewayStatus = { phase: "paired", health: "ok", attempt: 0 };
  const calls: [string, unknown][] = [];
  const platform: ShellPlatform = {
    kind: "desktop",
    gateway: {
      getStatus: async () => status,
      onStatus: () => () => {},
      call: async (method, params) => {
        calls.push([method, params]);
        if (method === "screen.capture") return CAPTURE;
        if (method === "screen.discard") return { discarded: true };
        if (method === "threads.create")
          return { thread: { id: "th_new", kind: "side", title: "x" } };
        if (method === "threads.list")
          return { threads: [{ thread: { id: "th_main", kind: "main" } }], nextCursor: null };
        if (method === "settings.get") return { settings: {}, stateVersion: 1 };
        if (method === "settings.set") {
          const p = params as { key: string; value: unknown };
          return { entry: { key: p.key, value: p.value }, stateVersion: 2 };
        }
        if (method === "chat.send") {
          if (opts.busyMain && (params as { threadId: string }).threadId === "th_main")
            throw Object.assign(new Error("busy"), {
              code: "conflict",
              details: { reason: "thread_busy" },
            });
          return { messageId: "m_1", runId: "r_1", queued: false };
        }
        if (method === "chat.history") return { messages: [], nextCursor: null };
        if (method === "threads.get") return { thread: { id: "th_new", kind: "side" } };
        if (method === "events.subscribe") return { ok: true };
        return {};
      },
      onEvent: (cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      onResync: () => () => {},
    },
    storage: { get: () => null, set: () => {} },
    notify: { show: () => {} },
  };
  let opener: ((o: unknown) => void) | undefined;
  const bridged: string[] = [];
  const bridge: ScreenAskBridge = {
    onOpen: (cb) => {
      opener = cb;
      return () => {
        opener = undefined;
      };
    },
    done: () => bridged.push("done"),
    openThread: (id) => bridged.push(`open:${id}`),
    resize: () => {},
    selectArea: () => bridged.push("selectArea"),
    region: () => {},
  };
  const open = (o: unknown) => act(() => opener?.(o));
  return { platform, bridge, calls, bridged, open };
}

describe("parseOpen", () => {
  it("accepts window and region opens only", () => {
    expect(parseOpen({ mode: "window" })).toEqual({ mode: "window" });
    expect(parseOpen({ mode: "region", rect: { x: 1, y: 2, width: 3, height: 4 } })).toEqual({
      mode: "region",
      rect: { x: 1, y: 2, width: 3, height: 4 },
    });
    expect(parseOpen({ mode: "region" })).toBeNull();
    expect(parseOpen({ mode: "display" })).toBeNull();
  });
});

describe("answerText", () => {
  it("joins the agent's text after the request, then what streams", () => {
    const msg = (id: string, role: "user" | "agent", md: string) =>
      ({ id, role, blocks: [{ type: "text", md }] }) as never;
    const messages = [
      msg("m_0", "agent", "old"),
      msg("m_1", "user", "q"),
      msg("m_2", "agent", "A"),
    ];
    expect(answerText(messages, "m_1", [{ text: "B" }])).toBe("A\n\nB");
    expect(answerText(messages, "missing", [])).toBe("");
  });
});

describe("imageChoice", () => {
  it("sends the image for a region, when always on, or when the request is about the screen", () => {
    const o = { mode: "window" as const, always: false, text: "what's the weather" };
    expect(imageChoice("auto", o)).toBe("auto");
    expect(imageChoice("auto", { ...o, text: "what does this mean" })).toBe("pinned");
    expect(imageChoice("auto", { ...o, mode: "region" })).toBe("pinned");
    expect(imageChoice("auto", { ...o, always: true })).toBe("pinned");
    expect(imageChoice("dropped", { ...o, mode: "region" })).toBe("dropped");
  });
});

describe("ScreenAsk", () => {
  it("captures on open, sends to a new chat with the capture, and opens the thread", async () => {
    const { platform, bridge, calls, bridged, open } = setup();
    render(<ScreenAsk platform={platform} bridge={bridge} />);
    open({ mode: "window" });
    await waitFor(() =>
      expect(screen.getByTestId("screen-ask-chip").textContent).toContain("Safari"),
    );
    expect(calls.filter(([m]) => m === "screen.capture")).toEqual([
      ["screen.capture", { mode: "window" }],
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Always send the screenshot" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "What is this?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    await waitFor(() => expect(calls.some(([m]) => m === "chat.send")).toBe(true));
    expect(calls.find(([m]) => m === "chat.send")?.[1]).toMatchObject({
      threadId: "th_new",
      content: "What is this?",
      screen: { captureId: "cap_1", image: "pinned" },
    });
    await waitFor(() => screen.getByRole("button", { name: "Open in Psyche" }));
    fireEvent.click(screen.getByRole("button", { name: "Open in Psyche" }));
    expect(bridged).toContain("open:th_new");
    // A sent capture belongs to the thread now: closing doesn't discard it.
    fireEvent.keyDown(screen.getByTestId("screen-ask"), { key: "Escape" });
    expect(calls.some(([m]) => m === "screen.discard")).toBe(false);
  });

  it("Esc before sending discards the capture and closes", async () => {
    const { platform, bridge, calls, bridged, open } = setup();
    render(<ScreenAsk platform={platform} bridge={bridge} />);
    open({ mode: "window" });
    await waitFor(() =>
      expect(screen.getByTestId("screen-ask-chip").textContent).toContain("Safari"),
    );
    fireEvent.keyDown(screen.getByTestId("screen-ask"), { key: "Escape" });
    expect(calls.at(-1)).toEqual(["screen.discard", { captureId: "cap_1" }]);
    expect(bridged).toEqual(["done"]);
    expect(screen.queryByTestId("screen-ask")).toBeNull();
  });

  it("a dropped capture sends no screen and is discarded; current chat goes to the main thread", async () => {
    const { platform, bridge, calls, open } = setup();
    render(<ScreenAsk platform={platform} bridge={bridge} />);
    open({ mode: "window" });
    await waitFor(() =>
      expect(screen.getByTestId("screen-ask-chip").textContent).toContain("Safari"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Don't send what's on screen" }));
    fireEvent.click(screen.getByRole("button", { name: "Current chat" }));
    await waitFor(() =>
      expect(calls).toContainEqual([
        "settings.set",
        { key: "screenAsk.destination", value: "current" },
      ]),
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "hi" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    await waitFor(() => expect(calls.some(([m]) => m === "chat.send")).toBe(true));
    const sent = calls.find(([m]) => m === "chat.send")?.[1] as Record<string, unknown>;
    expect(sent.threadId).toBe("th_main");
    expect(sent.screen).toBeUndefined();
    expect(calls).toContainEqual(["screen.discard", { captureId: "cap_1" }]);
  });

  it("a region open replaces the capture and keeps the text", async () => {
    const { platform, bridge, calls, open } = setup();
    render(<ScreenAsk platform={platform} bridge={bridge} />);
    open({ mode: "window" });
    await waitFor(() =>
      expect(screen.getByTestId("screen-ask-chip").textContent).toContain("Safari"),
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "keep me" } });
    open({ mode: "region", rect: { x: 0, y: 0, width: 100, height: 100 } });
    await waitFor(() => expect(calls.filter(([m]) => m === "screen.capture")).toHaveLength(2));
    expect(calls).toContainEqual(["screen.discard", { captureId: "cap_1" }]);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("keep me");
  });

  it("a busy current chat sends the ask to a new chat instead", async () => {
    const { platform, bridge, calls, open } = setup({ busyMain: true });
    render(<ScreenAsk platform={platform} bridge={bridge} />);
    open({ mode: "window" });
    await waitFor(() =>
      expect(screen.getByTestId("screen-ask-chip").textContent).toContain("Safari"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Current chat" }));
    await waitFor(() => expect(calls.some(([m]) => m === "settings.set")).toBe(true));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "what is this" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    await waitFor(() => screen.getByRole("button", { name: "Open in Psyche" }));
    const sends = calls
      .filter(([m]) => m === "chat.send")
      .map(([, p]) => p as Record<string, unknown>);
    expect(sends.map((p) => p.threadId)).toEqual(["th_main", "th_new"]);
    expect(sends[1]?.screen).toEqual({ captureId: "cap_1", image: "pinned" });
  });
});
