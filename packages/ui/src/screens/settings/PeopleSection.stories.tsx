import type { Meta, StoryObj } from "@storybook/react-vite";
import { graphWorld } from "../../fixtures/people.ts";
import { withWorld } from "../../stories/harness.tsx";
import { GRAPH_DEFAULTS, PeoplePanel, PeopleSection } from "./PeopleSection.tsx";

const status = graphWorld().status;
const on = {
  ...GRAPH_DEFAULTS,
  enabled: true,
  sources: { ...GRAPH_DEFAULTS.sources, contacts: true, mail: true, calendar: true },
};

const meta = {
  title: "Screens/Settings/People and projects",
  component: PeoplePanel,
  parameters: { layout: "padded" },
  args: { settings: on, onChange: () => {}, status, persona: "Wren" },
} satisfies Meta<typeof PeoplePanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const On: Story = { args: { onOpenOwnCard: () => {}, onExport: () => {} } };

/** First run: off, every source off except your chats. */
export const Off: Story = { args: { settings: GRAPH_DEFAULTS, status: null } };

export const Loading: Story = { args: { loading: true } };

export const Dark: Story = { args: { onOpenOwnCard: () => {} }, globals: { theme: "dark" } };

/** Connected to the mock Gateway (settings, graph status, your card, export). */
export const Connected: Story = {
  decorators: [
    withWorld({
      edit: (w) => {
        w.settings["memory.graph"] = on;
      },
    }),
  ],
  render: () => <PeopleSection />,
};
