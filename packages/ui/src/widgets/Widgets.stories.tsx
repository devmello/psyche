import type { Widget } from "@psyche/protocol";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { createFixtureWorld, IDS } from "../fixtures/index.ts";
import { FeedPostCard } from "../screens/feed/FeedPostCard.tsx";
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
import { interactiveWidget } from "./fixtures-interactive.ts";
import {
  chartsWidget,
  dataImageWidget,
  mapWidget,
  remoteImageTaintedWidget,
  remoteImageWidget,
} from "./fixtures-media.ts";
import { withFeedWidget } from "./fixtures-surfaces.ts";
import { McpAppPanel } from "./McpAppPanel.tsx";
import { PinnedWidgets } from "./PinnedWidgets.tsx";
import { WidgetBlockView } from "./WidgetBlock.tsx";

const meta = {
  title: "Chat/Widgets",
  // The renderer is lazy; load its chunks first so baselines never catch the skeleton.
  loaders: [
    async () => {
      await Promise.all([
        import("./WidgetView.tsx"),
        import("./WidgetChart.tsx"),
        import("./WidgetImage.tsx"),
      ]);
      return {};
    },
  ],
} satisfies Meta;
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

const showWith = (widget: Widget, settings: Record<string, unknown> = {}): Story => ({
  render: () => (
    <StoryWorld
      edit={(w) => {
        w.widgets = [widget];
        Object.assign(w.settings, settings);
      }}
    >
      <div className="max-w-[640px] p-4">
        <WidgetBlockView block={{ type: "ui", widgetId: widget.id }} />
      </div>
    </StoryWorld>
  ),
});

/** Bar, line and sparkline: dash patterns and markers as well as colour, a data table behind each. */
export const Charts: Story = showWith(chartsWidget);
export const ImageData: Story = showWith(dataImageWidget);
/** Remote images are off by default (D3): a note, no request. */
export const ImageRemoteOff: Story = showWith(remoteImageWidget);
/** Allowed by the owner, but this widget is untrusted: nothing loads until a click. */
export const ImageRemoteUntrusted: Story = showWith(remoteImageTaintedWidget, {
  "widgets.remoteImages": true,
});
/** A place list with Open in Maps: no tiles (D4). */
export const PlaceList: Story = showWith(mapWidget);

/** Reply button, choices, a form and a list action: outline controls, nothing fires by itself. */
export const Interactive: Story = showWith(interactiveWidget);

/** Pinned widgets on the Overview: live through their bindings, open and reply only. */
export const PinnedOnOverview: Story = {
  render: () => (
    <StoryWorld
      edit={(w) => {
        w.widgets = [
          { ...boundWidget(IDS.tasks.dentist, IDS.threads.dentist), pinned: true },
          { ...progressWidget, pinned: true },
        ];
      }}
    >
      <div className="max-w-[640px] p-4">
        <PinnedWidgets />
      </div>
    </StoryWorld>
  ),
};

/** A Feed post's widget: a static snapshot, open and reply only, taint carried. */
export const FeedSnapshot: Story = {
  render: () => {
    const post = createFixtureWorld().feed.find((f) => f.id === IDS.feed.briefing);
    return (
      <StoryWorld>
        <div className="max-w-[640px] p-4">
          {post ? (
            <FeedPostCard post={withFeedWidget(post)} onFeedback={() => {}} onAsk={() => {}} />
          ) : null}
        </div>
      </StoryWorld>
    );
  },
};

/** An MCP App a connector's tool declares: untrusted, closed until Run app, no way back to the Gateway. */
export const McpApp: Story = {
  render: () => (
    <StoryWorld
      onGateway={(g) => {
        g.mcpApps = {
          mcp__echo__show_chart: {
            serverId: "echo",
            uri: "ui://echo/chart.html",
            html: "<p>Chart</p>",
            csp: {},
            permissions: {},
            provenance: "untrusted",
          },
        };
      }}
    >
      <div className="max-w-[640px] p-4">
        <McpAppPanel tool="mcp__echo__show_chart" />
      </div>
    </StoryWorld>
  ),
};
