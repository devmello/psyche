import type { Meta, StoryObj } from "@storybook/react-vite";
import { withWorld } from "../stories/harness.tsx";
import { ClearChatDialog } from "./ClearChatDialog.tsx";

/** "Clear the main chat?": what goes, what stays, "also forget" off by default. */
const meta = {
  title: "Chat/Clear chat dialog",
  component: ClearChatDialog,
  decorators: [withWorld()],
  args: {
    open: true,
    onOpenChange: () => {},
    onConfirm: async () => {},
  },
} satisfies Meta<typeof ClearChatDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** The chat is working or waiting on you: the confirm button is off, with the reason. */
export const ChatIsWorking: Story = { args: { busy: true } };

export const Dark: Story = { globals: { theme: "dark" } };
