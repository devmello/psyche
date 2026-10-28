import type { Meta, StoryObj } from "@storybook/react-vite";
import { createFixtureWorld, IDS } from "../fixtures/index.ts";
import { STORY_NOW } from "../stories/harness.tsx";
import { ApprovalCard } from "./ApprovalCard.tsx";

const world = createFixtureWorld();
const byId = (id: string) => {
  const a = world.approvals.find((x) => x.id === id);
  if (a === undefined) throw new Error(`fixture approval ${id} missing`);
  return a;
};

const meta = {
  title: "Cards/Approval card",
  component: ApprovalCard,
  args: {
    approval: byId(IDS.approvals.sendEmail),
    canAnswer: true,
    persona: "Wren",
    taskTitle: "Dentist booking",
    createdFrom: "chat",
    mode: "balanced",
    now: STORY_NOW,
    armDelayMs: 0,
    onAnswer: () => {},
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof ApprovalCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SendEmail: Story = {};
export const Exec: Story = { args: { approval: byId(IDS.approvals.exec) } };
export const CredentialFill: Story = {
  args: { approval: byId(IDS.approvals.credentialFill), otherSurfaces: ["iPhone"] },
};
export const Purchase: Story = {
  args: { approval: byId(IDS.approvals.purchase), taskTitle: "Lisbon trip" },
};
export const FileWrite: Story = {
  args: { approval: byId(IDS.approvals.fileWrite), taskTitle: "Tax letter" },
};
export const McpTool: Story = { args: { approval: byId(IDS.approvals.mcpTool) } };
export const Arming: Story = { args: { armDelayMs: 400 } };
export const ExpiringSoon: Story = {
  args: {
    approval:
      world.approvals.find(
        (a) => a.status === "pending" && Date.parse(a.expiresAt) - STORY_NOW < 60_000,
      ) ?? byId(IDS.approvals.sendEmail),
  },
};
export const ExpiredByClock: Story = { args: { now: STORY_NOW + 2 * 60 * 60 * 1000 } };
export const AnswerElsewhere: Story = { args: { canAnswer: false } };
export const StaleAfterRestart: Story = { args: { stale: true } };
export const ApprovedOnIphone: Story = { args: { approval: byId(IDS.approvals.approvedOnIphone) } };
export const Denied: Story = { args: { approval: byId(IDS.approvals.denied) } };
export const Expired: Story = { args: { approval: byId(IDS.approvals.expired) } };
export const Voided: Story = { args: { approval: byId(IDS.approvals.invalidated) } };

const folder = (details: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  ...byId(IDS.approvals.sendEmail),
  kind: "folder_access" as const,
  summary: "Share a folder: /Users/me/Downloads",
  details: {
    requestedPath: "/Users/me/Downloads",
    reason: "You asked me to check what's in your Downloads folder.",
    access: "ro",
    ...details,
  },
  scopesOffered: ["once", "always"] as ("once" | "always")[],
  requiresAuthentication: false,
  taint: false,
  ...over,
});

/** The Gateway resolved the folder the agent asked for: pre-filled, Allow ready. */
export const FolderPrefilled: Story = {
  args: {
    approval: folder({ folderStatus: "ok", resolvedPath: "/Users/me/Downloads" }),
    persona: "Psyche",
  },
};
export const FolderBlocked: Story = {
  args: {
    approval: folder({ folderStatus: "blocked", resolvedPath: "/Users/me" }),
    persona: "Psyche",
  },
};
export const FolderTainted: Story = {
  args: {
    approval: folder(
      { folderStatus: "ok", resolvedPath: "/Users/me/Downloads" },
      {
        taint: true,
        scopesOffered: ["once"],
        taintSources: [
          { sourceKind: "screen", origin: "https://canvas.ucsc.edu/" },
          {
            sourceKind: "mcp__apple-reminders-mvp8e06m2__reminders_create",
            origin: "apple-reminders-mvp8e06m2",
          },
        ],
      },
    ),
    persona: "Psyche",
  },
};
