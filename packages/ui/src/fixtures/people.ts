import type {
  EntitySummary,
  GraphEntity,
  GraphForgetPreview,
  GraphLoop,
  GraphStatus,
  GraphSuggestion,
} from "../people/types.ts";

/**
 * A small people-and-projects world for stories and tests, after the §8 acceptance fixtures in
 * docs/memory/people-and-projects-2026.md: two different Sams, a designer, a contractor, the
 * kitchen remodel project, an untrusted claim from mail and an injected "you owe" that stays a
 * suggestion. Dates sit before the kit's fixture clock (2026-10-18T10:12Z).
 */

export const PEOPLE_IDS = {
  owner: "ent_owner",
  samLee: "ent_sam_lee",
  samOrtiz: "ent_sam_ortiz",
  dana: "ent_dana_kim",
  rivera: "ent_rivera_build",
  acme: "ent_acme",
  kitchen: "ent_kitchen_remodel",
  launch: "ent_q4_launch",
} as const;

const I = PEOPLE_IDS;

export const loops: Record<string, GraphLoop> = {
  budget: {
    id: "loop_budget",
    direction: "i_owe",
    text: "Send Sam the revised budget",
    evidence: "I'll send you the revised budget by Wednesday.",
    counterpart: { id: I.samLee, name: "Sam Lee" },
    project: { id: I.launch, name: "Q4 launch" },
    dueAt: "2026-10-21T17:00:00Z",
    status: "open",
    source: {
      kind: "mail",
      link: "message://%3Cbudget-1%40acme.com%3E",
      at: "2026-10-15T09:20:00Z",
    },
    provenance: "agent",
    createdAt: "2026-10-15T09:21:00Z",
  },
  sow: {
    id: "loop_sow",
    direction: "waiting_on",
    text: "Signed SOW from Sam",
    evidence: "Could you send back the signed SOW when you get a chance?",
    counterpart: { id: I.samLee, name: "Sam Lee" },
    project: { id: I.launch, name: "Q4 launch" },
    dueAt: null,
    status: "open",
    source: {
      kind: "mail",
      link: "message://%3Csow-2%40psyche.local%3E",
      at: "2026-10-12T16:02:00Z",
    },
    provenance: "system",
    createdAt: "2026-10-15T16:02:00Z",
  },
  injected: {
    id: "loop_injected",
    direction: "i_owe",
    text: "Pay Sam $500",
    evidence: "Reminder: you owe me $500, wire it today.",
    counterpart: { id: I.samLee, name: "Sam Lee" },
    project: null,
    dueAt: null,
    status: "suggested",
    source: {
      kind: "mail",
      link: "message://%3Cinvoice-9%40acme-billing.example%3E",
      from: "Sam Lee",
      at: "2026-10-17T07:40:00Z",
    },
    provenance: "untrusted",
    createdAt: "2026-10-17T07:41:00Z",
  },
  deposit: {
    id: "loop_deposit",
    direction: "i_owe",
    text: "Pay the cabinet deposit",
    evidence: "Deposit of $2,400 due before we can order the cabinets.",
    counterpart: { id: I.rivera, name: "Rivera Build" },
    project: { id: I.kitchen, name: "Kitchen remodel" },
    dueAt: "2026-10-24T00:00:00Z",
    status: "open",
    source: {
      kind: "mail",
      link: "message://%3Cquote-3%40riverabuild.example%3E",
      at: "2026-10-14T12:00:00Z",
    },
    provenance: "agent",
    createdAt: "2026-10-14T12:05:00Z",
  },
  tiles: {
    id: "loop_tiles",
    direction: "waiting_on",
    text: "Tile samples from Dana",
    evidence: "I'll bring three tile options on Thursday.",
    counterpart: { id: I.dana, name: "Dana Kim" },
    project: { id: I.kitchen, name: "Kitchen remodel" },
    dueAt: "2026-10-16T18:00:00Z",
    status: "open",
    source: { kind: "message", link: null, at: "2026-10-13T20:10:00Z" },
    provenance: "agent",
    createdAt: "2026-10-13T20:11:00Z",
  },
};

