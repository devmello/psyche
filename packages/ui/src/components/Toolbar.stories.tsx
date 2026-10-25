import type { Meta, StoryObj } from "@storybook/react-vite";
import { Bell, ChevronDown, Ellipsis, PanelLeft, ShieldCheck } from "lucide-react";
import { Avatar } from "../avatar/Avatar.tsx";
import { Button } from "./ui/button.tsx";
import {
  Toolbar,
  ToolbarGroup,
  ToolbarLeading,
  ToolbarProvider,
  ToolbarSlot,
  ToolbarTitle,
  ToolbarTrailing,
  useToolbar,
} from "./ui/toolbar.tsx";

/** The unified toolbar (docs/design/redesign-2026.md §4): primitive, slot API and scroll edge. */
const meta = {
  title: "Primitives/Toolbar",
  parameters: { layout: "fullscreen" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const SidebarToggle = () => (
  <Button variant="ghost" size="icon-sm" aria-label="Show sidebar">
    <PanelLeft aria-hidden="true" />
  </Button>
);

function ChatToolbarContent() {
  return (
    <>
      <ToolbarLeading>
        <SidebarToggle />
        <Avatar name="Wren" size={28} state="working" />
      </ToolbarLeading>
      <ToolbarTitle title="Wren" subtitle="Holding the 2:30 slot" />
      <ToolbarTrailing>
        <ToolbarGroup>
          <Button variant="ghost" size="xs" className="rounded-full">
            <ShieldCheck aria-hidden="true" /> Balanced <ChevronDown aria-hidden="true" />
          </Button>
          <Button variant="ghost" size="xs" className="rounded-full">
            Sonnet 5.5 <ChevronDown aria-hidden="true" />
          </Button>
        </ToolbarGroup>
        <Button variant="ghost" size="icon-sm" aria-label="Notifications">
          <Bell aria-hidden="true" />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="More">
          <Ellipsis aria-hidden="true" />
        </Button>
      </ToolbarTrailing>
    </>
  );
}

const Lines = () => (
  <div className="flex flex-col gap-3 px-6 pt-4 pb-12">
    {Array.from({ length: 14 }, (_, i) => (
      <p
        // biome-ignore lint/suspicious/noArrayIndexKey: static filler
        key={i}
        className="max-w-[68ch] text-reading text-label-primary"
      >
        Content scrolls under the toolbar and fades through the scroll edge instead of meeting a
        hard border.
      </p>
    ))}
  </div>
);

export const ChatToolbar: Story = {
  render: () => (
    <div className="h-[420px] overflow-auto bg-canvas">
      <Toolbar className="sticky top-0">
        <ChatToolbarContent />
      </Toolbar>
      <Lines />
    </div>
  ),
};

function FeedScreen() {
  useToolbar({
    title: "Feed",
    subtitle: "Today · 7 posts",
    trailing: (
      <Button variant="outline" size="sm">
        What should I write about
      </Button>
    ),
  });
  return <Lines />;
}

export const RegisteredBySlot: Story = {
  render: () => (
    <ToolbarProvider>
      <div className="h-[420px] overflow-auto bg-canvas">
        <ToolbarSlot
          className="sticky top-0"
          start={<SidebarToggle />}
          fallback={{ title: "Psyche" }}
        />
        <FeedScreen />
      </div>
    </ToolbarProvider>
  ),
};

export const ChatToolbarHighContrast: Story = {
  ...ChatToolbar,
  globals: { contrast: "high" },
};
