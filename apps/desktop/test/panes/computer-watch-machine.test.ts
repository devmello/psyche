import { describe, expect, it, vi } from "vitest";
import { watchClient } from "../../src/shell/panes/ComputerWatchPane.tsx";

function fakeStore() {
  const calls: { method: string; params: unknown }[] = [];
  return {
    calls,
    store: {
      call: vi.fn(async (method: string, params: unknown) => {
        calls.push({ method, params });
        return method === "computerWatch.status"
          ? { status: { state: "stopped" }, parked: false }
          : { ok: true, changed: false, takenOver: true };
      }),
    },
  };
}

describe("the watch pane's client for a paired computer", () => {
  it("names the machine on every call", async () => {
    const { store, calls } = fakeStore();
    const client = watchClient(store as never, () => undefined, "mch_lab");
    await client.status();
    await client.frame(3, 640);
    await client.input([{ type: "text", text: "a" }]);
    await client.setTakenOver(true);
    await client.stop();
    expect(calls.map((c) => c.params)).toEqual([
      { machine: "mch_lab" },
      { machine: "mch_lab", since: 3, maxWidth: 640 },
      { machine: "mch_lab", events: [{ type: "text", text: "a" }] },
      { machine: "mch_lab", on: true },
      { machine: "mch_lab", closeApps: true },
    ]);
  });

  it("sends nothing extra for the Host's own screen", async () => {
    const { store, calls } = fakeStore();
    const client = watchClient(store as never, () => undefined);
    await client.status();
    await client.setTakenOver(false);
    expect(calls.map((c) => c.params)).toEqual([{}, { on: false }]);
  });
});
