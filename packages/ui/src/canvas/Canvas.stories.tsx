import type { Meta, StoryObj } from "@storybook/react-vite";
import { CANVAS_IDS, canvasFixtures } from "../fixtures/canvas.ts";
import { IDS } from "../fixtures/ids.ts";
import { StoryWorld } from "../stories/harness.tsx";
import { CanvasPane } from "./CanvasPane.tsx";

/** The output canvas (docs/design/chat-experience-2026.md §4.2). */

const meta = { title: "Chat/Canvas" } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const withCanvas = (world: object) => {
  const fx = canvasFixtures();
  const w = world as { artifacts: unknown[]; artifactHistory?: unknown };
  w.artifacts.push(...fx.artifacts);
  w.artifactHistory = fx.artifactHistory;
};

const Frame = ({ id }: { id: string }) => (
  <div className="h-[560px] w-[520px] border border-separator">
    <CanvasPane artifactId={id} threadId={IDS.threads.lisbon} onSelect={() => {}} />
  </div>
);

export const Document: Story = {
  render: () => (
    <StoryWorld edit={withCanvas}>
      <Frame id={CANVAS_IDS.doc} />
    </StoryWorld>
  ),
};

export const Table: Story = {
  render: () => (
    <StoryWorld edit={withCanvas}>
      <Frame id={CANVAS_IDS.table} />
    </StoryWorld>
  ),
};

export const Chart: Story = {
  render: () => (
    <StoryWorld edit={withCanvas}>
      <Frame id={CANVAS_IDS.chart} />
    </StoryWorld>
  ),
};

export const Diff: Story = {
  render: () => (
    <StoryWorld edit={withCanvas}>
      <Frame id={CANVAS_IDS.diff} />
    </StoryWorld>
  ),
};
