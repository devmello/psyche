import type { Meta, StoryObj } from "@storybook/react-vite";
import { AVATAR_STATE_LABEL, Avatar, type AvatarSize, type AvatarState } from "./Avatar.tsx";
import { CREATURES } from "./creatures/index.tsx";

const meta = { title: "Avatar/Avatar", component: Avatar, args: { name: "Wren" } } satisfies Meta<
  typeof Avatar
>;
export default meta;
type Story = StoryObj<typeof meta>;

const STATES = Object.keys(AVATAR_STATE_LABEL) as AvatarState[];
const SIZES: AvatarSize[] = [20, 28, 40, 64, 160];

export const States: Story = {
  render: () => (
    <ul className="flex flex-wrap gap-6">
      {STATES.map((s) => (
        <li key={s} className="flex flex-col items-center gap-1 text-xs">
          <Avatar name="Wren" state={s} size={64} count={2} />
          {AVATAR_STATE_LABEL[s]}
        </li>
      ))}
      <li className="flex flex-col items-center gap-1 text-xs">
        <Avatar name="Sam's agent" size={64} delegated />
        delegated
      </li>
    </ul>
  ),
};

export const Sizes: Story = {
  render: () => (
    <div className="flex items-end gap-4">
      {SIZES.map((size) => (
        <Avatar key={size} name="Wren" size={size} />
      ))}
    </div>
  ),
};

export const Working: Story = { args: { state: "working", size: 160 } };

export const BundledCreatures: Story = {
  render: () => (
    <ul className="grid grid-cols-4 gap-6">
      {CREATURES.map((c) => (
        <li key={c.id} className="flex flex-col items-center gap-1 text-xs">
          <Avatar name={c.name} creature={c.id} size={64} />
          <span>{c.name}</span>
        </li>
      ))}
    </ul>
  ),
};
