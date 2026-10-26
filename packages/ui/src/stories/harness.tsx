import type { Decorator } from "@storybook/react-vite";
import {
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
} from "react";
import { DisclosureProvider } from "../blocks/disclosure.tsx";
import { Toaster } from "../components/ui/sonner.tsx";
import { TooltipProvider } from "../components/ui/tooltip.tsx";
import { GatewayProvider, GatewayStore } from "../data/index.ts";
import { MockGateway, type MockGatewayOptions } from "../data/mock-gateway.ts";
import { createFixtureWorld, FIXTURE_NOW, type FixtureWorld, PERSONA } from "../fixtures/index.ts";
import { activeI18n, setActiveI18n } from "../i18n/core.ts";
import { I18nProvider } from "../i18n/I18nProvider.tsx";
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: the world is built once per mount
  const { gateway, store } = useMemo(() => {
    const world = createFixtureWorld();
    edit?.(world);
    const gateway = new MockGateway(world, { now: () => FIXTURE_NOW, ...options });
    onGateway?.(gateway);
    return { gateway, store: new GatewayStore(gateway, { now: () => FIXTURE_NOW }) };
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

/**
 * Renders `children` in `locale` (text, number and date formats, and `dir` on `<html>` so RTL
 * variants and the charts' mirroring apply), then puts the previous i18n and direction back so
 * later stories in the same page (the stories test renders them all) read English again.
 */
export function InLocale({
  locale,
  children,
}: {
  locale: string;
  children?: ReactNode;
}): ReactElement {
  const previous = useMemo(() => activeI18n(), []);
  const before = useMemo(
    () =>
      typeof document === "undefined"
        ? null
        : { lang: document.documentElement.lang, dir: document.documentElement.dir },
    [],
  );
  useEffect(
    () => () => {
      setActiveI18n(previous);
      if (before !== null) {
        document.documentElement.lang = before.lang;
        document.documentElement.dir = before.dir;
      }
    },
    [previous, before],
  );
  return (
    <I18nProvider locale={locale} applyToDocument>
      {children}
    </I18nProvider>
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
