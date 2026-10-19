import type { Decorator } from "@storybook/react-vite";
import { createContext, type ReactElement, type ReactNode, useContext, useMemo } from "react";
import { DisclosureProvider } from "../blocks/disclosure.tsx";
import { Toaster } from "../components/ui/sonner.tsx";
import { TooltipProvider } from "../components/ui/tooltip.tsx";
import { GatewayProvider, GatewayStore } from "../data/index.ts";
import { MockGateway, type MockGatewayOptions } from "../data/mock-gateway.ts";
import { createFixtureWorld, FIXTURE_NOW, type FixtureWorld, PERSONA } from "../fixtures/index.ts";
import { type UiSlots, UiSlotsProvider } from "../slots.tsx";

/** Fixed clock for every story so countdowns and "2 h ago" are stable in snapshots. */
export const STORY_NOW = Date.parse(FIXTURE_NOW);

export interface StoryWorldProps {
  /** Edits the fixture world before the mock Gateway starts. */
  edit?: (world: FixtureWorld) => void;
  /** Called with the gateway, e.g. to script events. */
  onGateway?: (gateway: MockGateway) => void;
  options?: MockGatewayOptions;
  slots?: UiSlots;
  children?: ReactNode;
}

const InWorld = createContext(false);

/** Mock Gateway + store + slots around a story or test (no network). */
export function StoryWorld({
  edit,
  onGateway,
  options,
  slots,
  children,
}: StoryWorldProps): ReactElement {
  // A story-level world nested in the meta-level one wins; only the outer one renders a Toaster.
  const nested = useContext(InWorld);
  const { gateway, store } = useMemo(() => {
    const world = createFixtureWorld();
    edit?.(world);
    const gateway = new MockGateway(world, { now: () => FIXTURE_NOW, ...options });
    onGateway?.(gateway);
    return { gateway, store: new GatewayStore(gateway, { now: () => FIXTURE_NOW }) };
    // The world is built once per story mount.
    // biome-ignore lint/correctness/useExhaustiveDependencies: built once per mount
  }, []);
  return (
    <InWorld.Provider value={true}>
      <GatewayProvider client={gateway} store={store}>
        <UiSlotsProvider value={{ persona: { name: PERSONA.name, creature: "moth" }, ...slots }}>
          <TooltipProvider>
            <DisclosureProvider keyboard={false}>{children}</DisclosureProvider>
          </TooltipProvider>
          {nested ? null : <Toaster />}
        </UiSlotsProvider>
      </GatewayProvider>
    </InWorld.Provider>
  );
}

/** Storybook decorator form of `StoryWorld`. */
export function withWorld(props: Omit<StoryWorldProps, "children"> = {}): Decorator {
  return (Story) => (
    <StoryWorld {...props}>
      <Story />
    </StoryWorld>
  );
}