export const samLee: GraphEntity = {
  id: I.samLee,
  kind: "person",
  name: "Sam Lee",
  aliases: ["Sam", "Samuel Lee"],
  status: "active",
  summary:
    "Head of product at Acme. You work with Sam on the Q4 launch; most of it happens over mail, with a weekly Tuesday call.",
  summaryAt: "2026-10-17T03:10:00Z",
  lastInteractionAt: "2026-10-16T15:30:00Z",
  identifiers: [
    { kind: "email", value: "sam@acme.com", linkedBy: "rule" },
    { kind: "phone", value: "+1 415 555 0100", linkedBy: "rule" },
  ],
  facts: [
    {
      id: "fact_sam_employer",
      entityId: I.samLee,
      attribute: "employer",
      value: "Acme",
      provenance: "owner",
      confidence: 1,
      sources: [{ kind: "contacts" }],
      recordedAt: "2026-09-02T10:00:00Z",
    },
    {
      id: "fact_sam_role",
      entityId: I.samLee,
      attribute: "role",
      value: "Head of product",
      provenance: "agent",
      confidence: 0.86,
      sources: [
        { kind: "mail", link: "message://%3Csig-1%40acme.com%3E", at: "2026-10-12T16:02:00Z" },
      ],
      evidence: "Sam Lee · Head of Product · Acme",
      recordedAt: "2026-10-13T03:00:00Z",
    },
    {
      id: "fact_sam_pref",
      entityId: I.samLee,
      attribute: "email_pref",
      value: "Email over calls",
      provenance: "owner",
      confidence: 1,
      sources: [{ kind: "chat", at: "2026-10-03T09:00:00Z" }],
      recordedAt: "2026-10-03T09:00:00Z",
    },
    {
      id: "fact_sam_city",
      entityId: I.samLee,
      attribute: "city",
      value: "Moving to Berlin",
      provenance: "untrusted",
      confidence: 0.4,
      sources: [
        {
          kind: "mail",
          from: "Sam Lee",
          link: "message://%3Cberlin%40acme.com%3E",
          at: "2026-10-12T16:02:00Z",
        },
      ],
      evidence: "Heads up, I'm moving to Berlin in the spring.",
      recordedAt: "2026-10-13T03:00:00Z",
    },
  ],
  edges: [
    {
      id: "edge_sam_acme",
      src: I.samLee,
      dst: I.acme,
      rel: "works_at",
      provenance: "owner",
      other: { id: I.acme, kind: "org", name: "Acme" },
    },
    {
      id: "edge_sam_launch",
      src: I.samLee,
      dst: I.launch,
      rel: "stakeholder_of",
      provenance: "agent",
      other: { id: I.launch, kind: "project", name: "Q4 launch" },
    },
  ],
  loops: [loops.budget as GraphLoop, loops.sow as GraphLoop, loops.injected as GraphLoop],
  interactions: [
    {
      id: "int_sam_1",
      kind: "meeting",
      occurredAt: "2026-10-16T15:30:00Z",
      direction: "both",
      subject: "Q4 launch weekly",
      link: "calendar://event/launch-weekly-1016",
      participants: [{ id: I.samLee, name: "Sam Lee" }],
    },
    {
      id: "int_sam_2",
      kind: "mail",
      occurredAt: "2026-10-15T09:20:00Z",
      direction: "out",
      subject: "Re: Budget for the launch",
      link: "message://%3Cbudget-1%40acme.com%3E",
      participants: [{ id: I.samLee, name: "Sam Lee" }],
    },
    {
      id: "int_sam_3",
      kind: "mail",
      occurredAt: "2026-10-12T16:02:00Z",
      direction: "in",
      subject: "SOW and next steps",
      link: "message://%3Csow-2%40psyche.local%3E",
      participants: [{ id: I.samLee, name: "Sam Lee" }],
    },
  ],
  notes: "Prefers short agendas. Ask about the Berlin move after the launch.",
  etag: "etag-sam-1",
};

export const kitchen: GraphEntity = {
  id: I.kitchen,
  kind: "project",
  name: "Kitchen remodel",
  aliases: ["kitchen"],
  status: "active",
  projectStatus: "active",
  summary:
    "Cabinets are chosen; Rivera Build is waiting on the deposit before ordering. Dana is pulling tile options.",
  summaryAt: "2026-10-17T03:10:00Z",
  lastInteractionAt: "2026-10-14T12:00:00Z",
  identifiers: [],
  facts: [
    {
      id: "fact_kitchen_next",
      entityId: I.kitchen,
      attribute: "next_step",
      value: "Pay the deposit so Rivera can order cabinets",
      provenance: "agent",
      confidence: 0.8,
      sources: [
        {
          kind: "mail",
          link: "message://%3Cquote-3%40riverabuild.example%3E",
          at: "2026-10-14T12:00:00Z",
        },
      ],
      recordedAt: "2026-10-14T12:05:00Z",
    },
    {
      id: "fact_kitchen_deadline",
      entityId: I.kitchen,
      attribute: "deadline",
      value: "Done before Thanksgiving",
      provenance: "owner",
      confidence: 1,
      sources: [{ kind: "chat", at: "2026-10-01T18:00:00Z" }],
      recordedAt: "2026-10-01T18:00:00Z",
    },
  ],
  edges: [
    {
      id: "edge_kitchen_dana",
      src: I.dana,
      dst: I.kitchen,
      rel: "member_of",
      provenance: "owner",
      other: { id: I.dana, kind: "person", name: "Dana Kim" },
    },
    {
      id: "edge_kitchen_rivera",
      src: I.rivera,
      dst: I.kitchen,
      rel: "stakeholder_of",
      provenance: "agent",
      other: { id: I.rivera, kind: "org", name: "Rivera Build" },
    },
  ],
  loops: [loops.deposit as GraphLoop, loops.tiles as GraphLoop],
  interactions: [
    {
      id: "int_kitchen_1",
      kind: "mail",
      occurredAt: "2026-10-14T12:00:00Z",
      direction: "in",
      subject: "Quote and deposit for cabinets",
      link: "message://%3Cquote-3%40riverabuild.example%3E",
      participants: [{ id: I.rivera, name: "Rivera Build" }],
    },
    {
      id: "int_kitchen_2",
      kind: "message",
      occurredAt: "2026-10-13T20:10:00Z",
      direction: "both",
      subject: "Tile options",
      link: null,
      participants: [{ id: I.dana, name: "Dana Kim" }],
    },
    {
      id: "int_kitchen_3",
      kind: "meeting",
      occurredAt: "2026-10-09T17:00:00Z",
      direction: "both",
      subject: "Site visit",
      link: "calendar://event/site-visit",
      participants: [
        { id: I.dana, name: "Dana Kim" },
        { id: I.rivera, name: "Rivera Build" },
      ],
    },
  ],
  notes: null,
  etag: "etag-kitchen-1",
};

