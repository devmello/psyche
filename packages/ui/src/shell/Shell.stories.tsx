import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { IDS } from "../fixtures/index.ts";
import { STORY_NOW, withWorld } from "../stories/harness.tsx";
import { AppShell } from "./AppShell.tsx";
import { Rail } from "./Rail.tsx";
import { ShortcutTable } from "./ShortcutList.tsx";
import { ThreadList } from "./ThreadList.tsx";

const meta = {
  title: "Shell/Layout",
  decorators: [withWorld()],
  parameters: { layout: "fullscreen" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const MainWindow: Story = {
  render: () => {
    const [route, setRoute] = useState(`/chat/${IDS.threads.dentist}`);
    return <AppShell route={route} onNavigate={setRoute} now={STORY_NOW} />;
  },
};

export const RailWide: Story = {
  render: () => (
    <div className="h-[600px]">
      <Rail active="chat" onNavigate={() => {}} badges={{ feed: 3, ideas: 1 }} />
    </div>
  ),
};

export const RailCompact: Story = {
  render: () => <Rail compact active="feed" onNavigate={() => {}} />,
};

export const Threads: Story = {
  render: () => (
    <div className="h-[600px]">
      <ThreadList
        activeThreadId={IDS.threads.dentist}
        onOpen={() => {}}
        onNewSideChat={() => {}}
        now={STORY_NOW}
      />
    </div>
  ),
};

export const Shortcuts: Story = { render: () => <ShortcutTable /> };
