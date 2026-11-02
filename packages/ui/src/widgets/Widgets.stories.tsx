import type { Meta, StoryObj } from "@storybook/react-vite";
import { IDS } from "../fixtures/index.ts";
import { StoryWorld } from "../stories/harness.tsx";
import {
  dataWidget,
  frozenWidget,
  progressWidget,
  spoofWidget,
  tabsWidget,
  taintedWidget,
} from "./fixtures.ts";
import { boundWidget } from "./fixtures-bound.ts";
import { WidgetBlockView } from "./WidgetBlock.tsx";

const meta = { title: "Chat/Widgets" } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const show = (
  id: string,
  widgets = [progressWidget, dataWidget, tabsWidget, taintedWidget, frozenWidget, spoofWidget],
): Story => ({
  render: () => (
    <StoryWorld
      edit={(w) => {
        w.widgets = widgets;
      }}
    >
      <div className="max-w-[640px] p-4">
        <WidgetBlockView block={{ type: "ui", widgetId: id }} />
      </div>
    </StoryWorld>
  ),
});

export const Progress: Story = show("wdg_progress");
export const DataAndTable: Story = show("wdg_data");
export const TabsAndContent: Story = show("wdg_tabs");
export const Untrusted: Story = show("wdg_tainted");
export const Frozen: Story = show("wdg_frozen");
/** A widget dressed as an approval stays a widget: host chrome, no approval accent or icons. */
export const ApprovalLookalike: Story = show("wdg_spoof");

/** Bound to a task of the chat: stays current from `task.updated` with no model involved. */
export const BoundToTask: Story = show("wdg_bound", [
  boundWidget(IDS.tasks.dentist, IDS.threads.dentist),
]);
