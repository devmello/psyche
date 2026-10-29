import { type AgentToolRegistry, defineTool } from "@psyche/agent-core";
import { type HashChainAuditLog, listChanges } from "@psyche/audit";
import { getSetting, type PsycheDb, setSetting } from "@psyche/db";
import type { GrantedFolder } from "@psyche/files";
import type { GraphStore, SqliteMemoryStore } from "@psyche/memory";
import type { PsycheNotifier } from "@psyche/notifications";
import type { PsychePermissionBroker } from "@psyche/permissions";
import {
  type AudioCapture,
  appleMailSource,
  arxivSource,
  createDailyHandlers,
  createFeedHandlers,
  createGoalHandlers,
  createIdeaHandlers,
  createProposalHandlers,
  DailyService,
  DigestService,
  DraftService,
  digestSchedule,
  FeedService,
  type FeedSource,
  FocusTimeService,
  FollowupStore,
  GoalsService,
  gmailSource,
  HEARTBEAT_TASK_BUDGET,
  hackerNewsSource,
  IdeasService,
  lastMeetingNotes,
  MailWatcher,
  MeetingPrepService,
  type MeetingTranscriber,
  NOTES_CREATE_TOOL,
  NotesFolderWatcher,
  OFF_HOURS_POLL_MS,
  ProposalService,
  publicFetch,
  readDailySettings,
  rssSource,
  SchedulingService,
  type SignalsProvider,
  type SkillUpdatesProvider,
  type ToolLookup,
  VoiceService,
  withProactiveJobs,
} from "@psyche/proactive";
import type { Clock, EventName, EventPayload, ModelProvider, ModelRef } from "@psyche/protocol";
import { PsycheError } from "@psyche/protocol";
import {
  createDbSessionResolver,
  createTaskLauncher,
  parseSchedule,
  type RunLauncher,
  type SqliteScheduler,
} from "@psyche/scheduler";
import type { SqliteTaskEngine, TaskWorkerPool } from "@psyche/tasks";
import { Type } from "@sinclair/typebox";
import { ulid } from "ulid";
import type { Call, HandlerDef } from "../context.ts";
import type { Logger } from "../log.ts";
import { mountParamsOnly, surfaceOf } from "./handlers.ts";
import { type ComposedMeetings, composeMeetings, graphPrepHooks } from "./meetings.ts";
import { recordingsFolderIo } from "./notes-folder.ts";
import { isOwnerQuietAt } from "./quiet-hours.ts";
import {
  notesRefusal,
  pausable,
  UPGRADE_CARD_SETTING,
  WORKFLOW_SETTING_KEYS,
  workflowSettings,
} from "./workflow-settings.ts";

/**
 * Proactive surfaces (S15; features O2, O5–O9): goals with check-ins on the scheduler, the
 * Feed (daily brief and briefings run in-process by the pipeline, posts and feedback over
 * `feed.*`), Ideas (nightly mining at 02:30 and a 09:00 delivery window, `ideas.*`; accepted
 * ideas become task cards in the main thread or automations), and the heartbeat on a launcher bounded by `HEARTBEAT_TASK_BUDGET` (under 5k tokens
 * per run). Proactive automations are recognised by their prompt marker and run in-process (no
 * agent turn); everything else reaches the agent launcher unchanged.
 *
 * Feed sources come from the `feed.sources` setting (admin-only):
 * `{ rss?: string[], hackerNews?: boolean, arxiv?: boolean }`; default Hacker News and arXiv on.
 * Network reads use `publicFetch` until S09 exports its SSRF-policed fetch.
 */

export interface FeedSourcesSetting {
  rss?: string[];
  hackerNews?: boolean;
  arxiv?: boolean;
}

