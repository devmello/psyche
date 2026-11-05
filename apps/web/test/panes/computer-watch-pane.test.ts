import { describe, expect, it, vi } from "vitest";
import { viewCommandToAction } from "../../src/shell/layout/view-commands.ts";
import { watchClient } from "../../src/shell/panes/ComputerWatchPane.tsx";

function fakeStore(answers: Record<string, unknown>) {
  const calls: { method: string; params: unknown }[] = [];
  return {
    calls,
    store: {
      call: vi.fn(async (method: string, params: unknown) => {
        calls.push({ method, params });
        return answers[method];
      }),
    },
  };
}

const STATUS = {
  state: "running",
  display: ":90",
  width: 1280,
  height: 800,
  apps: [],
  takenOver: false,
  frameSeq: 1,
  startedAt: null,
};

describe("the watch pane's client", () => {
  it("reads the status and reports whether a card is waiting", async () => {
    const { store } = fakeStore({ "computerWatch.status": { status: STATUS, parked: true } });
    const parked = vi.fn();
    const client = watchClient(store as never, parked);
    expect(await client.status()).toEqual(STATUS);
    expect(parked).toHaveBeenCalledWith(true);
  });

  it("pulls frames with since and maxWidth only when given", async () => {
    const { store, calls } = fakeStore({ "computerWatch.frame": { changed: false } });
    const client = watchClient(store as never, () => undefined);
    await client.frame(undefined);
    await client.frame(7, 640);
    expect(calls.map((c) => c.params)).toEqual([{}, { since: 7, maxWidth: 640 }]);
  });

  it("forwards input, take over and stop", async () => {
    const { store, calls } = fakeStore({
      "computerWatch.input": { ok: true },
      "computerWatch.takeOver": { takenOver: true },
      "computerWatch.stop": { ok: false },
    });
    const parked = vi.fn();
    const client = watchClient(store as never, parked);
    await client.input([{ type: "text", text: "a" }]);
    await client.setTakenOver(true);
    await client.stop();
    expect(calls.map((c) => c.method)).toEqual([
      "computerWatch.input",
      "computerWatch.takeOver",
      "computerWatch.stop",
    ]);
    // A stop the helper refused means an app asks to save: the card shows.
    expect(parked).toHaveBeenCalledWith(true);
  });

  it("fails when the Gateway does not offer the method", async () => {
    const { store } = fakeStore({});
    await expect(watchClient(store as never, () => undefined).status()).rejects.toThrow(
      "not available",
    );
  });
});

describe("the Gateway opens the pane", () => {
  it("maps view.command open computer-watch to a layout action", () => {
    const mapped = viewCommandToAction({ command: "open", args: { pane: "computer-watch" } });
    expect(mapped).toMatchObject({ ok: true, action: { type: "open", pane: "computer-watch" } });
  });
});
