import { render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useCall, useGatewayQuery, useStore } from "../src/data/index.ts";
import { OnboardingFlow } from "../src/screens/onboarding/index.ts";

/** Kit components rendered outside a <GatewayProvider> stay idle instead of throwing (#560). */
describe("data hooks without a GatewayProvider", () => {
  it("renders the onboarding flow bare, with its built-in connector list", () => {
    render(<OnboardingFlow onComplete={() => {}} />);
    expect(screen.getByRole("navigation", { name: "Onboarding progress" })).toBeTruthy();
  });

  it("keeps queries idle (no data, no error, not loading), enabled or not", () => {
    const { result } = renderHook(() => ({
      on: useGatewayQuery("connectors.list", {}),
      off: useGatewayQuery("connectors.list", {}, { enabled: false }),
    }));
    for (const q of [result.current.on, result.current.off]) {
      expect(q.data).toBeUndefined();
      expect(q.error).toBeNull();
      expect(q.loading).toBe(false);
    }
  });

  it("rejects calls with a clear reason and reports the store as detached", async () => {
    const { result } = renderHook(() => ({ call: useCall(), store: useStore() }));
    expect(result.current.store.detached).toBe(true);
    expect(result.current.store.getState().connection).toBe("offline");
    await expect(result.current.call("connectors.list", {})).rejects.toThrow(
      /outside <GatewayProvider>/,
    );
  });
});
