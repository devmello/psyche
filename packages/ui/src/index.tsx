/**
 * @psyche/ui — the React kit psyche-desktop and psyche-web host (docs/06-ui-design.md).
 * Subpath entries: `@psyche/ui/theme`, `@psyche/ui/data`, `@psyche/ui/testing`,
 * `@psyche/ui/styles.css`. See README.md for the catalogue.
 */

// Agent header and sheet.
export { ActionLog, ActivityPanel, TaskDetail, TaskList } from "./agent/ActivityPanel.tsx";
export { AgentHeader, type AgentHeaderProps, MODE_LABEL } from "./agent/AgentHeader.tsx";
export {
  AgentSheet,
  AgentSheetBody,
  type AgentSheetProps,
  type AgentTab,
} from "./agent/AgentSheet.tsx";
export { ApprovalsPanel } from "./agent/ApprovalsPanel.tsx";
export {
  BudgetMeter,
  MemoryFileEditor,
  PERSONA_FILES,
  ProvenanceChip,
  SoulMemoryPanel,
} from "./agent/SoulMemoryPanel.tsx";
export { scheduleSentence, UpcomingPanel, UpcomingRow } from "./agent/UpcomingPanel.tsx";
export { type AgentStatus, useAgentStatus } from "./agent/useAgentState.ts";
// Avatar.
export {
  AVATAR_STATE_LABEL,
  Avatar,
  type AvatarProps,
  type AvatarSize,
  type AvatarState,
} from "./avatar/Avatar.tsx";
export {
  CREATURES,
  type CreatureDefinition,
  type CreatureId,
  type CreaturePose,
  DEFAULT_CREATURE,
  getCreature,
} from "./avatar/creatures/index.tsx";
// Message blocks and cards.
export {
  ApprovalCard,
  type ApprovalCardProps,
  type ApprovalChoice,
} from "./blocks/ApprovalCard.tsx";
export {
  ArtifactCard,
  type ArtifactCardProps,
  type ArtifactPreviewKind,
  FileCard,
  formatBytes,
  type PreviewSlot,
} from "./blocks/ArtifactCard.tsx";
export { ApprovalDetails } from "./blocks/approval-details.tsx";
export { Checklist, PlanCard } from "./blocks/Checklist.tsx";
export {
  DISCLOSURE_LABEL,
  type DisclosureLevel,
  DisclosureProvider,
  useCycleDisclosure,
  useDisclosure,
} from "./blocks/disclosure.tsx";
export { Markdown, type MarkdownProps } from "./blocks/Markdown.tsx";
export { MessageBlocks, type MessageBlocksProps } from "./blocks/MessageBlocks.tsx";
export {
  type Answers,
  isRecommended,
  orderedOptions,
  QuestionCard,
  type QuestionCardProps,
  usesChips,
} from "./blocks/QuestionCard.tsx";
export { ReceiptLine } from "./blocks/Receipt.tsx";
export {
  TASK_STATUS_LABEL,
  TaskCard,
  type TaskCardProps,
  TaskStatusIcon,
} from "./blocks/TaskCard.tsx";
export {
  StatusDot,
  summarizeRun,
  type ToolCallItem,
  ToolCallRow,
  ToolRun,
} from "./blocks/ToolRun.tsx";
export type * from "./blocks/types.ts";
export { WrapUpBox } from "./blocks/WrapUp.tsx";
// Bootstrap brand pieces (inline-styled; usable without the stylesheet).
export * from "./brand.tsx";
// Chat column.
export { ApprovalDock } from "./chat/ApprovalDock.tsx";
export { Composer, type ComposerProps, SLASH_COMMANDS } from "./chat/Composer.tsx";
export { type ExportFormat, ExportMenu, markdownToHtmlDocument } from "./chat/ExportMenu.tsx";
export { FollowUpQueue } from "./chat/FollowUpQueue.tsx";
export { MessageView, type MessageViewProps, messageText } from "./chat/MessageView.tsx";
export { OfflineBanner } from "./chat/OfflineBanner.tsx";
export { ChatThread, type ChatThreadProps } from "./chat/Thread.tsx";
export { Page, PageHeader, type PageProps, SectionLabel } from "./components/page.tsx";
export { NativeSelect } from "./components/ui/native-select.tsx";
export { Toaster } from "./components/ui/sonner.tsx";
export * from "./data/index.ts";
// Formatting helpers.
export * from "./lib/format.ts";
export { cn } from "./lib/utils.ts";
// Screens.
export * from "./screens/feed/index.ts";
export * from "./screens/files/index.ts";
export * from "./screens/goals/index.ts";
export * from "./screens/ideas/index.ts";
export * from "./screens/inbox/index.ts";
export * from "./screens/library/index.ts";
export * from "./screens/onboarding/index.ts";
export * from "./screens/search/index.ts";
export * from "./screens/settings/index.ts";
export { AppearanceProvider } from "./shell/AppearanceProvider.tsx";
// Shell pieces.
export { AppShell, type AppShellProps } from "./shell/AppShell.tsx";
export {
  CommandPalette,
  type CommandPaletteProps,
  DEFAULT_ACTIONS,
  type PaletteAction,
} from "./shell/CommandPalette.tsx";
export { RAIL_ITEMS, Rail, type RailItem, type RailProps } from "./shell/Rail.tsx";
export { ShortcutList, ShortcutTable } from "./shell/ShortcutList.tsx";
export {
  CARD_SHORTCUTS,
  isMac,
  SHORTCUTS,
  type Shortcut,
  type ShortcutId,
  useShortcuts,
} from "./shell/shortcuts.ts";
export { ThreadList, type ThreadListProps, ThreadRow } from "./shell/ThreadList.tsx";
export {
  type EditorSlotProps,
  type UiSlots,
  UiSlotsProvider,
  usePersona,
  useSlots,
} from "./slots.tsx";
// Theme and data layer.
export * from "./theme/index.ts";