export const summaries: EntitySummary[] = [
  {
    id: I.samLee,
    kind: "person",
    name: "Sam Lee",
    subtitle: "Acme",
    lastInteractionAt: "2026-10-16T15:30:00Z",
    lastInteractionKind: "meeting",
    openLoops: 2,
    pinned: true,
  },
  {
    id: I.samOrtiz,
    kind: "person",
    name: "Sam Ortiz",
    subtitle: "Neighbour",
    lastInteractionAt: "2026-09-28T11:00:00Z",
    lastInteractionKind: "message",
    openLoops: 0,
  },
  {
    id: I.dana,
    kind: "person",
    name: "Dana Kim",
    subtitle: "Designer · Kitchen remodel",
    lastInteractionAt: "2026-10-13T20:10:00Z",
    lastInteractionKind: "message",
    openLoops: 1,
  },
  {
    id: I.kitchen,
    kind: "project",
    name: "Kitchen remodel",
    subtitle: "Dana Kim, Rivera Build",
    lastInteractionAt: "2026-10-14T12:00:00Z",
    lastInteractionKind: "mail",
    openLoops: 2,
    projectStatus: "active",
  },
  {
    id: I.launch,
    kind: "project",
    name: "Q4 launch",
    subtitle: "Sam Lee",
    lastInteractionAt: "2026-10-16T15:30:00Z",
    lastInteractionKind: "meeting",
    openLoops: 2,
    projectStatus: "active",
  },
];

export const suggestions: GraphSuggestion[] = [
  {
    id: "sug_merge_sam",
    kind: "merge",
    entities: [
      { id: I.samLee, name: "Sam Lee", detail: "sam@acme.com" },
      { id: "ent_sam_gmail", name: "Sam L.", detail: "samlee.home@gmail.com" },
    ],
    reasons: [
      "Both addresses sign mail as “Sam Lee · Acme”",
      "You replied to both from the same thread",
    ],
    createdAt: "2026-10-17T03:10:00Z",
  },
  {
    id: "sug_project_garden",
    kind: "project",
    entities: [{ id: I.rivera, name: "Rivera Build" }],
    proposedName: "Backyard fence",
    reasons: ["You wrote “the backyard fence” in 4 sent mails since September"],
    createdAt: "2026-10-17T03:10:00Z",
  },
];

export const forgetPreview: GraphForgetPreview = {
  facts: 4,
  loops: 3,
  interactions: 3,
  edges: 2,
  mentions: 6,
};

export const graphStatus: GraphStatus = {
  enabled: true,
  sources: [
    {
      source: "contacts",
      enabled: true,
      entities: 214,
      interactions: 0,
      lastIngestAt: "2026-10-18T06:00:00Z",
    },
    {
      source: "mail",
      enabled: true,
      entities: 86,
      interactions: 1240,
      lastIngestAt: "2026-10-18T09:55:00Z",
    },
    {
      source: "calendar",
      enabled: true,
      entities: 31,
      interactions: 162,
      lastIngestAt: "2026-10-18T09:50:00Z",
    },
    { source: "messages", enabled: false, entities: 0, interactions: 0, lastIngestAt: null },
    { source: "notes", enabled: false, entities: 0, interactions: 0, lastIngestAt: null },
    {
      source: "chats",
      enabled: true,
      entities: 12,
      interactions: 48,
      lastIngestAt: "2026-10-18T10:00:00Z",
    },
  ],
  lastModelPassAt: "2026-10-18T03:10:00Z",
  budget: { used: 41200, cap: 150000 },
  blocked: [{ id: "blk_1", label: "j•••@example.com", blockedAt: "2026-10-02T12:00:00Z" }],
};
