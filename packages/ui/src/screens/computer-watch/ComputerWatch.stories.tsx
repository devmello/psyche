import type { Meta, StoryObj } from "@storybook/react-vite";
import { ComputerWatch } from "./ComputerWatch.tsx";
import { fakeClient, STOPPED } from "./fixtures.ts";

const noop = () => {};

const meta = {
  title: "Screens/ComputerWatch/ComputerWatch",
  component: ComputerWatch,
  args: { visible: true, client: fakeClient(), onLook: noop, onDiscard: noop, onKeepOpen: noop },
  decorators: [
    (Story) => (
      <div style={{ height: 480, width: 560 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ComputerWatch>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The screen is running and the agent drives. */
export const Running: Story = {};

/** The owner took over; the agent is paused. */
export const TakenOver: Story = {
  args: { client: fakeClient({ ...fakeClient().state, takenOver: true }) },
};

/** A task is parked on an app's "Save changes?" dialog. */
export const Parked: Story = { args: { parked: true } };

/** Nothing is running. */
export const Stopped: Story = { args: { client: fakeClient(STOPPED) } };
