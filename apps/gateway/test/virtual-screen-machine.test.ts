import { describe, expect, it, vi } from "vitest";

vi.mock("@psyche/db", () => ({
  getMachine: (_db: unknown, id: string) =>
    id === "mch_lab" ? { id, deviceId: "dev_lab" } : undefined,
}));

import { composeVirtualScreen } from "../src/compose/virtual-screen.ts";

const STATUS = {
  state: "running",
  display: ":91",
  width: 1280,
  height: 800,
  apps: [] as unknown[],
  takenOver: false,
  frameSeq: 7,
  startedAt: "2026-11-05T10:00:00.000Z",
};
const FRAME = { changed: true, frameSeq: 8, image: "AAAA", width: 1280, height: 800 };

/** A composed part with a Host helper and (optionally) a live machine `dev_lab`. */
function part(machine: "online" | "offline" | "no_screen") {
  const hostCalls: { capability: string; params: unknown }[] = [];
  const machineCalls: { capability: string; params: unknown }[] = [];
  const answer = (capability: string) =>
    capability === "vscreen.frame"
      ? FRAME
      : capability === "vscreen.status"
        ? STATUS
        : { ok: true };
  const composed = composeVirtualScreen({
    attention: { paneHidden: () => false },
    publish: () => undefined,
    clock: { now: () => 1_000 },
  } as never);
  composed.start?.({
    context: {
      db: {},
      nodes: {
        hostHelper: () => ({
          client: {
            async invoke(capability: string, params: unknown) {
              hostCalls.push({ capability, params });
              return { ok: true, result: answer(capability) };
            },
          },
        }),
        machine: (deviceId: string) =>
          machine !== "offline" && deviceId === "dev_lab"
            ? {
                info: {
                  capabilities:
                    machine === "no_screen"
                      ? []
                      : [
                          { name: "vscreen.status" },
                          { name: "vscreen.frame" },
                          { name: "vscreen.input" },
                        ],
                },
                client: {
                  async invoke(capability: string, params: unknown) {
                    machineCalls.push({ capability, params });
                    return { ok: true, result: answer(capability) };
                  },
                },
              }
            : undefined,
      },
    },
  } as never);
  const run = (method: string, params: unknown) =>
    (composed.handlers as Record<string, { run: (c: unknown, p: unknown) => unknown }>)[
      method
    ]?.run({ identity: { desktopShell: true }, method }, params);
  return { run, hostCalls, machineCalls };
}

describe("the watch pane's machine param", () => {
  it("routes only to the named machine and never sends `machine` to the helper", async () => {
    const { run, hostCalls, machineCalls } = part("online");
    expect(await run("computerWatch.status", { machine: "mch_lab" })).toMatchObject({
      status: { display: ":91" },
    });
    await run("computerWatch.frame", { machine: "mch_lab", since: 3 });
    await run("computerWatch.input", { machine: "mch_lab", events: [{ type: "text", text: "x" }] });
    expect(hostCalls).toEqual([]);
    expect(machineCalls.map((c) => c.capability)).toEqual([
      "vscreen.status",
      "vscreen.frame",
      "vscreen.input",
    ]);
    expect(machineCalls[1]?.params).toEqual({ since: 3 });
  });

  it("without a machine, the Host's screen is used and the machine is not touched", async () => {
    const { run, hostCalls, machineCalls } = part("online");
    await run("computerWatch.status", {});
    expect(hostCalls.map((c) => c.capability)).toEqual(["vscreen.status"]);
    expect(machineCalls).toEqual([]);
  });

  it("an offline machine answers machine_offline and does not fall back to the Host", async () => {
    const { run, hostCalls } = part("offline");
    await expect(run("computerWatch.status", { machine: "mch_lab" })).rejects.toMatchObject({
      code: "unavailable",
      details: { reason: "machine_offline" },
    });
    expect(hostCalls).toEqual([]);
  });

  it("a machine with no screen capability answers machine_surface_unavailable", async () => {
    const { run } = part("no_screen");
    await expect(run("computerWatch.status", { machine: "mch_lab" })).rejects.toMatchObject({
      details: { reason: "machine_surface_unavailable" },
    });
  });

  it("an unknown or malformed machine id is refused", async () => {
    const { run, hostCalls } = part("online");
    await expect(run("computerWatch.status", { machine: "mch_nope" })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(run("computerWatch.status", { machine: 7 })).rejects.toMatchObject({
      code: "invalid_params",
    });
    expect(hostCalls).toEqual([]);
  });

  it("keeps take-over per computer", async () => {
    const { run } = part("online");
    await run("computerWatch.takeOver", { on: true, machine: "mch_lab" });
    expect(await run("computerWatch.takeOver", { on: false })).toEqual({ takenOver: false });
    const again = (await run("computerWatch.takeOver", { on: true, machine: "mch_lab" })) as {
      takenOver: boolean;
    };
    expect(again.takenOver).toBe(true);
  });
});
