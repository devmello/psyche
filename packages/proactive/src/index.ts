export { HEARTBEAT_TASK_BUDGET, PROACTIVITY_BUDGET, type ProactivityBudget } from "./budget.ts";
export { cosine, createEmbedder, type Embedder, lexicalEmbedding } from "./feed/embeddings.ts";
export { createFeedHandlers, type FeedHandlers } from "./feed/handlers.ts";
export {
  applyFeedback,
  exclusions,
  type FeedbackContext,
  type FeedbackKind,
  formatEntry,
  hiddenHosts,
  keyPhrase,
  type Ledger,
  type LedgerEntry,
  type LedgerTopic,
  normalizeTopic,
  parseLedger,
  serializeLedger,
  topics as ledgerTopics,
} from "./feed/ledger.ts";
export {
  checkCitations,
  complete,
  extractJson,
  rerank,
  templatePost,
  writePost,
} from "./feed/model.ts";
export { isPrivateHost, publicFetch } from "./feed/public-fetch.ts";
export {
  CLUSTER_THRESHOLD,
  cluster,
  dedupe,
  gapTopics,
  pickExploration,
  type ScoredCluster,
  scoreClusters,
  seededShuffle,
  seedFrom,
} from "./feed/rank.ts";
export {
  DAILY_BRIEF_ARG,
  DEFAULT_BRIEF_SCHEDULE,
  FEED_BRIEF_JOB,
  FEED_BRIEFING_JOB,
  FEED_INSTRUCTIONS_PATH,
  type FeedEvent,
  FeedService,
  type FeedServiceOptions,
  type GenerateResult,
  LEDGER_PATH,
  MAX_FEED_INSTRUCTIONS,
  toFeedPost,
} from "./feed/service.ts";
export {
  arxivSource,
  type Candidate,
  collect,
  type FeedSource,
  type FetchLike,
  hackerNewsSource,
  makeCandidate,
  normalizeUrl,
  parseFeedXml,
  plainText,
  providedSource,
  rssSource,
  type SearchLike,
  type SourceReport,
} from "./feed/sources.ts";
export { FeedStore, type StoredPost } from "./feed/store.ts";
export { createGoalHandlers, type GoalHandlers } from "./goals/handlers.ts";
export {
  DEFAULT_WATCH_EVERY,
  GOAL_CHECKIN_JOB,
  GOAL_WATCH_JOB,
  type GoalCandidateInput,
  type GoalCreateInput,
  type GoalDetail,
  type GoalEvent,
  type GoalPatch,
  type GoalProgress,
  GoalsService,
  type GoalsServiceOptions,
  type GoalWatchInput,
  type GoalWatchStatus,
} from "./goals/service.ts";
export { GoalStore, normalizeTitle } from "./goals/store.ts";
export {
  type AcceptanceModel,
  effortMinutes,
  fitAcceptanceModel,
  type IdeaFeatures,
  PRIOR as ACCEPTANCE_PRIOR,
  type TrainingExample,
} from "./ideas/acceptance.ts";
export { createIdeaHandlers, type IdeaHandlers } from "./ideas/handlers.ts";
export {
  type ConnectorSignal,
  categoryOf,
  findSequences,
  loadOwnerNotes,
  loadToolRuns,
  mineGoals,
  mineNotes,
  type SequencePattern,
  type SignalsProvider,
  type SkillUpdateCandidate,
  type SkillUpdatesProvider,
  sequenceCandidates,
  signalCandidates,
  skillDraft,
  skillUpdateCandidates,
  type ToolRun,
} from "./ideas/mining.ts";
export {
  type AcceptParams,
  DEFAULT_MINE_SCHEDULE,
  DEFAULT_WINDOW_SCHEDULE,
  IDEAS_DELIVER_JOB,
  IDEAS_MINE_JOB,
  type IdeaEvent,
  IdeasService,
  type IdeasServiceOptions,
  type MineReport,
  trainingExamples,
} from "./ideas/service.ts";
export { type IdeaAction, IdeaStore, type StoredIdea, toIdea } from "./ideas/store.ts";
export {
  cadenceKind,
  jobMarker,
  type Launcher,
  type LaunchRequest,
  type LaunchResult,
  type ProactiveJob,
  type ProactiveLauncherOptions,
  parseJobMarker,
  type SchedulerLike,
  withProactiveJobs,
} from "./jobs.ts";
export {
  CLASSIFY_BATCH,
  type Classified,
  classifyBatch,
  sanitizeMailText,
} from "./mail/classify.ts";
export {
  addBusinessDays,
  DEFAULT_DIGEST_SCHEDULE,
  DigestService,
  type DigestServiceOptions,
  digestSchedule,
  MAIL_DIGEST_JOB,
  RULES_PATH,
} from "./mail/digest.ts";
export {
  commitments,
  type Draft,
  type DraftRequest,
  DraftService,
  type DraftServiceOptions,
  shouldAutoDraft,
  type Tone,
} from "./mail/drafts.ts";
export { lookalikeOf, type MailItem, presort } from "./mail/presort.ts";
export {
  addressOf,
  domainOf,
  formatRule,
  parseRules,
  type RuleDecision,
  type RulesFile,
  ruleFor,
  type SenderRule,
  serializeRules,
  setRule,
} from "./mail/rules.ts";
export {
  findSlots,
  formatSlot,
  pickSlot,
  SchedulingService,
  type SchedulingServiceOptions,
  type Slot,
  type TimesProposal,
} from "./mail/scheduling.ts";
export {
  buildProfile,
  commonSignature,
  MAIL_VOICE_JOB,
  ownText,
  renderVoice,
  type SentMessage,
  type Tier,
  VOICE_PATH,
  VOICE_SAMPLES_PATH,
  type VoiceProfile,
  VoiceService,
  type VoiceServiceOptions,
} from "./mail/voice.ts";
export {
  appleMailSource,
  type EventScheduler,
  FIRST_POLL_LOOKBACK_MS,
  gmailSource,
  MAIL_WATCH_JOB,
  MAIL_WATCH_SCHEDULE,
  MAIL_WATCH_SOURCE,
  type MailEventSource,
  MailWatcher,
  type MailWatcherOptions,
  OFF_HOURS_POLL_MS,
} from "./mail/watch.ts";
export {
  MeetingNotesService,
  type MeetingNotesServiceOptions,
  type MeetingTranscriber,
  type NotesOutcome,
  type RecordingInput,
  type TheyOweLoop,
  type TranscriptInput,
} from "./meetings/notes.ts";
export {
  type CalendarEvent,
  lastMeetingNotes,
  MEETING_PREP_JOB,
  MeetingPrepService,
  type MeetingPrepServiceOptions,
  type PlanResult,
  PREP_PLANNER_SCHEDULE,
  type PrepScope,
} from "./meetings/prep.ts";
export {
  type AudioCapture,
  type CapturedAudio,
  CONSENT_LINE,
  MeetingRecorder,
  type MeetingRecording,
} from "./meetings/recorder.ts";
export {
  createProposalHandlers,
  type ProposalCaller,
  type ProposalHandlers,
} from "./proposals/handlers.ts";
export {
  type BatchBroker,
  type CreateProposalInput,
  DEFAULT_INVERSES,
  type Inverse,
  MAX_PROPOSAL_CALLS,
  PROPOSAL_TTL_MS,
  type ProposalEvent,
  ProposalService,
  type ProposalServiceOptions,
  type ToolLookup,
  UNDO_WINDOW_MS,
} from "./proposals/service.ts";
export { ProposalStore, type StoredProposal, toActionProposal } from "./proposals/store.ts";
export type { SqliteDatabase, SqliteStatement } from "./sqlite.ts";
export {
  feedTools,
  goalTools,
  ideaTools,
  mailTools,
  type ProactiveToolsOptions,
  proactiveTools,
} from "./tools/index.ts";
