import type { ChecklistItem, Task } from "@psyche/protocol";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { createFixtureWorld, IDS } from "../fixtures/index.ts";
import { ArtifactCard, FileCard } from "./ArtifactCard.tsx";
import { Checklist, PlanCard } from "./Checklist.tsx";
import { DisclosureProvider } from "./disclosure.tsx";
import { Markdown } from "./Markdown.tsx";
import { ReceiptLine } from "./Receipt.tsx";
import { TaskCard } from "./TaskCard.tsx";
import { type ToolCallItem, ToolRun } from "./ToolRun.tsx";
import type { ToolCallBlock } from "./types.ts";
import { WrapUpBox } from "./WrapUp.tsx";

const w = createFixtureWorld();
const must = <T,>(v: T | undefined, what: string): T => {
  if (v === undefined) throw new Error(`fixture ${what} missing`);
  return v;
};

const meta = { title: "Blocks/Message blocks" } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const MD = `Three slots work with your **Tuesday** focus block. Holding the earliest.

- Tue 2:30 — fits your focus block
- Wed 9:00
- Thu 4:15

\`\`\`ts
const slot = await clinic.hold("2026-10-20T14:30");
\`\`\`

Details on [acme.com](https://acme.com/appointments). A [bad link](javascript:alert(1)) stays text.`;

export const MarkdownStatic: Story = { render: () => <Markdown>{MD}</Markdown> };
export const MarkdownStreaming: Story = {
  render: () => <Markdown streaming>{"Three slots work with your **Tues"}</Markdown>,
};

function toolItems(): ToolCallItem[] {
  const blocks = w.messages
    .flatMap((m) => m.blocks)
    .filter((b): b is ToolCallBlock => b.type === "tool_call");
  return blocks.slice(0, 4).map((block) => {
    const call = w.toolCalls.find((c) => c.id === block.toolCallId) ?? null;
    return {
      block,
      call,
      receipt: call?.receiptId ? (w.receipts.find((r) => r.id === call.receiptId) ?? null) : null,
    };
  });
}

export const ToolRunStatus: Story = {
  render: () => (
    <DisclosureProvider initial={0} keyboard={false}>
      <ToolRun items={toolItems()} />
    </DisclosureProvider>
  ),
};
export const ToolRunActions: Story = {
  render: () => (
    <DisclosureProvider initial={1} keyboard={false}>
      <ToolRun items={toolItems()} />
    </DisclosureProvider>
  ),
};
export const ToolRunRaw: Story = {
  render: () => (
    <DisclosureProvider initial={2} keyboard={false}>
      <ToolRun items={toolItems()} />
    </DisclosureProvider>
  ),
};

const items: ChecklistItem[] = [
  { text: "Find slots", status: "completed" },
  { text: "Hold slot", status: "in_progress" },
  { text: "Confirm", status: "pending" },
];
export const ChecklistInline: Story = { render: () => <Checklist items={items} /> };
export const ChecklistPinned: Story = { render: () => <Checklist items={items} pinned /> };

const dentist = must(
  w.tasks.find((t) => t.id === IDS.tasks.dentist),
  "dentist task",
);
export const Plan: Story = {
  render: () => (
    <PlanCard
      title={dentist.title}
      steps={dentist.plan?.steps ?? []}
      approvedAt={dentist.plan?.approvedAt ?? null}
      onOpen={() => {}}
    />
  ),
};

export const Receipts: Story = {
  render: () => (
    <div>
      {w.receipts.map((r) => (
        <ReceiptLine key={r.id} receipt={r} onOpen={() => {}} />
      ))}
    </div>
  ),
};

const statuses: Task["status"][] = [
  "queued",
  "running",
  "awaiting_input",
  "awaiting_approval",
  "paused",
  "done",
  "failed",
  "cancelled",
];
export const TaskCards: Story = {
  render: () => (
    <div>
      {statuses.map((status) => (
        <TaskCard
          key={status}
          task={{ ...dentist, id: `${dentist.id}_${status}`, status }}
          onOpen={() => {}}
          onPause={() => {}}
          onResume={() => {}}
          onCancel={() => {}}
          onRetry={() => {}}
        />
      ))}
    </div>
  ),
};

export const Artifacts: Story = {
  render: () => (
    <div>
      {w.artifacts.map((a) => (
        <ArtifactCard key={a.id} artifact={a} onOpen={() => {}} onSave={() => {}} />
      ))}
    </div>
  ),
};

export const Files: Story = {
  render: () => (
    <div>
      {w.library.slice(0, 4).map((i) => (
        <FileCard key={i.id} item={i} onOpen={() => {}} />
      ))}
      {w.library
        .filter((i) => i.quarantined)
        .map((i) => (
          <FileCard key={i.id} item={i} onOpen={() => {}} />
        ))}
    </div>
  ),
};

export const WrapUp: Story = {
  render: () => (
    <WrapUpBox
      block={{
        type: "wrap_up",
        recap: "Held Tue 2:30 at Acme Dental and sent the confirmation to Jane.",
        ask: "Add it to your calendar?",
        actions: [{ label: "Add it" }, { label: "Not now" }],
      }}
      onAction={() => {}}
    />
  ),
};
export const WrapUpRecapOnly: Story = {
  render: () => <WrapUpBox block={{ type: "wrap_up", recap: "Nothing else to do today." }} />,
};
