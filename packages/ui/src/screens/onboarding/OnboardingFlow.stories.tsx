import type { Meta, StoryObj } from "@storybook/react-vite";
import { withWorld } from "../../stories/harness.tsx";
import { OnboardingFlow } from "./OnboardingFlow.tsx";
import { ConnectorsStep, PermissionsStep } from "./OnboardingSteps.tsx";

const noop = () => {};

const meta = {
  title: "Screens/Onboarding/OnboardingFlow",
  component: OnboardingFlow,
  decorators: [withWorld()],
  args: {
    onComplete: noop,
    ramGb: 32,
    onRequestPermission: () => "granted" as const,
    onConnect: () => true,
    onSaveKey: (provider: string) => `vault:${provider}-api-key`,
    onCheckModel: () => "passed" as const,
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof OnboardingFlow>;

export default meta;
type Story = StoryObj<typeof meta>;

const wren = {
  name: "Wren",
  creatureId: "moth",
  tagline: "Quiet wings, careful hands.",
};

export const MeetYourAgent: Story = {};
export const MeetDescribedCreature: Story = {
  args: {
    initial: {
      persona: {
        ...wren,
        creatureMode: "describe",
        creatureDescription: "a small grey moth with lantern eyes",
      },
    },
  },
};
export const MeetKeepPsyche: Story = {
  args: { initial: { persona: { name: "Psyche", creatureId: "owl" } } },
};

export const Permissions: Story = {
  args: { defaultStep: "permissions", initial: { persona: wren } },
};
export const PermissionsAnswered: Story = {
  args: {
    defaultStep: "permissions",
    initial: {
      persona: wren,
      permissions: {
        accessibility: "granted",
        screenRecording: "denied",
        notifications: "skipped",
      },
    },
  },
};
export const PermissionsAsking: Story = {
  render: () => (
    <PermissionsStep
      persona="Wren"
      value={{ accessibility: "granted", screenRecording: "pending", notifications: "pending" }}
      busy="screenRecording"
      onAllow={noop}
      onSkip={noop}
    />
  ),
};

export const Connectors: Story = {
  args: { defaultStep: "connectors", initial: { persona: wren } },
};
export const ConnectorsOneConnected: Story = {
  args: {
    defaultStep: "connectors",
    initial: {
      persona: wren,
      connectors: [{ type: "google", label: "Google (Gmail, Calendar, Drive)", mode: "read_act" }],
    },
  },
};
export const ConnectorsFailed: Story = {
  render: () => (
    <ConnectorsStep
      persona="Wren"
      connected={[]}
      onConnect={noop}
      error="Psyche couldn't connect that account (the sign-in window was closed)."
    />
  ),
};

export const ModelCloudKey: Story = {
  args: { defaultStep: "model", initial: { persona: wren } },
};
export const ModelKeyStoredAndChecked: Story = {
  args: {
    defaultStep: "model",
    initial: {
      persona: wren,
      model: {
        kind: "cloud",
        provider: "anthropic",
        modelRef: "anthropic/claude-sonnet-5-5",
        keyRef: "vault:anthropic-api-key",
        toolCheck: "passed",
      },
    },
  },
};
export const ModelLocalSmallMac: Story = {
  args: {
    defaultStep: "model",
    ramGb: 16,
    initial: {
      persona: wren,
      model: {
        kind: "local",
        provider: "ollama",
        modelRef: "ollama/gemma4-e4b",
        keyRef: null,
        toolCheck: "failed",
      },
    },
  },
};
export const ModelCheckRunning: Story = {
  args: {
    defaultStep: "model",
    initial: {
      persona: wren,
      model: {
        kind: "openrouter",
        provider: "openrouter",
        modelRef: "openrouter/auto",
        keyRef: "vault:openrouter-api-key",
        toolCheck: "running",
      },
    },
  },
};
export const ModelNoKeyStorage: Story = {
  args: { defaultStep: "model", initial: { persona: wren }, onSaveKey: undefined },
};

export const WhereLocalMac: Story = {
  args: { defaultStep: "where", initial: { persona: wren } },
};
export const WhereVmMode: Story = {
  args: { defaultStep: "where", initial: { persona: wren, workspace: "vm" } },
};
export const WhereVmUnavailable: Story = {
  args: { defaultStep: "where", initial: { persona: wren }, vmAvailable: false },
};

export const Done: Story = {
  args: {
    defaultStep: "done",
    initial: {
      persona: wren,
      permissions: {
        accessibility: "granted",
        screenRecording: "granted",
        notifications: "skipped",
      },
      connectors: [{ type: "google", label: "Google (Gmail, Calendar, Drive)", mode: "read" }],
      model: {
        kind: "cloud",
        provider: "anthropic",
        modelRef: "anthropic/claude-sonnet-5-5",
        keyRef: "vault:anthropic-api-key",
        toolCheck: "passed",
      },
      workspace: "local",
    },
  },
};
