// @vitest-environment happy-dom
import type { OnboardingResult } from "@psyche/ui";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { completeOnboarding } from "../../src/compose/PsycheApp.tsx";
import { ServerSetupEntry, useClaimLanChoice } from "../../src/compose/server-setup.tsx";
import type { GatewaysPort, ShellPlatform } from "../../src/shell/platform.ts";

afterEach(cleanup);

const result: OnboardingResult = {
  persona: { name: "Wren", creatureId: "moth", creatureDescription: null, tagline: "" },
  permissions: { accessibility: "skipped", screenRecording: "skipped", notifications: "skipped" },
  connectors: [],
  model: {
    kind: "cloud",
    provider: "anthropic",
    modelRef: "anthropic/claude-sonnet-5-5",
    keyRef: null,
    toolCheck: "untested",
  },
};

function platform(info: unknown = {}, gateways?: Partial<GatewaysPort>) {
  const calls: { method: string; params: unknown }[] = [];
  const p = {
    gateway: {
      call: async (method: string, params: unknown) => {
        calls.push({ method, params });
        if (method === "gateway.info") return info;
        if (method === "memory.read") return { content: "" };
        if (method === "threads.list") return { threads: [] };
        return {};
      },
    },
    ...(gateways ? { gateways } : {}),
  } as unknown as ShellPlatform;
  return { p, calls };
}

let seen: boolean | null = null;
function Probe({ pl, on }: { pl: ShellPlatform; on: boolean }) {
  seen = useClaimLanChoice(pl, on).keepLan;
  return null;
}

describe("onboarding on a server this computer just claimed (design §3.6)", () => {
  it("answers the network question last, after onboarding is marked done", async () => {
    const { p, calls } = platform();
    await completeOnboarding(p, result, undefined, { keepLan: false });
    const methods = calls.map((c) => c.method);
    expect(methods.at(-1)).toBe("gateway.claim.finish");
    expect(calls.at(-1)?.params).toEqual({ keepLan: false });
    expect(methods.indexOf("settings.set")).toBeLessThan(methods.indexOf("gateway.claim.finish"));
  });

  it("asks nothing of a Gateway that wasn't claimed", async () => {
    const { p, calls } = platform();
    await completeOnboarding(p, result);
    expect(calls.some((c) => c.method === "gateway.claim.finish")).toBe(false);
  });

  it("shows the question only when the server says it is pending", async () => {
    seen = null;
    const pending = platform({ claim: { lanChoicePending: true } });
    const { rerender } = render(<Probe pl={pending.p} on={false} />);
    expect(pending.calls).toEqual([]);
    rerender(<Probe pl={pending.p} on />);
    await waitFor(() => expect(seen).toBe(true));
    cleanup();
    seen = null;
    const plain = platform({});
    render(<Probe pl={plain.p} on />);
    await waitFor(() => expect(plain.calls.length).toBe(1));
    expect(seen).toBe(null);
  });
});

describe("Connect to a Psyche server on first run", () => {
  const entry = (remote: boolean) => ({
    id: remote ? "gw_0123456789ab" : "this-mac",
    name: remote ? "lab-box" : "This Mac",
    origin: remote ? "https://lab-box.local:7979" : null,
    remote,
    active: true,
    pinned: remote,
  });
  const port = (remote: boolean): Partial<GatewaysPort> => ({
    list: vi.fn(async () => [entry(remote)]),
    claim: vi.fn(async () => entry(true)),
  });

  it("is offered on This Mac's own Gateway", async () => {
    const { p } = platform({}, port(false));
    render(<ServerSetupEntry platform={p} />);
    expect(await screen.findByRole("button", { name: "Connect to a Psyche server" })).toBeTruthy();
  });

  it("is not offered once the window is on a remote Gateway", async () => {
    const gateways = port(true);
    const { p } = platform({}, gateways);
    render(<ServerSetupEntry platform={p} />);
    await waitFor(() => expect(gateways.list).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Connect to a Psyche server" })).toBeNull();
  });
});
