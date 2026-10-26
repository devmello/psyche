import type {
  ActionProposal,
  DigestLoop,
  FeedPost,
  GraphLoop,
  InboxDigest,
  MeetingNotes,
  MeetingPrep,
} from "@psyche/protocol";
import type { DraftView, SchedulingView } from "../screens/workflows/types.ts";
import { ago, at, inMinutes } from "./ids.ts";

/**
 * Mail and meeting workflow fixtures (docs/workflows/mail-and-meetings-2026.md §4, §7): one
 * morning's digest, the due follow-ups, a draft, a scheduling thread, a meeting prep note and
 * one meeting's notes, as the Gateway's jobs post them. All names are made up.
 */

export const WORKFLOW_IDS = {
  posts: {
    digest: "post_digest_1018",
    prep: "post_prep_acme",
    notes: "post_notes_roadmap",
  },
  digest: "digest_1018",
  notes: "notes_roadmap",
  meeting: "evt_acme_review",
  proposals: {
    newsletters: "prop_newsletters",
    notifications: "prop_notifications",
    reminders: "prop_reminders_roadmap",
  },
  loops: {
    dana: "loop_dana_contract",
    priya: "loop_priya_invoice",
    owe: "loop_owe_deck",
    stale: "loop_marco_quote",
  },
} as const;

const W = WORKFLOW_IDS;

function graphLoop(
  id: string,
  direction: GraphLoop["direction"],
  text: string,
  createdAt: string,
  dueAt: string | null = null,
): GraphLoop {
  return {
    id,
    direction,
    text,
    evidence: null,
    counterpartId: null,
    projectId: null,
    dueAt,
    status: "open",
    sourceInteractionId: null,
    provenance: "system",
    confidence: 0.8,
    detectedBy: "rule",
    createdAt,
    closedAt: null,
    closedBy: null,
  };
}

/** The due follow-ups: two waiting on others, one the owner owes, one gone stale. */
export function workflowLoops(): DigestLoop[] {
  return [
    {
      loop: graphLoop(W.loops.dana, "waiting_on", "contract draft", ago(4 * 1440)),
      counterpart: "Dana Ruiz",
      thread: {
        account: "work",
        threadId: "t_dana",
        subject: "Contract draft",
        from: "Dana Ruiz <dana@northwind.example>",
        at: ago(4 * 1440),
      },
      shownCount: 1,
    },
    {
      loop: graphLoop(W.loops.priya, "waiting_on", "September invoice", ago(3 * 1440)),
      counterpart: "Priya Shah",
      shownCount: 1,
    },
    {
      loop: graphLoop(W.loops.owe, "i_owe", "send the Q4 deck", ago(2 * 1440), inMinutes(1440)),
      counterpart: "Sam Lee",
      shownCount: 1,
    },
    {
      loop: graphLoop(W.loops.stale, "waiting_on", "the venue quote", ago(9 * 1440)),
      counterpart: "Marco Bianchi",
      shownCount: 2,
    },
  ];
}

export function inboxDigest(): InboxDigest {
  const loops = workflowLoops();
  return {
    id: W.digest,
    createdAt: ago(162),
    since: ago(162 + 1440),
    until: ago(162),
    accounts: ["work", "personal"],
    counts: { needs_you: 3, soon: 2, fyi: 9, newsletters: 12, notifications: 7, screen: 2 },
    needsYou: [
      {
        thread: {
          account: "work",
          threadId: "t_sam",
          link: "message://%3Csam-1%40acme.example%3E",
          subject: "Can we move Thursday's review?",
          from: "Sam Lee <sam@acme.example>",
          at: ago(300),
        },
        category: "needs_you",
        summary: "Asks to move Thursday's review to Friday morning.",
        because: "asks you a direct question",
        actions: ["draft_reply", "propose_times", "remind", "open"],
      },
      {
        thread: {
          account: "work",
          threadId: "t_legal",
          subject: "Signature needed: NDA",
          from: "Jordan Park <jordan@northwind.example>",
          at: ago(420),
        },
        category: "needs_you",
        summary: "The NDA is ready for your signature by Friday.",
        because: "a deadline: Friday",
        actions: ["draft_reply", "remind", "save_attachment", "open"],
      },
      {
        thread: {
          account: "personal",
          threadId: "t_school",
          subject: "Field trip form",
          from: "Lakeside School <office@lakeside.example>",
          at: ago(700),
        },
        category: "needs_you",
        summary: "The field trip permission form is due Wednesday.",
        because: "you replied to this sender before",
        actions: ["remind", "open"],
      },
    ],
    groups: [
      {
        category: "newsletters",
        count: 12,
        title: "12 newsletters · Mark read · Move to Reading",
        proposalId: W.proposals.newsletters,
      },
      {
        category: "notifications",
        count: 7,
        title: "7 notifications · Mark read",
        proposalId: W.proposals.notifications,
      },
      { category: "fyi", count: 9, title: "9 for your information", proposalId: null },
    ],
    waitingOn: loops.slice(0, 2),
    screen: [
      {
        thread: {
          account: "work",
          threadId: "t_new",
          subject: "Partnership idea",
          from: "Alex Moreau <alex@startup.example>",
          at: ago(200),
        },
        category: "screen",
        summary: "Introduces a design studio and asks for a call.",
        actions: ["allow_sender", "not_now", "always_archive"],
      },
    ],
    unverified: [
      {
        thread: {
          account: "personal",
          threadId: "t_phish",
          subject: "Your account is locked",
          from: "Bank Support <support@bank-secure.example>",
          at: ago(90),
        },
        category: "unverified",
        summary: "Says your account is locked and asks you to sign in.",
        because: "the sender failed DMARC",
        actions: ["archive", "open"],
      },
    ],
    taint: true,
    usedCloudModel: true,
  };
}

