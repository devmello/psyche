import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";
import { IDS } from "../fixtures/index.ts";
import { HomeScreen } from "../home/HomeScreen.tsx";
import { MemoryScreen } from "../memory-page/MemoryScreen.tsx";
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
  sheet?: "approvals" | "soul";
}) {
  const [route, setRoute] = useState(props.start ?? `/chat/${IDS.threads.dentist}`);
  // The places have content of their own; other routes stay empty in these layout stories.
  const page = route.startsWith("/home") ? (
    <section className="flex min-h-0 flex-1 flex-col overflow-auto">
      <HomeScreen now={STORY_NOW} onNavigate={setRoute} />
    </section>
  ) : route.startsWith("/memory") ? (
    <section className="flex min-h-0 flex-1 flex-col overflow-auto">
      <MemoryScreen now={STORY_NOW} onNavigate={setRoute} />
    </section>
  ) : null;
  return (
    <AppShell
      route={route}
      onNavigate={setRoute}
      now={STORY_NOW}
      defaultSidebarOpen={props.sidebar ?? true}
      defaultSidebarMode={props.mode ?? "full"}
      {...(props.compact === undefined ? {} : { compact: props.compact })}
      {...(props.sheet === undefined ? {} : { defaultSheet: props.sheet })}
    >
      {page}
    </AppShell>
  );
}

export const MainWindow: Story = { render: () => <Main /> };

export const MainWindowInactive: Story = {
  decorators: [inactiveWindow],
  render: () => <Main />,
};

export const MainWindowHome: Story = { render: () => <Main start="/home" /> };

/**
 * #625: the agent sheet beside the chat; the chat column, composer and toolbar reflow. The
 * sidebar is hidden so the 960 px baseline has room for both (the content keeps 480 px).
 */
export const AgentSheetBeside: Story = { render: () => <Main sheet="approvals" sidebar={false} /> };
/** #625: Soul beside Home. */
export const AgentSheetBesideHome: Story = {
  render: () => <Main start="/home" sheet="soul" sidebar={false} />,
};
/** #625: too narrow for both (the full sidebar at 960 px): the modal sheet over the content. */
export const AgentSheetNarrow: Story = { render: () => <Main sheet="approvals" /> };

export const SidebarCollapsed: Story = { render: () => <Main sidebar={false} /> };

/** The compact, icon-only rail (#598; ⌥⌘B, ⌥-click on the toggle, or a drag below 180 px). */
export const SidebarRail: Story = { render: () => <Main mode="rail" /> };

export const SidebarRailHome: Story = { render: () => <Main mode="rail" start="/home" /> };

/**
 * The compact rail expanded by hover (a rest of 250 ms; it folds 300 ms after the pointer
 * leaves): laid over the content, whose column keeps its place beside the 64 px rail. The play
 * function rests the pointer on the rail; `no-visual` because the open state depends on timers.
 */
export const SidebarRailPeek: Story = {
  tags: ["no-visual"],
  render: () => <Main mode="rail" start="/home" />,
  play: async ({ canvasElement }) => {
    const host = canvasElement.querySelector('[data-testid="sidebar-host"]');
    host?.dispatchEvent(
      new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse", clientX: 20 }),
    );
  },
};

/** The same peek over the chat, in a narrow 720 px window. */
export const SidebarRailPeekNarrow: Story = {
  tags: ["no-visual"],
  render: () => (
    <div className="mx-auto h-dvh w-[720px] overflow-hidden border-x border-separator">
      <Main mode="rail" />
    </div>
  ),
  play: SidebarRailPeek.play,
};

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
          route="/home"
          onNavigate={() => {}}
          activeThreadId={IDS.threads.dentist}
          onOpenThread={() => {}}
          onNewSideChat={() => {}}
          onOpenSearch={() => {}}
          onWidthChange={() => {}}
          now={STORY_NOW}
        />
      </div>
    </ShellMotion>
  ),
};

/** Home carries the amber needs-you count; a page reached from Home (Scheduled) keeps it marked. */
export const SidebarNeedsYou: Story = {
  render: () => (
    <ShellMotion>
      <div className="flex h-[640px]">
        <Sidebar
          route="/scheduled"
          onNavigate={() => {}}
          activeThreadId={null}
          onOpenThread={() => {}}
          onNewSideChat={() => {}}
          onOpenSearch={() => {}}
          onWidthChange={() => {}}
          counts={{ home: 3 }}
          now={STORY_NOW}
        />
      </div>
    </ShellMotion>
  ),
};

/** On Memory: the row is current; the needs-you count stays on Home. */
export const SidebarOnMemory: Story = {
  render: () => (
    <ShellMotion>
      <div className="flex h-[640px]">
        <Sidebar
          route="/memory"
          onNavigate={() => {}}
          activeThreadId={null}
          onOpenThread={() => {}}
          onNewSideChat={() => {}}
          onOpenSearch={() => {}}
          onWidthChange={() => {}}
          counts={{ home: 1 }}
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
      <TabBar active="home" onNavigate={() => {}} badges={{ home: 2 }} />
    </div>
  ),
};

/** The shell opens a result in a side chat beside the view (⌘L), so the palette offers it. */
export const Palette: Story = {
  render: () => (
    <CommandPalette
      open
      onOpenChange={() => {}}
      onNavigate={() => {}}
      onOpenInSideChat={() => {}}
    />
  ),
};

export const PaletteResults: Story = {
  render: () => (
    <CommandPalette
      open
      onOpenChange={() => {}}
      onNavigate={() => {}}
      onOpenInSideChat={() => {}}
      initialQuery="dentist"
    />
  ),
};

/** A typed query lists the matching actions first, then the results; the first action is selected. */
export const PaletteActionsFirst: Story = {
  render: () => (
    <CommandPalette
      open
      onOpenChange={() => {}}
      onNavigate={() => {}}
      onOpenInSideChat={() => {}}
      actions={[{ id: "dentist-notes", label: "Open dentist notes", run: () => {} }]}
      initialQuery="dentist"
    />
  ),
};

/** Every screen and Settings section is a palette action: "voice" finds Settings → Voice. */
export const PaletteSettingsSearch: Story = {
  render: () => (
    <CommandPalette
      open
      onOpenChange={() => {}}
      onNavigate={() => {}}
      onOpenInSideChat={() => {}}
      initialQuery="voice"
    />
  ),
};

export const PaletteMemorySearch: Story = {
  render: () => (
    <CommandPalette
      open
      onOpenChange={() => {}}
      onNavigate={() => {}}
      onOpenInSideChat={() => {}}
      initialQuery="memory review"
    />
  ),
};

export const Shortcuts: Story = { render: () => <ShortcutTable /> };
