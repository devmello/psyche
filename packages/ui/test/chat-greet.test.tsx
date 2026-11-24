import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useGreetEmptyMainChat } from "../src/chat/greet.ts";

type Opts = Parameters<typeof useGreetEmptyMainChat>[0];

function setup(overrides: Partial<Opts> & { threadId: string }) {
  const call = vi.fn((_method: "chat.greet", _params: { threadId: string }) =>
    Promise.resolve({ started: true, runId: "run_1" }),
  );
  const base = { kind: "main", empty: true, connected: true, call };
  const hook = renderHook((props: Partial<Opts>) =>
    useGreetEmptyMainChat({ ...base, ...overrides, ...props, threadId: overrides.threadId }),
  );
  return { call, hook };
}

describe("greeting the main chat (#555)", () => {
  it("asks the Gateway to greet an empty, connected main chat once", () => {
    const { call } = setup({ threadId: "thr_greet_once" });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith("chat.greet", { threadId: "thr_greet_once" });
  });

  it("does not ask again on re-render or a reconnect for the same thread", () => {
    const { call, hook } = setup({ threadId: "thr_greet_repeat" });
    hook.rerender({ connected: false });
    hook.rerender({ connected: true });
    hook.rerender({});
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("does not greet a main chat that already has messages", () => {
    const { call } = setup({ threadId: "thr_greet_has_messages", empty: false });
    expect(call).not.toHaveBeenCalled();
  });

  it("does not greet side or incognito threads", () => {
    const side = setup({ threadId: "thr_greet_side", kind: "side" });
    const incognito = setup({ threadId: "thr_greet_incognito", kind: "incognito" });
    expect(side.call).not.toHaveBeenCalled();
    expect(incognito.call).not.toHaveBeenCalled();
  });

  it("waits until the connection is open", () => {
    const { call, hook } = setup({ threadId: "thr_greet_offline", connected: false });
    expect(call).not.toHaveBeenCalled();
    hook.rerender({ connected: true });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when the Gateway refuses to greet", async () => {
    // A rejected call must not surface as an unhandled rejection (vitest fails on those).
    const call = vi.fn(() => Promise.reject(new Error("model down")));
    setup({ threadId: "thr_greet_fails", call });
    expect(call).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