/** A digest with nothing that needs the owner. */
export function quietDigest(): InboxDigest {
  return {
    ...inboxDigest(),
    counts: { fyi: 4, newsletters: 3 },
    needsYou: [],
    groups: [],
    waitingOn: [],
    screen: [],
    unverified: [],
    usedCloudModel: false,
  };
}

export function meetingPrep(): MeetingPrep {
  return {
    meetingId: W.meeting,
    title: "Acme quarterly review",
    startAt: inMinutes(48),
    endAt: inMinutes(108),
    joinUrl: "https://meet.example/acme-review",
    attendees: [
      {
        email: "sam@acme.example",
        name: "Sam Lee",
        relationship: "external",
        summary: "Head of operations at Acme; your main contact.",
      },
      { email: "kai@acme.example", name: "Kai Tanaka", relationship: "external" },
      { email: "rosa@northwind.example", name: "Rosa Diaz", relationship: "colleague" },
    ],
    why: {
      text: "Sam asked to review the Q3 numbers before renewal.",
      source: { kind: "thread", ref: "t_sam", label: "Q3 review" },
    },
    openLoops: [
      graphLoop(W.loops.owe, "i_owe", "send the Q4 deck", ago(2 * 1440)),
      graphLoop("loop_acme_sla", "waiting_on", "the signed SLA", ago(6 * 1440)),
    ],
    lastTime: [
      {
        text: "Agreed to move support to the new tier from November.",
        source: { kind: "meeting", ref: "notes_acme_july", label: "July review" },
      },
    ],
    worthReading: [
      {
        text: "Q3 usage report",
        source: { kind: "library", ref: "lib_q3_usage", label: "Q3 usage.pdf" },
      },
      {
        text: "Acme's renewal terms",
        source: { kind: "url", ref: "https://docs.example/acme-renewal", label: "docs.example" },
      },
    ],
    agenda: ["Q3 numbers", "Support tier change", "Renewal timeline"],
    taint: true,
  };
}

export function meetingNotes(): MeetingNotes {
  return {
    id: W.notes,
    meetingId: "evt_roadmap",
    title: "Roadmap sync",
    startedAt: ago(95),
    durationMs: 42 * 60_000,
    recordingItemId: "lib_rec_roadmap",
    transcriptItemId: "lib_tr_roadmap",
    summary: [
      "The mobile launch moves to January so the payments work can finish first.",
      "Design shares the new onboarding flow next week.",
    ],
    decisions: [
      { text: "Mobile launch moves to January 14.", atMs: 12 * 60_000 + 4_000 },
      { text: "Payments ships behind a flag in December.", atMs: 27 * 60_000 + 31_000 },
    ],
    actionItems: [
      {
        text: "Send the revised timeline to the team",
        owner: "owner",
        dueAt: inMinutes(2 * 1440),
        atMs: 13 * 60_000,
        proposalId: W.proposals.reminders,
      },
      {
        text: "Book a payments review with finance",
        owner: "owner",
        dueAt: null,
        atMs: 29 * 60_000,
        proposalId: W.proposals.reminders,
      },
      {
        text: "Share the onboarding mockups",
        owner: "Rosa Diaz",
        dueAt: inMinutes(5 * 1440),
        loopId: "loop_rosa_mockups",
      },
    ],
    openQuestions: ["Do we need a separate Android beta?"],
    model: { role: "primary", remote: false },
    provenance: "untrusted",
  };
}

