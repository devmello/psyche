import { beforeEach, describe, expect, it, vi } from "vitest";

// pmset's answers, switched by each test: what `pmset -g batt` says about the power source.
let source = "Battery Power";
vi.mock("node:child_process", () => ({
  execFile: (
    _file: string,
    args: string[],
    _opts: unknown,
    cb: (err: null, out: string) => void,
  ) => {
    cb(
      null,
      args.includes("batt")
        ? `Now drawing from '${source}'\n -InternalBattery-0\t65%; charging;`
        : " lowpowermode         0\n",
    );
  },
}));

const { powerReader } = await import("../src/compose/search-files.ts");

beforeEach(() => {
  source = "Battery Power";
});

describe("powerReader", () => {
  it("answers a stale cached read after plugging in, and fresh() re-reads it now", async () => {
    const read = powerReader("darwin", 60_000);
    await read.fresh();
    expect(read()).toEqual({ onBattery: true, lowPower: false });

    // Plugged in since: the cached read still says battery until something re-reads it.
    source = "AC Power";
    expect(read().onBattery).toBe(true);
    await expect(read.fresh()).resolves.toEqual({ onBattery: false, lowPower: false });
    expect(read()).toEqual({ onBattery: false, lowPower: false });
  });

  it("is plugged in off macOS without asking pmset", async () => {
    const read = powerReader("linux");
    expect(read()).toEqual({ onBattery: false, lowPower: false });
    await expect(read.fresh()).resolves.toEqual({ onBattery: false, lowPower: false });
  });
});
