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
  type FeedEvent,
  FeedService,
  type FeedServiceOptions,
  type GenerateResult,
  LEDGER_PATH,
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
  GOAL_CHECKIN_JOB,
  type GoalCandidateInput,
  type GoalCreateInput,
  type GoalDetail,
  type GoalEvent,
  type GoalPatch,
  type GoalProgress,
  GoalsService,
  type GoalsServiceOptions,
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
  sequenceCandidates,
  signalCandidates,
  skillDraft,
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
export type { SqliteDatabase, SqliteStatement } from "./sqlite.ts";
