import type { SpecialistRole } from "@psyche/protocol";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { specialistRoles } from "../../fixtures/index.ts";
import { withWorld } from "../../stories/harness.tsx";
import { SPECIALIST_KEYS, SpecialistsPanel, SpecialistsSection } from "./SpecialistsSection.tsx";

/** Settings → Specialists (docs/agent/specialists-2026.md §6.4). */
const meta = {
  title: "Screens/Settings/Specialists",
  decorators: [withWorld()],
  parameters: { layout: "padded" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const noop = () => {};
const MODELS = ["anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-5", "ollama/qwen3:32b"];
const installed: SpecialistRole = {
  ...(specialistRoles()[0] as SpecialistRole),
  role: "travel-agent",
  label: "Travel agent",
  description: "Plans trips and holds fares. Never books.",
  skill: "travel-agent",
  source: "home",
  enabled: false,
};

/** The connected section on the fixture Gateway. */
export const Default: Story = { render: () => <SpecialistsSection /> };

/** The researcher's editor open, with a pinned model and a smaller budget. */
export const EditingRole: Story = {
  render: () => (
    <SpecialistsPanel
      values={{
        [SPECIALIST_KEYS.model("researcher")]: "anthropic/claude-opus-5-5",
        [SPECIALIST_KEYS.budget("researcher")]: { tokens: 250_000, costUsd: 1.5, minutes: 20 },
        [SPECIALIST_KEYS.maxConcurrent]: 2,
        [SPECIALIST_KEYS.monthlyCapUsd]: 15,
      }}
      onChange={noop}
      roles={[...specialistRoles(), installed]}
      models={MODELS}
      monthlyBudgetUsd={20}
      openRoles={["researcher"]}
    />
  ),
};

/** Admin keys refused on this device say so under their field. */
export const NeedsApproval: Story = {
  render: () => (
    <SpecialistsPanel
      values={{}}
      onChange={noop}
      needsApproval={new Set([SPECIALIST_KEYS.maxConcurrent, SPECIALIST_KEYS.enabled("coder")])}
      roles={specialistRoles()}
      models={MODELS}
    />
  ),
};

export const NoRoles: Story = {
  render: () => <SpecialistsPanel values={{}} onChange={noop} roles={[]} />,
};

export const Loading: Story = {
  render: () => <SpecialistsPanel values={{}} onChange={noop} roles={[]} loading />,
};
