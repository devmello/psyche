import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";
import { IDS } from "../fixtures/index.ts";
import { STORY_NOW, withWorld } from "../stories/harness.tsx";
import { AppShell } from "./AppShell.tsx";
import { CommandPalette } from "./CommandPalette.tsx";
import { CompactTopBar } from "./CompactTopBar.tsx";
import { ShellMotion } from "./motion.tsx";
import { TabBar } from "./Rail.tsx";
import { ShortcutTable } from "./ShortcutList.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { ThreadList } from "./ThreadList.tsx";

const meta = {
  title: "Shell/Layout",
  decorators: [withWorld()],
  parameters: { layout: "fullscreen" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** The window lost focus: the selection pill goes gray (A2 sets this from `blur`). */
const inactiveWindow: Decorator = (Story) => {
  useEffect(() => {
    document.documentElement.dataset.windowActive = "false";
    return () => {
      delete document.documentElement.dataset.windowActive;
    };
  }, []);
  return <Story />;
};

function Main(props: {
  start?: string;
  sidebar?: boolean;
  compact?: boolean;
  mode?: "full" | "rail";
  sheet?: "activity" | "upcoming";
}) {
  const [route, setRoute] = useState(props.start ?? `/chat/${IDS.threads.dentist}`);
  return (
    <AppShell
      route={route}
      onNavigate={setRoute}
      now={STORY_NOW}
      defaultSidebarOpen={props.sidebar ?? true}
      defaultSidebarMode={props.mode ?? "full"}
      {...(props.compact === undefined ? {} : { compact: props.compact })}
      {...(props.sheet === undefined ? {} : { defaultSheet: props.sheet })}
    />
  );
}

export const MainWindow: Story = { render: () => <Main /> };

export const MainWindowInactive: Story = {
  decorators: [inactiveWindow],
  render: () => <Main />,
};

export const MainWindowFeed: Story = { render: () => <Main start="/feed" /> };

/**
 * #625: the agent sheet beside the chat; the chat column, composer and toolbar reflow. The
 * sidebar is hidden so the 960 px baseline has room for both (the content keeps 480 px).
 */
export const AgentSheetBeside: Story = { render: () => <Main sheet="activity" sidebar={false} /> };
/** #625: the Feed's Schedule opens Upcoming beside the feed. */
export const AgentSheetBesideFeed: Story = {
  render: () => <Main start="/feed" sheet="upcoming" sidebar={false} />,
};
/** #625: too narrow for both (the full sidebar at 960 px): the modal sheet over the content. */
export const AgentSheetNarrow: Story = { render: () => <Main sheet="activity" /> };

export const SidebarCollapsed: Story = { render: () => <Main sidebar={false} /> };

/** The compact, icon-only rail (#598; ⌥⌘B, ⌥-click on the toggle, or a drag below 180 px). */
export const SidebarRail: Story = { render: () => <Main mode="rail" /> };

export const SidebarRailFeed: Story = { render: () => <Main mode="rail" start="/feed" /> };

export const Compact: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
  render: () => (
    <div className="mx-auto w-[390px]">
      <Main compact />
    </div>
  ),
};

export const SidebarAlone: Story = {
  render: () => (
    <ShellMotion>
      <div className="flex h-[640px]">
        <Sidebar
          route="/ideas"
          onNavigate={() => {}}
          activeThreadId={IDS.threads.dentist}
          onOpenThread={() => {}}
          onNewSideChat={() => {}}
          onWidthChange={() => {}}
          counts={{ ideas: 2, goals: 1 }}
          now={STORY_NOW}
        />
      </div>
    </ShellMotion>
  ),
};

export const ThreadsDrawer: Story = {
  render: () => (
    <div className="h-[600px] w-[320px]">
      <ThreadList
        activeThreadId={IDS.threads.dentist}
        onOpen={() => {}}
        onNewSideChat={() => {}}
        now={STORY_NOW}
      />
    </div>
  ),
};

export const CompactBars: Story = {
  render: () => (
    <div className="flex h-[300px] w-[390px] flex-col justify-between bg-canvas">
      <CompactTopBar
        onOpenThreads={() => {}}
        onOpenSearch={() => {}}
        mode="balanced"
        onModeChange={() => {}}
        onOpenModelPicker={() => {}}
      />
      <TabBar active="feed" onNavigate={() => {}} badges={{ ideas: 2 }} />
    </div>
  ),
};

export const Palette: Story = {
  render: () => <CommandPalette open onOpenChange={() => {}} onNavigate={() => {}} />,
};

export const PaletteResults: Story = {
  render: () => (
    <CommandPalette open onOpenChange={() => {}} onNavigate={() => {}} initialQuery="dentist" />
  ),
};

export const Shortcuts: Story = { render: () => <ShortcutTable /> };