export function draftView(): DraftView {
  return {
    to: "Sam Lee <sam@acme.example>",
    subject: "Re: Can we move Thursday's review?",
    body: "Hi Sam,\n\nFriday morning works for me. Does 10:00 suit you?\nI'll send the deck the day before.\n\nThanks,\nAlex",
    commitments: ["Friday morning works for me.", "I'll send the deck the day before."],
    voiceUsed: true,
    link: "message://%3Cdraft-1%40local%3E",
    status: "draft",
    taintFrom: "Sam Lee",
  };
}

export function schedulingView(): SchedulingView {
  return {
    subject: "Thursday's review",
    with: "Sam Lee",
    timeZone: "Europe/London",
    theirTimeZone: "America/New_York",
    slots: [
      { start: at(2 * 86_400 - 1_920), end: at(2 * 86_400 + 1_080) },
      { start: at(2 * 86_400 + 12_480), end: at(2 * 86_400 + 15_480) },
      { start: at(3 * 86_400 - 1_920), end: at(3 * 86_400 + 1_080) },
    ],
    state: "proposed",
    holds: 0,
    schedulingLink: null,
    taintFrom: "Sam Lee",
  };
}

function workflowPost(
  id: string,
  title: string,
  createdAt: string,
  kind: FeedPost["kind"],
  card: NonNullable<FeedPost["card"]>,
): FeedPost {
  return {
    id,
    title,
    bodyMd: "",
    citations: [],
    cluster: null,
    score: 1,
    reasons: [],
    exploration: false,
    briefingId: null,
    feedback: null,
    createdAt,
    kind,
    card,
  };
}

/** The three workflow Feed posts: the digest, a meeting prep and meeting notes. */
export function workflowPosts(): FeedPost[] {
  return [
    workflowPost(W.posts.digest, "Inbox", ago(162), "digest", {
      type: "digest",
      digest: inboxDigest(),
    }),
    workflowPost(W.posts.prep, "Acme quarterly review", ago(12), "meeting_prep", {
      type: "meeting_prep",
      prep: meetingPrep(),
    }),
    workflowPost(W.posts.notes, "Roadmap sync", ago(50), "meeting_notes", {
      type: "meeting_notes",
      notes: meetingNotes(),
    }),
  ];
}

/** Adds the workflow posts to a world's Feed, newest first. */
export function withWorkflows<W extends { feed: FeedPost[]; proposals?: ActionProposal[] }>(
  w: W,
): W {
  w.feed = [...workflowPosts(), ...w.feed];
  w.proposals = [...(w.proposals ?? []), ...workflowProposals()];
  return w;
}

const MARK_READ_TITLES = [
  ["Weekly digest", "Acme"],
  ["This week in design", "Pixel Press"],
  ["Your receipt", "Notion"],
  ["New on the blog", "Northwind"],
  ["Product updates", "Linear"],
  ["Sunday reads", "The Browser"],
] as const;

/** A batch of "Mark read" calls (reversible), as the digest's newsletters group proposes. */
export function markReadProposal(
  status: ActionProposal["status"] = "pending",
  overrides: Partial<ActionProposal> = {},
): ActionProposal {
  const calls = MARK_READ_TITLES.map(([subject, sender], i) => ({
    tool: "mail_mark_read",
    params: { account: "work", messageId: `m_${i}` },
    summary: `Mark read: ${subject} (${sender})`,
  }));
  return {
    id: W.proposals.newsletters,
    title: `Mark ${calls.length} newsletters read`,
    calls,
    sideEffect: "write",
    status,
    createdBy: { job: "mail.digest" },
    postId: W.posts.digest,
    approvalId: null,
    taint: true,
    createdAt: ago(160),
    expiresAt: inMinutes(1300),
    updatedAt: ago(160),
    ...overrides,
  };
}

/** The reminders the meeting notes propose (not reversible by the mail inverses). */
export function remindersProposal(): ActionProposal {
  return {
    ...markReadProposal(),
    id: W.proposals.reminders,
    title: "Add 2 reminders from Roadmap sync",
    calls: [
      {
        tool: "reminders_create",
        params: { title: "Send the revised timeline to the team" },
        summary: "Remind me: Send the revised timeline to the team",
      },
      {
        tool: "reminders_create",
        params: { title: "Book a payments review with finance" },
        summary: "Remind me: Book a payments review with finance",
      },
    ],
    createdBy: { job: "meetings.notes" },
    postId: W.posts.notes,
  };
}

/** Both proposals the workflow posts point at, pending. */
export function workflowProposals(): ActionProposal[] {
  return [
    markReadProposal(),
    markReadProposal("pending", {
      id: W.proposals.notifications,
      title: "Mark 7 notifications read",
    }),
    remindersProposal(),
  ];
}
