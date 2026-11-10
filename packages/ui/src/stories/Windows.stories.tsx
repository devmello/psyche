import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactElement } from "react";
import {
  createFixtureWorld,
  WINDOWS_IDS,
  windowsDevices,
  windowsNodes,
  windowsPresenceKeys,
} from "../fixtures/index.ts";
import { OnboardingFlow } from "../screens/onboarding/OnboardingFlow.tsx";
import { ConnectorsStep } from "../screens/onboarding/OnboardingSteps.tsx";
import type { TouchIdSetupPort } from "../screens/onboarding/types.ts";
import { ComputerUsePanel } from "../screens/settings/ComputerUseSection.tsx";
import { DevicesPanel } from "../screens/settings/DevicesSection.tsx";
import { MacHelperStatusRow } from "../screens/settings/MacHelperStatus.tsx";
import { sampleSettings } from "../screens/settings/sample-data.ts";
import { VmSection } from "../screens/settings/VmSection.tsx";
import { VoicePanel } from "../screens/settings/VoiceSection.tsx";
import { ShortcutTable } from "../shell/ShortcutList.tsx";
import { STORY_NOW, withPlatform, withWorld } from "./harness.tsx";

/**
 * The Windows variants (docs/design/cross-platform-2026.md): the same screens with Windows copy
 * ("This PC", Windows Hello, Ctrl shortcuts), what Windows asks for instead of the macOS privacy
 * panes, the Windows helper and its RSA-2048 Windows Hello key, and Mac-only features saying
 * "Available on macOS". Every story renders as on Windows (`withPlatform`).
 */
const meta = {
  title: "Platform/Windows",
  decorators: [withPlatform("windows"), withWorld()],
  parameters: { layout: "padded" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const noop = () => {};
const world = createFixtureWorld();
const values = { ...world.settings, ...sampleSettings() };

const helloPort = (registered: boolean): TouchIdSetupPort => ({
  status: () =>
    Promise.resolve({
      identity: {
        deviceId: WINDOWS_IDS.device,
        keyId: WINDOWS_IDS.keyId,
        kind: "windows_hello",
        algorithm: "RSA-2048",
      },
      registered,
    }),
  register: () => Promise.resolve(),
});

/** Onboarding's Safety step: Windows Hello, notifications, and what Windows asks for. */
export const OnboardingSafety: Story = {
  render: (): ReactElement => (
    <OnboardingFlow
      defaultStep="safety"
      initial={{ persona: { name: "Wren", creatureId: "moth", tagline: "" } }}
      helper={{ kind: "paired" }}
      touchId={helloPort(false)}
      onComplete={noop}
      onRequestPermission={() => "granted" as const}
    />
  ),
};

/** Your stuff on Windows: no Apple apps; Microsoft, Google and IMAP carry mail and calendar. */
export const OnboardingStuff: Story = {
  render: (): ReactElement => <ConnectorsStep persona="Wren" connected={[]} onConnect={noop} />,
};

/** Settings → Computer use: Windows access instead of the macOS privacy panes. */
export const ComputerUse: Story = {
  render: (): ReactElement => (
    <ComputerUsePanel
      values={values}
      onChange={noop}
      persona="Wren"
      tcc={{ microphone: "denied" }}
      onOpenSystemSettings={noop}
    />
  ),
};

/** Settings → Devices: this PC, the Windows helper and its Windows Hello (RSA-2048) key. */
export const Devices: Story = {
  render: (): ReactElement => (
    <DevicesPanel
      devices={windowsDevices()}
      pairing={[]}
      nodes={windowsNodes()}
      presenceKeys={windowsPresenceKeys()}
      now={STORY_NOW}
      thisDeviceId={WINDOWS_IDS.device}
      onRevoke={noop}
    />
  ),
};

/** The Windows helper's status row, offline, with Restart helper. */
export const HelperOffline: Story = {
  render: (): ReactElement => (
    <MacHelperStatusRow
      state={{ kind: "offline", reason: "the helper exited" }}
      onRestart={() => Promise.resolve({ kind: "paired" })}
    />
  ),
};

/** Voice & dictation: Right Alt / Right Ctrl, and no Accessibility grant to ask for. */
export const Voice: Story = {
  render: (): ReactElement => (
    <VoicePanel
      values={{ ...values, "voice.pushToTalk": "fn" }}
      onChange={noop}
      system={{ helper: "online", accessibility: "unknown", watching: true }}
    />
  ),
};

/** VM mode on Windows is the sandbox PC (a Linux guest in Hyper-V): the desktop turns it on. */
export const VmSandboxPc: Story = { render: (): ReactElement => <VmSection /> };

/** The keyboard map in Windows keys (Ctrl, Alt, Shift as text). */
export const Shortcuts: Story = { render: (): ReactElement => <ShortcutTable /> };
