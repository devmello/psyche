import type { Meta, StoryObj } from "@storybook/react-vite";
import { FileText, ListChecks } from "lucide-react";
import { CARD_STATUSES, Card } from "./card.tsx";
import { UnknownBlock } from "./registry.tsx";

/** The unified card shell and status vocabulary (docs/design/chat-experience-2026.md §4.1). */

const meta = { title: "Cards/Card shell" } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const noop = () => {};

export const Framed: Story = {
  render: () => (
    <div className="max-w-md">
      <Card
        label="Quarterly summary"
        icon={<FileText />}
        title="Quarterly summary"
        status={{ status: "done" }}
        meta="Document · v3"
        actions={[
          { id: "copy", label: "Copy", kind: "send", onSelect: noop },
          { id: "open", label: "Open", kind: "open", primary: true, onSelect: noop },
        ]}
      >
        <p className="text-body text-label-secondary">
          Revenue up 12%, two open risks, and a draft note for the board.
        </p>
      </Card>
    </div>
  ),
};

export const Pinned: Story = {
  render: () => (
    <div className="max-w-md">
      <Card
        variant="pinned"
        label="Plan"
        icon={<ListChecks />}
        title="Plan"
        status={{ status: "running" }}
        meta="2 of 5"
      />
    </div>
  ),
};

export const Statuses: Story = {
  render: () => (
    <div className="flex max-w-md flex-col">
      {CARD_STATUSES.map((status) => (
        <Card key={status} variant="inline" label={status} title={status} status={{ status }} />
      ))}
      <Card
        variant="inline"
        label="uncertain"
        title="done (outcome unknown)"
        status={{ status: "done", warning: true }}
      />
    </div>
  ),
};

export const UnknownType: Story = {
  render: () => <UnknownBlock type="specialist_result" />,
};
