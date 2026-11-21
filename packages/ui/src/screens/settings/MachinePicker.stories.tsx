import type { Meta, StoryObj } from "@storybook/react-vite";
import { withWorld } from "../../stories/harness.tsx";
import { ComputerUsePanel } from "./ComputerUseSection.tsx";
import { DEFAULT_MACHINE_KEY, MACHINE_APPS_KEY } from "./MachinePicker.tsx";
import { LAB_BOX, OFFLINE_BOX } from "./machine-fixtures.ts";

const values = {
  "computerUse.enabled": true,
  "computerUse.apps": [{ id: "com.apple.Notes", name: "Notes", tier: "interact" }],
  [DEFAULT_MACHINE_KEY]: "mch_lab",
  [MACHINE_APPS_KEY]: {
    mch_lab: [
      { id: "org.gnome.TextEditor", name: "Text Editor", tier: "interact" },
      { id: "firefox", name: "Firefox", tier: "read" },
    ],
  },
};

const meta = {
  title: "Screens/Settings/Computer use on a computer",
  component: ComputerUsePanel,
  parameters: { layout: "padded" },
  args: {
    values,
    onChange: () => {},
    persona: "Wren",
    tcc: {},
    machines: [LAB_BOX, OFFLINE_BOX],
  },
  decorators: [withWorld()],
} satisfies Meta<typeof ComputerUsePanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The picker sits above the Host's own page, which is unchanged. */
export const WithComputers: Story = {};

/** No computer paired: no picker, the page is what it always was. */
export const NoComputers: Story = { args: { machines: [] } };
