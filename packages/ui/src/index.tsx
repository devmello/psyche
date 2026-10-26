/**
 * @psyche/ui — the React kit psyche-desktop and psyche-web host (docs/06-ui-design.md).
 * Subpath entries: `@psyche/ui/theme`, `@psyche/ui/data`, `@psyche/ui/testing`,
 * `@psyche/ui/styles.css`. See README.md for the catalogue.
 */

// Agent header and sheet.
export { ActionLog, ActivityPanel, TaskDetail, TaskList } from "./agent/ActivityPanel.tsx";
export { AgentHeader, type AgentHeaderProps, MODE_LABEL } from "./agent/AgentHeader.tsx";
export {
  AGENT_PANEL_MIN_CONTENT,
  AGENT_PANEL_WIDTH,
  AgentRouteSheet,
  type AgentRouteSheetProps,
  type AgentRouteTab,
  AgentSheet,
  AgentSheetBody,
  AgentSheetPanel,
  type AgentSheetPanelProps,
  type AgentSheetProps,
  type AgentSheetRoute,
  type AgentTab,
  agentSheetHref,
  agentSheetRoute,
  agentTimelineHref,
  lastAgentTab,
  rememberAgentTab,
  sheetTab,
  useDefaultAgentTab,
} from "./agent/AgentSheet.tsx";
export { ApprovalsPanel } from "./agent/ApprovalsPanel.tsx";
export {
  BudgetMeter,
  MemoryFileEditor,
  PERSONA_FILES,
  ProvenanceChip,
  SoulMemoryPanel,
} from "./agent/SoulMemoryPanel.tsx";
// The run trace's Timeline (run trace §3.3–§3.5).
export { TimelineView, type TimelineViewProps } from "./agent/timeline/TimelineView.tsx";
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
  CARD_STATUSES,
  Card as BlockCard,
  type CardAction,
  CardActions,
  type CardProps,
  type CardStatus,
  type CardStatusInfo,
  type CardVariant,
  cardStatusLabel,
  fromApprovalStatus,
  fromStepStatus,
  fromTaskStatus,
  fromToolCallStatus,
} from "./blocks/card.tsx";
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
  type BlockContext,
  type BlockRenderer,
  type BlockViewProps,
  blockRenderer,
  RegisteredBlock,
  registerBlock,
  registeredBlockTypes,
  registerToolView,
  type ToolViewProps,
  toolViewFor,
  UnknownBlock,
} from "./blocks/registry.tsx";
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
export {
  type ArtifactRenderProps,
  CanvasPane,
  type CanvasPaneProps,
} from "./canvas/CanvasPane.tsx";
export { ChartView, niceTicks } from "./canvas/ChartView.tsx";
// Chat column.
export { ApprovalDock } from "./chat/ApprovalDock.tsx";
export { Composer, type ComposerProps, SLASH_COMMANDS } from "./chat/Composer.tsx";
export * from "./chat/context/index.ts";
export {
  downloadFile,
  type ExportFormat,
  ExportMenu,
  markdownToHtmlDocument,
  useThreadExport,
} from "./chat/ExportMenu.tsx";
export { FollowUpQueue } from "./chat/FollowUpQueue.tsx";
export { MessageView, type MessageViewProps, messageText } from "./chat/MessageView.tsx";
export { OfflineBanner } from "./chat/OfflineBanner.tsx";
export { ComposerPrefill, usePrefillComposer } from "./chat/prefill.ts";
export { ChatThread, type ChatThreadProps } from "./chat/Thread.tsx";
export { Filmstrip, type FilmstripFrame, type FilmstripProps } from "./components/filmstrip.tsx";
export { JsonView, type JsonViewProps, redactionToken } from "./components/json-view.tsx";
export {
  GroupedList,
  type GroupedListProps,
  GroupedRow,
  type GroupedRowProps,
  Page,
  PageHeader,
  type PageProps,
  SectionLabel,
} from "./components/page.tsx";
export { Sparkline, type SparklineProps, useThrottled } from "./components/sparkline.tsx";
export {
  StatusGlyph,
  type StatusGlyphProps,
  type StatusKind,
  type StepStatusKind,
  stepStatusKind,
} from "./components/status.tsx";
export {
  formatElapsed,
  formatStepDuration,
  LiveDuration,
  type LiveDurationProps,
} from "./components/steps/LiveDuration.tsx";
export { StepRow, type StepRowProps } from "./components/steps/StepRow.tsx";
export { TICK_MS, useTicker } from "./components/steps/ticker.ts";
export {
  axisTicks,
  type Gap,
  type Interval,
  idleGaps,
  type TimeScale,
  timeScale,
} from "./components/timeline/scale.ts";
export {
  Bar,
  type BarKind,
  type BarProps,
  type BarSegment,
  GapBreak,
  Playhead,
  TimeAxis,
} from "./components/timeline/Timeline.tsx";
export { NativeSelect } from "./components/ui/native-select.tsx";
export { Toaster } from "./components/ui/sonner.tsx";
export {
  TOOLBAR_HEIGHT,
  Toolbar,
  type ToolbarContent,
  ToolbarGroup,
  ToolbarLeading,
  type ToolbarProps,
  ToolbarProvider,
  ToolbarSlot,
  type ToolbarSlotProps,
  ToolbarStore,
  ToolbarTitle,
  ToolbarTrailing,
  useToolbar,
  useToolbarContent,
} from "./components/ui/toolbar.tsx";
export * from "./data/index.ts";
export * from "./i18n/index.ts";
export {
  applyOpsLocal,
  cellFromInput,
  columnName,
  diffToOps,
  setCellOp,
  tableToCsv,
  viewRows,
} from "./lib/artifact-ops.ts";
// Formatting helpers.
export * from "./lib/format.ts";
export { documentPrefersReducedMotion } from "./lib/reduced-motion.ts";
export { cn } from "./lib/utils.ts";
export * from "./links/index.ts";
export { MapBlock } from "./map/MapBlock.tsx";
export { MapList } from "./map/MapList.tsx";
export { MapPanel } from "./map/MapPanel.tsx";
export {
  DEFAULT_STYLE_DARK,
  DEFAULT_STYLE_LIGHT,
  type MapSource,
  mapSourceOf,
  parseMapContent,
  safeLink,
  validStyleUrl,
  viewBounds,
} from "./map/map-model.ts";
export { FPS_PROBE_KEY, medianFps, startFpsProbe } from "./motion/fps-probe.ts";
export * from "./overview/index.ts";
export {
  type ScreenAskAnswer,
  type ScreenAskCaptureView,
  type ScreenAskDictation,
  ScreenAskRegionView,
  type ScreenAskRegionViewProps,
  ScreenAskView,
  type ScreenAskViewProps,
} from "./screen-ask/ScreenAskView.tsx";
// Screens.
export * from "./screens/feed/index.ts";
export * from "./screens/files/index.ts";
export * from "./screens/goals/index.ts";
export * from "./screens/ideas/index.ts";
export * from "./screens/inbox/index.ts";
export * from "./screens/library/index.ts";
export * from "./screens/onboarding/index.ts";
export * from "./screens/search/index.ts";
export { CONTEXT_KEYS, ContextSettingsGroup } from "./screens/settings/ContextSettings.tsx";
export * from "./screens/settings/index.ts";
export * from "./screens/workflows/index.ts";
export {
  AppearanceProvider,
  type AppearanceProviderProps,
  REDUCE_TRANSPARENCY_SETTING,
} from "./shell/AppearanceProvider.tsx";
// Shell pieces.
export { AppShell, type AppShellProps } from "./shell/AppShell.tsx";
export {
  CommandPalette,
  type CommandPaletteProps,
  DEFAULT_ACTIONS,
  type PaletteAction,
} from "./shell/CommandPalette.tsx";
export { CompactTopBar, type CompactTopBarProps } from "./shell/CompactTopBar.tsx";
export {
  PanePresence,
  ReflowColumn,
  RouteTransition,
  SelectionPill,
  ShellMotion,
  SidebarPresence,
  ThreadCrossfade,
} from "./shell/motion.tsx";
export {
  destinationFor,
  RAIL_ITEMS,
  type RailItem,
  TabBar,
  type TabBarProps,
} from "./shell/Rail.tsx";
export { ShortcutList, ShortcutTable } from "./shell/ShortcutList.tsx";
export {
  BrowserToggle,
  type BrowserToggleProps,
  ConnectedSidebar,
  clampSidebarWidth,
  SIDEBAR_RAIL,
  SIDEBAR_WIDTH,
  Sidebar,
  type SidebarMode,
  type SidebarProps,
  SidebarToggle,
  type SidebarToggleProps,
  sidebarResize,
  useSidebarCounts,
} from "./shell/Sidebar.tsx";
export {
  SPLASH_LEAVE_MS,
  type SplashLineView,
  StartupSplashView,
  type StartupSplashViewProps,
} from "./shell/StartupSplashView.tsx";
export {
  CARD_SHORTCUTS,
  isMac,
  SHORTCUTS,
  type Shortcut,
  type ShortcutId,
  useShortcuts,
} from "./shell/shortcuts.ts";
export {
  ThreadGroup,
  type ThreadGroupProps,
  ThreadList,
  type ThreadListProps,
  ThreadRow,
  threadTitle,
} from "./shell/ThreadList.tsx";
export { ThreadsDrawer } from "./shell/ThreadsDrawer.tsx";
export {
  BudgetBar,
  budgetFraction,
  budgetTone,
  ConnectedUsageFooter,
  isSubscriptionModel,
  PlanRing,
  UsageCard,
  UsageFooter,
  type UsageFooterProps,
  UsageGraphic,
  type UsageLead,
  type UsageSummaryData,
  usageLead,
  usageLine,
  usePrimarySubscription,
  useUsageSummary,
} from "./shell/UsageFooter.tsx";
export {
  type EditorLineMark,
  type EditorSlotProps,
  type UiSlots,
  UiSlotsProvider,
  usePersona,
  useSlots,
} from "./slots.tsx";
// The teaching loop (docs/agent/teaching-loop-2026.md §5).
export * from "./teaching/index.ts";
// Theme and data layer.
export * from "./theme/index.ts";
// Voice: composer dictation and the screen-request phrases (Psyche answers in text).
export {
  type ComposerDictation,
  type ComposerVoice,
  ComposerVoiceBar,
  ComposerVoiceButtons,
  type UseComposerVoice,
} from "./voice/controls.tsx";
export {
  mentionsScreen,
  normalizeUtterance,
  type VoicePhraseList,
  voicePhrases,
} from "./voice/phrases.ts";
export {
  readVoiceSettings,
  VOICE_DEFAULTS,
  VOICE_KEYS,
  type VoiceSettings,
} from "./voice/settings.ts";
