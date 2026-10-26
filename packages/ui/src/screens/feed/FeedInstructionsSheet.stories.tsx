import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { withWorld } from "../../stories/harness.tsx";
import {
  type EditableRow,
  FeedInstructionsSheet,
  FeedInstructionsView,
} from "./FeedInstructionsSheet.tsx";
import { FEED_INSTRUCTIONS_PATH, INTERESTS_PATH } from "./interests.ts";

/** "What should I write about" (issue #614): the Feed instructions sheet over the feed. */
const meta = {
  title: "Screens/Feed/Instructions",
  decorators: [withWorld()],
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** The workspace has interests and instructions already. */
export const Populated: Story = {
  decorators: [
    withWorld({
      edit: (w) => {
        w.memoryFiles[FEED_INSTRUCTIONS_PATH] =
          "More robotics papers, fewer launch announcements. Favour primary sources. Keep posts to three sentences.\n";
      },
    }),
  ],
  render: () => <FeedInstructionsSheet open onClose={() => {}} onSchedule={() => {}} />,
};

/** A new workspace: no instructions file and an empty ledger. */
export const Empty: Story = {
  decorators: [
    withWorld({
      edit: (w) => {
        delete w.memoryFiles[FEED_INSTRUCTIONS_PATH];
        w.memoryFiles[INTERESTS_PATH] = "";
        w.automations = w.automations.filter((a) => a.kind !== "briefing");
      },
    }),
  ],
  render: () => <FeedInstructionsSheet open onClose={() => {}} onSchedule={() => {}} />,
};

/** While Save writes the two files. */
export const Saving: Story = {
  render: () => <FeedInstructionsSheet open saving onClose={() => {}} onSchedule={() => {}} />,
};

/** A file couldn't be read: what failed, nothing changed, Try again. */
export const LoadError: Story = {
  decorators: [withWorld({ onGateway: (g) => g.failNext("memory.read", "unavailable") })],
  render: () => <FeedInstructionsSheet open onClose={() => {}} onSchedule={() => {}} />,
};

/** The body on its own, as it sits in the sheet. */
export const Body: Story = {
  render: function Render() {
    const [text, setText] = useState("");
    const [rows, setRows] = useState<EditableRow[]>([
      {
        kind: "topic",
        topic: "robotics manipulation",
        weight: 0.9,
        why: "asked 6 times in Sept",
        key: "a",
      },
      { kind: "topic", topic: "Lisbon", weight: 0.6, why: "trip in November", key: "b" },
      { kind: "exclude", topic: "celebrity news", why: "dismissed 4 posts", key: "c" },
    ]);
    return (
      <div className="w-[480px] bg-surface-overlay p-5">
        <FeedInstructionsView
          instructions={text}
          onInstructionsChange={setText}
          rows={rows}
          onRowsChange={setRows}
          schedule="weekdays 07:00"
          onSchedule={() => {}}
        />
      </div>
    );
  },
};
