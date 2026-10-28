import type { Meta, StoryObj } from "@storybook/react-vite";
import { withWorld } from "../../stories/harness.tsx";
import { CapabilitiesScreen } from "./CapabilitiesScreen.tsx";

const noop = () => {};

const meta = {
  title: "Screens/Capabilities/CapabilitiesScreen",
  component: CapabilitiesScreen,
  decorators: [withWorld()],
  args: {
    onUsePrompt: noop,
    onCreateAutomation: () => Promise.resolve(),
    onConnect: noop,
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof CapabilitiesScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Nothing connected: only the cards that need no account are ready. */
export const NothingConnected: Story = { args: { connectedTypes: new Set() } };
export const MailAndCalendar: Story = {
  args: { connectedTypes: new Set(["apple:mail", "apple:calendar"]) },
};
export const Everything: Story = {
  args: {
    connectedTypes: new Set(["google", "apple:reminders", "apple:notes", "apple:calendar"]),
  },
};
