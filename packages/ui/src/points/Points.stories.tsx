import type { PointsWindow } from "@psyche/protocol";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ReactElement, useState } from "react";
import { withWorld } from "../stories/harness.tsx";
import { PointsProvider } from "./PointsContext.tsx";
import { PointsOfferCard } from "./PointsOfferCard.tsx";
import { PointsSettingsGroup } from "./PointsSettings.tsx";
import { PointsStartSheet, type PointsStartSheetProps } from "./PointsStartSheet.tsx";

/**
 * Psyche points (docs/design/psyche-points-2026.md §6.2): the start sheet, the Chat offer card and
 * the Settings subsection, each in light and dark. Ink accent, paper grays, one accent per view.
 */

const noop = () => {};

const WINDOWS: readonly PointsWindow[] = [
  {
    ref: "w1",
    app: { bundleId: "com.apple.Safari", name: "Safari" },
    title: "Federal tax return 2026",
    frontmost: true,
  },
  {
    ref: "w2",
    app: { bundleId: "com.apple.Preview", name: "Preview" },
    title: "DS-160 visa application.pdf",
    frontmost: false,
  },
  {
    ref: "w3",
    app: { bundleId: "com.apple.Terminal", name: "Terminal" },
    title: "zsh",
    frontmost: false,
    refusal: "terminal_or_ide",
  },
];

function Sheet(p: Partial<PointsStartSheetProps>): ReactElement {
  const [selected, setSelected] = useState<string | null>(p.selected ?? "w1");
  const [goal, setGoal] = useState(p.goal ?? "");
  return (
    <PointsStartSheet
      open
      onOpenChange={noop}
      list={{ status: "ready", windows: WINDOWS }}
      onRetry={noop}
      selected={selected}
      onSelect={setSelected}
      goal={goal}
      onGoal={setGoal}
      persona="Psyche"
      starting={false}
      failed={false}
      onStart={noop}
      onStopSession={noop}
      {...p}
    />
  );
}

const meta: Meta<typeof Sheet> = {
  title: "Points/Start sheet",
  component: Sheet,
  parameters: { layout: "fullscreen" },
  decorators: [withWorld()],
};
export default meta;
type Story = StoryObj<typeof Sheet>;

export const Ready: Story = { args: { goal: "2026 tax return, married filing jointly" } };
export const ReadyDark: Story = { args: { goal: "Visa paperwork" }, globals: { theme: "dark" } };

/** Accessibility is missing: the same row as Settings → Computer use, and Start waits. */
export const PermissionMissing: Story = {
  args: { accessibility: { state: "not_determined", offline: false, onAllow: noop } },
};
export const PermissionMissingDark: Story = {
  args: { accessibility: { state: "denied", offline: false, onAllow: noop } },
  globals: { theme: "dark" },
};
export const HelperOffline: Story = {
  args: { accessibility: { state: "not_determined", offline: true, onAllow: noop } },
};
export const LoadingWindows: Story = { args: { list: { status: "loading" }, selected: null } };
export const NoWindows: Story = {
  args: { list: { status: "ready", windows: [] }, selected: null },
};
export const WindowsFailed: Story = { args: { list: { status: "error" }, selected: null } };
export const LocalModel: Story = { args: { local: true } };
export const Starting: Story = { args: { starting: true } };
export const StartFailed: Story = { args: { failed: true } };
export const Running: Story = {
  args: { session: { app: "Safari", state: "pointing", step: 3, of: 11 } },
};
export const RunningDark: Story = {
  args: { session: { app: "Safari", state: "reading", step: 0, of: 0 } },
  globals: { theme: "dark" },
};

const OFFER = { type: "points_offer" as const, goal: "Walk me through the 2026 visa form" };

function PointsWorld({ children }: { children: ReactElement }): ReactElement {
  return <PointsProvider>{children}</PointsProvider>;
}

/** Where Points isn't available (no provider): the card says where to start it. */
export const OfferElsewhere: Story = {
  render: () => (
    <div className="max-w-md p-4">
      <PointsOfferCard block={OFFER} />
    </div>
  ),
};

/** A Mac Host's own desktop with Points on: the button opens the sheet with the goal. */
export const OfferAvailable: Story = {
  decorators: [
    withWorld({
      edit: (w) => {
        w.hostOs = "macos";
        w.settings["points.enabled"] = true;
        w.pointsWindows = [...WINDOWS];
      },
      slots: {
        points: {
          helperStatus: () =>
            Promise.resolve({
              helper: "online" as const,
              accessibility: "granted" as const,
              screenRecording: "granted" as const,
            }),
          helperRequest: () =>
            Promise.resolve({
              helper: "online" as const,
              accessibility: "granted" as const,
              screenRecording: "granted" as const,
            }),
        },
      },
    }),
  ],
  render: () => (
    <div className="max-w-md p-4">
      <PointsWorld>
        <PointsOfferCard block={OFFER} />
      </PointsWorld>
    </div>
  ),
};
export const OfferAvailableDark: Story = { ...OfferAvailable, globals: { theme: "dark" } };

export const SettingsGroup: Story = {
  render: () => (
    <div className="max-w-xl p-4">
      <PointsSettingsGroup enabled onChange={noop} />
    </div>
  ),
};
export const SettingsGroupDark: Story = {
  render: () => (
    <div className="max-w-xl p-4">
      <PointsSettingsGroup enabled={false} onChange={noop} />
    </div>
  ),
  globals: { theme: "dark" },
};
