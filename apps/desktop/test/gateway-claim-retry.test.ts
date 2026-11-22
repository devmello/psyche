import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ClaimError, type ClaimOptions, type ClaimProblem } from "../src/lib/claim-client.ts";
import { GatewayManager } from "../src/main/gateway-manager.ts";

const dir = mkdtempSync(join(tmpdir(), "psyche-claim-retry-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const OK = {
  gatewayKey: Buffer.alloc(32, 7).toString("base64url"),
  certSpki: Buffer.alloc(32, 8).toString("base64url"),
  hostName: "lab-box",
};

/** A manager whose claim handshake answers from `script`, one entry per attempt. */
function setup(script: Array<ClaimProblem | "ok">) {
  const userData = mkdtempSync(join(dir, "ud-"));
  const seen: string[] = [];
  const m = new GatewayManager({
    userData,
    target: {
      id: "this-mac",
      name: "This Mac",
      origin: "http://127.0.0.1:7979",
      remote: false,
      dataDir: null,
    },
    confirm: async () => true,
    relaunch: () => {},
    claimServer: async (opts: ClaimOptions) => {
      seen.push(opts.device.deviceId);
      const next = script.shift();
      if (next === "ok") return OK;
      throw new ClaimError(next ?? "failed");
    },
  });
  return { m, seen };
}

const ADDRESS = "192.168.1.20";
const CODE = "7K3QM-XR2TD";

describe("a claim whose answer was lost", () => {
  it("keeps the device key and retries with it", async () => {
    const { m, seen } = setup(["unconfirmed", "ok"]);
    await expect(m.claim(ADDRESS, CODE)).rejects.toMatchObject({
      details: { problem: "claim_unreachable" },
    });
    const view = await m.claim(ADDRESS, CODE);
    expect(view.pinned).toBe(true);
    expect(seen).toHaveLength(2);
    // Same device key, so the server can finish the claim it already made.
    expect(seen[1]).toBe(seen[0]);
  });

  it("tells the owner to use a pairing link once the server has dropped the claim", async () => {
    const { m, seen } = setup(["unconfirmed", "not_claimable", "ok"]);
    await m.claim(ADDRESS, CODE).catch(() => undefined);
    await expect(m.claim(ADDRESS, CODE)).rejects.toMatchObject({
      details: { problem: "claim_maybe_claimed" },
    });
    // That key is given up: the next try starts over with a new one.
    await m.claim(ADDRESS, CODE);
    expect(seen[2]).not.toBe(seen[0]);
  });

  it("keeps the key through a wrong code on the retry, not on a first refusal", async () => {
    const a = setup(["unconfirmed", "wrong_code", "ok"]);
    await a.m.claim(ADDRESS, CODE).catch(() => undefined);
    await a.m.claim(ADDRESS, CODE).catch(() => undefined);
    await a.m.claim(ADDRESS, CODE);
    expect(new Set(a.seen).size).toBe(1);

    // A refusal on the first attempt means no admin was made: its key is dropped.
    for (const problem of [
      "wrong_code",
      "not_claimable",
      "too_many_attempts",
      "server_unproven",
    ] as const) {
      const b = setup([problem, "ok"]);
      await b.m.claim(ADDRESS, CODE).catch(() => undefined);
      await b.m.claim(ADDRESS, CODE);
      expect(new Set(b.seen).size).toBe(2);
    }
  });
});
