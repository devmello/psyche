import { describe, expect, it, vi } from "vitest";
import { pairingEdge } from "../src/lib/pairing-edge.ts";

describe("pairingEdge", () => {
  it("runs pairing work once per pairing, not on every health tick", () => {
    const onPaired = vi.fn();
    const onUnpaired = vi.fn();
    const edge = pairingEdge({ onPaired, onUnpaired });
    edge({ phase: "connecting" });
    expect(onUnpaired).not.toHaveBeenCalled();
    edge({ phase: "paired" });
    // The connection re-reports the same status on each 10 s health check.
    for (let i = 0; i < 5; i++) edge({ phase: "paired" });
    expect(onPaired).toHaveBeenCalledTimes(1);
    edge({ phase: "connecting" });
    edge({ phase: "connecting" });
    expect(onUnpaired).toHaveBeenCalledTimes(1);
    edge({ phase: "paired" });
    expect(onPaired).toHaveBeenCalledTimes(2);
  });
});