export function feedSourcesFrom(value: unknown): FeedSource[] {
  const s = (value ?? {}) as FeedSourcesSetting;
  const out: FeedSource[] = [];
  for (const url of Array.isArray(s.rss) ? s.rss : []) {
    if (typeof url === "string" && /^https?:\/\//.test(url)) out.push(rssSource(url));
  }
  if (s.hackerNews !== false) out.push(hackerNewsSource());
  if (s.arxiv !== false) out.push(arxivSource());
  return out;
}

export interface ProactiveSetup {
  db: PsycheDb;
  clock: Clock;
  scheduler: SqliteScheduler;
  notifier: PsycheNotifier;
  tasks: SqliteTaskEngine;
  memory: SqliteMemoryStore;
  /** The utility model for the Feed's rerank and post writing. */
  provider: ModelProvider;
  model: ModelRef;
  publish<E extends EventName>(event: E, payload: EventPayload<E>, threadId?: string): void;
  timeZone?: string;
  logger?: Logger;
  /** Connector signals for Ideas (unanswered mail, subscriptions, trips); S09 supplies them. */
  signals?: SignalsProvider;
  /** Skill-update drafts for skills with enough lessons (teaching loop §6). */
  skillUpdates?: SkillUpdatesProvider;
  /** Batch proposals (mail and meeting workflows §8.1): the broker the composition hands out. */
  broker?: PsychePermissionBroker;
  /** The loop's tool registry: approved proposals run their calls through it. */
  registry?: AgentToolRegistry;
  /** Post-meeting notes and Record meeting (§4.6); off without a registry. */
  meetings?: {
    home: string;
    /** The summary model; default `model`. */
    primary?: ModelRef;
    primaryIsRemote?: () => boolean;
    /** The speech part's long-form transcription on the Mac. */
    transcriber?: MeetingTranscriber;
    /** Whether the transcriber can take a recording now; Record meeting needs it. */
    transcriberAvailable?: () => boolean;
    /** The helper microphone, once a helper offers capture. */
    capture?: () => AudioCapture | undefined;
    /** The running apps' bundle ids from the helper; Record meeting ends when a conference app quits. */
    runningApps?: () => Promise<readonly string[] | undefined>;
  };
  /** The audit log: the evening wrap-up counts the day's recorded changes. */
  audit?: Pick<HashChainAuditLog, "query">;
  /** The owner's chat surfaces (`imessage:<peer>`); the brief goes there when `daily.messages` is on. */
  channelSurfaces?: () => string[];
  /** Everything memory's "Learned yesterday" line for the morning brief (counts only). */
  learned?: () => { text: string; link?: string } | undefined;
  /** The people graph while it is on: prep reads people and loops, notes add loops. */
  graph?: () => GraphStore | undefined;
  /**
   * The granted folders (`permissions.policy.folders`). The recordings-folder watch
   * (`meetings.notes.folder`, #953) scans only a folder inside one; without this it never scans.
   */
  folders?: () => readonly GrantedFolder[];
}

export interface ComposedProactive {
  readonly goals: GoalsService;
  readonly feed: FeedService;
  readonly ideas: IdeasService;
  /** The new-mail poller (mail and meeting workflows §4.7); it reads mail only for listeners. */
  readonly mailWatch: MailWatcher;
  /** The daily inbox digest (§4.1), off until the owner turns it on (`mail.digest.enabled`). */
  readonly digest: DigestService | undefined;
  /** Batch proposals, when the composition gave a broker and a registry. */
  readonly proposals: ProposalService | undefined;
  /** Meeting prep (§4.5), off until the owner turns it on (`meetings.prep.enabled`). */
  readonly meetingPrep: MeetingPrepService | undefined;
  /** Post-meeting notes and Record meeting (§4.6), when the composition gave `meetings`. */
  readonly meetings: ComposedMeetings | undefined;
  /** New recordings in `meetings.notes.folder` offered as notes cards (#953). */
  readonly notesFolder: NotesFolderWatcher | undefined;
  /** The owner's writing style (§4.3), refreshed nightly only when `mail.voice.enabled`. */
  readonly voice: VoiceService | undefined;
  /** Reply drafts in the owner's voice, saved through one approval card (§4.3). */
  readonly drafts: DraftService | undefined;
  /** Scheduling over email: free slots, a reply draft and optional holds (§4.4). */
  readonly scheduling: SchedulingService | undefined;
  /** Morning brief, evening wrap-up, follow-ups and plain-language automations. */
  readonly daily: DailyService;
  /** Focus time (§4.4): one proposed deep-work block a week, off until `mail.schedule.focusTime`. */
  readonly focus: FocusTimeService | undefined;
  readonly handlers: Record<string, HandlerDef>;
  /** The scheduler's launcher: proactive jobs in-process, the heartbeat bounded, the rest to `inner`. */
  launcher(inner: RunLauncher, pool: TaskWorkerPool): RunLauncher;
  /** Re-syncs the mail and meeting jobs' schedules with Settings → Mail & meetings. */
  syncWorkflowSchedules(): Promise<void>;
  /** The one-time Feed card an upgraded install gets (§7.5); runs at start, once. */
  offerWorkflowsOnUpgrade(): Promise<void>;
  /** After the Gateway listens: re-create check-ins the scheduler lost, drop orphans. */
  start(): Promise<void>;
  stop(): void;
}

export function composeProactive(setup: ProactiveSetup): ComposedProactive {
  const {
    db,
    clock,
    scheduler,
    notifier,
    tasks,
    memory,
    provider,
    model,
    publish,
    timeZone,
    logger,
    signals,
    skillUpdates,
    broker,
    registry,
    graph,
  } = setup;
  const goals = new GoalsService({
    db: db.sqlite,
    clock,
    scheduler,
    notifier,
    tasks,
    ...(timeZone === undefined ? {} : { timezone: timeZone }),
    onEvent: (e) => publish(e.event, e.payload),
  });
  const feed = new FeedService({
    db: db.sqlite,
    clock,
    scheduler,
    memory,
    provider,
    model,
    fetch: publicFetch(),
    sources: feedSourcesFrom(getSetting(db, "feed.sources")?.value),
    ...(timeZone === undefined ? {} : { timezone: timeZone }),
    onEvent: (e) => publish(e.event, e.payload as never),
  });
  const sessions = createDbSessionResolver(db);
  const ideas = new IdeasService({
    db: db.sqlite,
    clock,
    scheduler,
    tasks,
    // Accepted ideas land in the owner's main thread as task cards (O8).
    mainThread: () => sessions.resolve("main", { automation: {} as never, runId: "" }),
    memory,
    goals,
    notifier,
    ...(signals === undefined ? {} : { signals }),
    ...(skillUpdates === undefined ? {} : { skillUpdates }),
    ...(timeZone === undefined ? {} : { timezone: timeZone }),
    onEvent: (e) => publish(e.event, e.payload),
    onError: (err) =>
      logger?.log("warn", "idea mining step failed", { code: PsycheError.from(err).code }),
  });
  // `meetings.notes.create` as a tool, for the recordings-folder card (#953): only proposals can
  // run it (it is not in the agent's registry), and the approval is what starts the notes.
  let meetingsRef: ComposedMeetings | undefined;
  const notesCreateTool = defineTool({
    name: NOTES_CREATE_TOOL,
    description: "Write meeting notes from a Library recording (the recordings-folder card).",
    input: Type.Object({
      libraryItemId: Type.String({ minLength: 1 }),
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    }),
    sideEffect: "write",
    provenanceOut: "trusted",
    run: async (p) => {
      if (meetingsRef === undefined) throw new PsycheError("unavailable", "meeting notes are off");
      const out = await meetingsRef.createNotes(p);
      return out.status === "done"
        ? { output: { status: "done", postId: out.postId }, provenance: "trusted" as const }
        : { output: out.question, provenance: "trusted" as const, isError: true };
    },
  });
  const proposals =
    broker === undefined || registry === undefined
      ? undefined
      : new ProposalService({
          db: db.sqlite,
          clock,
          broker,
          tools: {
            get: (name) =>
              name === NOTES_CREATE_TOOL
                ? notesCreateTool
                : connectorToolLookup(registry).get(name),
          },
          mainThread: () => sessions.resolve("main", { automation: {} as never, runId: "" }),
          onEvent: (e) => publish(e.event, e.payload),
          onError: (err) =>
            logger?.log("warn", "proposal run failed", { code: PsycheError.from(err).code }),
        });
  // Settings → Mail & meetings, read on every run (workflow-settings.ts).
  const settings = () => workflowSettings(db);
  const readOnly = () => settings().readOnly;
  const lookup = registry === undefined ? undefined : connectorToolLookup(registry);
  // Wave 1 has no push for new mail: poll through whichever mail tools are connected (§4.7).
  const mailWatch = new MailWatcher({
    scheduler,
    clock,
    idleMs: () => {
      const idle = settings().poll.idleMin;
      return idle === undefined ? OFF_HOURS_POLL_MS : idle * 60_000;
    },
    sources: () => (lookup === undefined ? [] : [appleMailSource(lookup), gmailSource(lookup)]),
    ...(timeZone === undefined ? {} : { timezone: timeZone }),
    onError: (err) => logger?.log("warn", "mail poll failed", { code: PsycheError.from(err).code }),
  });
  // The owner's own addresses tell their text from quoted mail (§4.3); Settings fills them.
  const ownerAddresses = async () => stringList(getSetting(db, "mail.ownerAddresses")?.value);

  const meetingPrep =
    registry === undefined
      ? undefined
      : new MeetingPrepService({
          db: db.sqlite,
          clock,
          scheduler,
          tools: connectorToolLookup(registry),
          feed: feed.store,
          notifier,
          provider,
          model,
          ownerAddresses,
          // The prep notice is held through quiet hours unless the meeting starts inside them.
          isQuiet: (ms) => isOwnerQuietAt(db, ms),
          ...(proposals === undefined ? {} : { proposals }),
          saveToNotes: () => settings().prep.saveToNotes,
          // The previous occurrence's notes for the same series (§4.5 step 3).
          previousNotes: async ({ title }) => lastMeetingNotes(db.sqlite, title),
          // Attendees and open loops from the people graph (§4.5 steps 2–3), when it is on.
          ...(graph === undefined ? {} : graphPrepHooks(graph)),
          scope: () => settings().prep.scope,
          leadMs: () => settings().prep.leadMin * 60_000,
          notifyLeadMs: () => settings().prep.notifyMin * 60_000,
          dailyCap: () => settings().prep.dailyCap,
          ...(timeZone === undefined ? {} : { timezone: timeZone }),
          onFeedEvent: (e) => publish(e.event, e.payload as never),
          onError: (err) =>
            logger?.log("warn", "meeting prep step failed", { code: PsycheError.from(err).code }),
        });
  const digest =
    registry === undefined
      ? undefined
      : new DigestService({
          db: db.sqlite,
          clock,
          scheduler,
          tools: connectorToolLookup(registry),
          memory,
          ...(proposals === undefined ? {} : { proposals }),
          feed: feed.store,
          notifier,
          provider,
          model,
          ...(timeZone === undefined ? {} : { timezone: timeZone }),
          onFeedEvent: (e) => publish(e.event, e.payload as never),
          ...(meetingPrep === undefined
            ? {}
            : { meetingLines: () => meetingPrep.digestLinesToday() }),
          readOnly,
          notifyOnlyWhenNeeded: () => settings().digest.onlyWhenNeeded,
          followups: () => settings().followups,
          onError: (err) =>
            logger?.log("warn", "mail digest step failed", { code: PsycheError.from(err).code }),
        });
  const voice =
    registry === undefined
      ? undefined
      : new VoiceService({
          clock,
          tools: connectorToolLookup(registry),
          memory,
          scheduler,
          ownerAddresses,
          provider,
          model,
          ...(timeZone === undefined ? {} : { timezone: timeZone }),
        });
  const drafts =
    registry === undefined
      ? undefined
      : new DraftService({
          tools: connectorToolLookup(registry),
          ...(voice === undefined ? {} : { voice }),
          ...(proposals === undefined ? {} : { proposals }),
          readOnly,
          provider,
          model,
          draftModel: () => settings().draftModel,
          ownerAddresses,
        });
  const link = getSetting(db, "mail.schedulingLink")?.value;
  const scheduling =
    registry === undefined || drafts === undefined
      ? undefined
      : new SchedulingService({
          tools: connectorToolLookup(registry),
          drafts,
          ...(proposals === undefined ? {} : { proposals }),
          readOnly,
          timezone: timeZone ?? "UTC",
          schedule: () => settings().schedule,
          now: () => clock.now(),
          ...(typeof link === "string" && link !== "" ? { schedulingLink: link } : {}),
        });
  const focus =
    registry === undefined
      ? undefined
      : new FocusTimeService({
          tools: connectorToolLookup(registry),
          scheduler,
          ...(proposals === undefined ? {} : { proposals }),
          enabled: () => settings().focusTime,
          readOnly,
          timezone: timeZone ?? "UTC",
          schedule: () => settings().schedule,
          now: () => clock.now(),
        });
  const meetings =
    registry === undefined || setup.meetings === undefined
      ? undefined
      : composeMeetings({
          db,
          clock,
          home: setup.meetings.home,
          tools: registry,
          feed: feed.store,
          notifier,
          ...(proposals === undefined ? {} : { proposals }),
          provider,
          primary: setup.meetings.primary ?? model,
          utility: model,
          ...(setup.meetings.primaryIsRemote === undefined
            ? {}
            : { primaryIsRemote: setup.meetings.primaryIsRemote }),
          ...(setup.meetings.transcriber === undefined
            ? {}
            : { transcriber: setup.meetings.transcriber }),
          ...(setup.meetings.transcriberAvailable === undefined
            ? {}
            : { transcriberAvailable: setup.meetings.transcriberAvailable }),
          ...(setup.meetings.capture === undefined ? {} : { capture: setup.meetings.capture }),
          ...(setup.meetings.runningApps === undefined
            ? {}
            : { runningApps: setup.meetings.runningApps }),
          ...(graph === undefined ? {} : { graph }),
          ownerAddresses,
          ...(timeZone === undefined ? {} : { timezone: timeZone }),
          publish: (event, payload) => publish(event, payload),
          onFeedEvent: (e) => publish(e.event, e.payload as never),
          ...(logger === undefined ? {} : { logger }),
        });
  meetingsRef = meetings;
  // #953: new audio in `meetings.notes.folder` is copied into the Library and offered as one
  // Feed card; its single approval runs `meetings.notes.create` on the copy.
  const notesFolder =
    proposals === undefined || meetings === undefined || setup.meetings === undefined
      ? undefined
      : setup.folders === undefined
        ? undefined
        : new NotesFolderWatcher({
            clock,
            cursors: scheduler,
            feed: feed.store,
            proposals,
            folder: () => settings().notes.folder,
            refusal: () => notesRefusal(settings()),
            ...recordingsFolderIo({
              db,
              home: setup.meetings.home,
              folders: setup.folders,
            }),
            onFeedEvent: (e) => publish(e.event, e.payload as never),
            onSkip: (reason) => logger?.log("info", "recordings folder not scanned", { reason }),
            onError: (err) =>
              logger?.log("warn", "recordings folder scan failed", {
                code: PsycheError.from(err).code,
              }),
          });
  // Daily habits: the morning brief, evening wrap-up, follow-ups and plain-language automations.
  // They add no loop of their own: two system automations on the scheduler, at the owner's times.
  const dailyKv = {
    get: (key: string) => getSetting(db, key)?.value,
    set: (key: string, value: unknown) => void setSetting(db, key, value),
  };
  const dailySettings = () => readDailySettings(dailyKv);
  const followups = new FollowupStore(dailyKv, () => clock.now());
  const dailyTz = timeZone ?? "UTC";
  const daily = new DailyService({
    clock,
    scheduler,
    tools: lookup ?? { get: () => undefined },
    feed: feed.store,
    notifier,
    provider,
    model,
    settings: dailySettings,
    followups,
    timezone: dailyTz,
    ...(setup.learned === undefined ? {} : { learned: setup.learned }),
    ...(setup.channelSurfaces === undefined ? {} : { channelSurfaces: setup.channelSurfaces }),
    prepLink: (e) => meetingPrep?.prepLinkFor(e),
    activity: {
      openTasks: async () =>
        (
          await tasks.list({
            status: ["queued", "running", "awaiting_input", "awaiting_approval", "paused"],
          })
        )
          .filter((t) => t.createdFrom !== "automation")
          .slice(0, 20)
          .map((t) => ({ id: t.id, title: t.title, link: `/tasks/${t.id}` })),
      doneBetween: async (from, to) => {
        const done = (await tasks.list({ status: ["done"] }))
          .filter((t) => {
            const at = Date.parse(t.completedAt ?? "");
            return at >= from && at <= to;
          })
          .map((t) => ({ id: t.id, title: t.title, link: `/tasks/${t.id}` }));
        // The edit audit (#985): one line for the day's recorded changes by the agent or jobs.
        const changes =
          setup.audit === undefined
            ? []
            : (
                await listChanges(setup.audit, {
                  since: new Date(from).toISOString(),
                  until: new Date(to).toISOString(),
                  limit: 500,
                })
              ).filter((c) => c.record.outcome === "ok");
        const files = changes.filter((c) => c.record.category === "file").length;
        return [
          ...done,
          ...(files === 0
            ? []
            : [{ title: `${files} file change${files === 1 ? "" : "s"} recorded` }]),
        ];
      },
    },
    onFeedEvent: (e) => publish(e.event, e.payload as never),
    onError: (err) =>
      logger?.log("warn", "daily step failed", { code: PsycheError.from(err).code }),
  });
  const dailyHandlers = createDailyHandlers({
    daily,
    followups,
    settings: dailySettings,
    scheduler,
    provider,
    model,
    timezone: dailyTz,
    now: () => clock.now(),
    validate: (kind, schedule, tz) => void parseSchedule(kind, schedule, tz),
  });
  const proposalHandlers: Record<string, HandlerDef> = {};
  if (proposals !== undefined) {
    // `proposals.approve` hands the caller the answer token of its own surface only (§3.7).
    for (const [name, fn] of Object.entries(createProposalHandlers(proposals))) {
      proposalHandlers[name] = {
        run: (call: Call, params: never) =>
          (fn as (p: unknown, c: { surface: string }) => Promise<unknown>)(params, {
            surface: surfaceOf(db, call.identity.deviceId),
          }),
      };
    }
  }
  const paused = () => settings().paused;
  // The mail and meeting jobs' schedules follow Settings → Mail & meetings: the digest's time and
  // days, the mail check cadence, and each workflow's switch. Upgrades start with every workflow
  // off (§7.5); onboarding or Settings turn them on.
  async function syncWorkflowSchedules(): Promise<void> {
    const w = settings();
    const tz = timeZone === undefined ? {} : { timezone: timeZone };
    try {
      await mailWatch.ensureSchedule(
        w.poll.activeMin === undefined ? {} : { activeMin: w.poll.activeMin },
      );
      await digest?.ensureSchedule({
        enabled: w.digest.enabled,
        schedule: digestSchedule(w.digest.time, w.digest.days),
        ...tz,
      });
      await meetingPrep?.ensureSchedule({ enabled: w.prep.enabled, ...tz });
      await notesFolder?.ensureSchedule(scheduler, {
        enabled: w.notes.enabled && w.notes.folder !== undefined,
        ...tz,
      });
      await voice?.ensureSchedule({ enabled: w.voiceEnabled, ...tz });
      await focus?.ensureSchedule({ enabled: w.focusTime, ...tz });
      await daily.syncSchedules();
    } catch (err) {
      logger?.log("warn", "workflow schedule sync failed", { code: PsycheError.from(err).code });
    }
  }
  /**
   * §7.5: an existing install starts with every mail and meeting workflow off, and gets one Feed
   * card offering the choices. It is posted once, when onboarding was finished before these
   * workflows existed (no workflow setting was ever written) and Mail is connected.
   */
  async function offerWorkflowsOnUpgrade(): Promise<void> {
    if (getSetting(db, UPGRADE_CARD_SETTING) !== undefined) return;
    if (getSetting(db, "ui.onboarding.completedAt") === undefined) return;
    if (WORKFLOW_SETTING_KEYS.some((k) => getSetting(db, k) !== undefined)) return;
    const hasMail = ["mail_search", "gmail_search_threads"].some(
      (t) => registry?.get(t) !== undefined,
    );
    if (!hasMail) return;
    const now = new Date(clock.now()).toISOString();
    const id = `post_${ulid(clock.now())}`;
    feed.store.insert({
      id,
      title: "Psyche can catch you up on mail and meetings",
      bodyMd: [
        "Everything below is off until you turn it on, in Settings → Mail & meetings:",
        "- Morning inbox digest at 7:30",
        "- Prep notes before meetings with people outside your team",
        "- Track replies you're waiting on (shown in the digest only)",
        "- Learn my writing style from sent mail (off unless you opt in)",
        "- Meeting notes from recordings (nothing happens until you add audio)",
        "",
        "Psyche never sends, shares or records without your approval.",
      ].join("\n"),
      citations: [],
      cluster: null,
      score: 1,
      reasons: ["new: mail and meetings"],
      exploration: false,
      briefingId: null,
      feedback: null,
      createdAt: now,
      batchId: id,
      kind: "suggestion",
    });
    const { batchId: _b, readAt: _r, ...wire } = feed.store.get(id) ?? ({} as never);
    publish("feed.updated", { posts: [wire] } as never);
    setSetting(db, UPGRADE_CARD_SETTING, now);
  }
  return {
    goals,
    feed,
    ideas,
    mailWatch,
    digest,
    proposals,
    meetingPrep,
    meetings,
    notesFolder,
    voice,
    drafts,
    scheduling,
    focus,
    daily,
    handlers: {
      ...mountParamsOnly(dailyHandlers as never),
      ...mountParamsOnly(createGoalHandlers(goals) as never),
      ...mountParamsOnly(createFeedHandlers(feed) as never),
      ...mountParamsOnly(createIdeaHandlers(ideas) as never),
      ...proposalHandlers,
      ...(meetings?.handlers ?? {}),
    },
    launcher: (inner, pool) =>
      withProactiveJobs(inner, {
        jobs: [
          goals.checkinJob(),
          feed.job(),
          ideas.job(),
          // Pause stops every mail and meeting job at once (Settings → Mail & meetings).
          pausable(mailWatch.job(), paused),
          ...(digest === undefined ? [] : [pausable(digest.job(), paused)]),
          ...(voice === undefined ? [] : [pausable(voice.job(), paused)]),
          ...(focus === undefined ? [] : [pausable(focus.job(), paused)]),
          ...(meetingPrep === undefined ? [] : [pausable(meetingPrep.job(), paused)]),
          ...(notesFolder === undefined ? [] : [pausable(notesFolder.job(), paused)]),
          ...daily.jobs(),
        ],
        heartbeat: createTaskLauncher({ engine: tasks, pool, budget: HEARTBEAT_TASK_BUDGET }),
        onError: (err) =>
          logger?.log("warn", "proactive job failed", { code: PsycheError.from(err).code }),
      }),
    syncWorkflowSchedules,
    offerWorkflowsOnUpgrade,
    async start() {
      try {
        await goals.start();
        await feed.ensureDailyBrief();
        await ideas.ensureSchedules();
      } catch (err) {
        logger?.log("warn", "proactive schedule sync failed", { code: PsycheError.from(err).code });
      }
      await syncWorkflowSchedules();
      await offerWorkflowsOnUpgrade().catch((err) =>
        logger?.log("warn", "workflow upgrade card failed", { code: PsycheError.from(err).code }),
      );
    },
    stop() {
      proposals?.stop();
    },
  };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Proactive jobs name connector tools bare (`notes_create`); the loop's registry holds them as
 * `mcp__<connector>__<tool>`. An exact name wins, then the first connector tool with that name.
 */
export function connectorToolLookup(registry: AgentToolRegistry): ToolLookup {
  return {
    get(name) {
      const exact = registry.get(name);
      if (exact !== undefined) return exact;
      const suffix = `__${name}`;
      const match = registry
        .list()
        .find((s) => s.name.startsWith("mcp__") && s.name.endsWith(suffix));
      return match === undefined ? undefined : registry.get(match.name);
    },
  };
}
