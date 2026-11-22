import type { Meta, StoryObj } from "@storybook/react-vite";
import { withWorld } from "../../stories/harness.tsx";
import { AddMachineSheet, MachinesGroup, MachinesPanel } from "./MachinesGroup.tsx";
import {
  DEDICATED_BOX,
  FULL_SHELL_BOX,
  IDENTITIES,
  LAB_BOX,
  MACHINES_NOW,
  OFFLINE_BOX,
  OUTDATED_BOX,
  SUDO_BOX,
  USER_LIMITS_BOX,
} from "./machine-fixtures.ts";

const noop = () => {};
const resolved = () => Promise.resolve();

const meta = {
  title: "Screens/Settings/Computers Psyche can use",
  component: MachinesPanel,
  parameters: { layout: "padded" },
  args: {
    machines: [LAB_BOX],
    identities: IDENTITIES,
    now: MACHINES_NOW,
    latestHelperVersion: "0.9.2",
    onAdd: noop,
    onWatch: noop,
    onOpenApps: noop,
    onOpenFolders: noop,
    onRemove: noop,
    onRename: resolved,
  },
  decorators: [withWorld()],
} satisfies Meta<typeof MachinesPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Nothing paired yet. */
export const Empty: Story = { args: { machines: [] } };

/** Online, on the owner's account, contained shell, limits user-owned. */
export const Online: Story = {};

export const Offline: Story = { args: { machines: [OFFLINE_BOX] } };

/** The helper is behind the newest one: the row says how to update it. */
export const UpdateAvailable: Story = {
  args: { machines: [OUTDATED_BOX], latestHelperVersion: "0.9.2" },
};

/** A separate `psyche` account: Psyche sees only that account. */
export const DedicatedAccount: Story = { args: { machines: [DEDICATED_BOX] } };

/** The contained shell is off: commands run with everything the account can reach. */
export const FullShell: Story = { args: { machines: [FULL_SHELL_BOX] } };

/** The limits file is the account's own, so any program on the account can change it. */
export const UserOwnedLimits: Story = { args: { machines: [USER_LIMITS_BOX] } };

export const PasswordlessSudo: Story = { args: { machines: [SUDO_BOX] } };

/** Several computers, one per state. */
export const AllStates: Story = {
  args: {
    machines: [
      LAB_BOX,
      OFFLINE_BOX,
      OUTDATED_BOX,
      DEDICATED_BOX,
      FULL_SHELL_BOX,
      USER_LIMITS_BOX,
      SUDO_BOX,
    ],
  },
};

export const Dark: Story = {
  args: { machines: [LAB_BOX, FULL_SHELL_BOX, SUDO_BOX] },
  globals: { theme: "dark" },
};

/** Connected to the mock Gateway: rename, remove and the add sheet work. */
export const Connected: Story = {
  decorators: [
    withWorld({
      onGateway: (g) => {
        g.pairMachine(LAB_BOX);
        g.pairMachine(DEDICATED_BOX);
      },
    }),
  ],
  render: () => <MachinesGroup now={MACHINES_NOW} />,
};

/** The add sheet on its first step: network (when both are on) and the account choice. */
export const AddSheet: Story = {
  decorators: [withWorld()],
  render: () => <AddMachineSheet open onOpenChange={noop} now={MACHINES_NOW} />,
};
