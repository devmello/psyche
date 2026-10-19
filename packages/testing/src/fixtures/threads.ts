import type { Message, Run, Thread } from "@psyche/protocol";

/** Fixed ULIDs so fixtures validate against the strict `Ulid` schema too. */
export const FIXTURE_IDS = {
  thread: "01JAX2B7Q9K3M4N5P6R7S8T9V0",
  run: "01JAX4C8R0M5N6P7Q8R9S0T1V2",
  task: "01JAX3D9S1N6P7Q8R9S0T1V2W3",
  approval: "01JAX5E0T2P7Q8R9S0T1V2W3X4",
  toolCall: "01JAX6F1V3Q8R9S0T1V2W3X4Y5",
  messages: [
    "01JAX7G2W4R9S0T1V2W3X4Y5Z6",
    "01JAX7G2W4R9S0T1V2W3X4Y5Z7",
    "01JAX7G2W4R9S0T1V2W3X4Y5Z8",
  ],
} as const;

export const SAMPLE_THREAD: Thread = {
  id: FIXTURE_IDS.thread,
  kind: "main",
  title: "Permission slip for the museum trip",
  titleSource: "auto",
  parentThreadId: null,
  forkedFromMessageId: null,
  sessionKey: "owner:main",
  personaOverlay: null,
  permissionMode: "balanced",
  modelRef: "anthropic/claude-sonnet-5-5",
  pinned: false,
  archivedAt: null,
  expiresAt: null,
  activeWriterRunId: null,
  createdAt: "2026-10-18T20:10:00Z",
  updatedAt: "2026-10-18T20:11:09Z",
  lastMessageAt: "2026-10-18T20:11:09Z",
};

export const SAMPLE_RUN: Run = {
  id: FIXTURE_IDS.run,
  threadId: FIXTURE_IDS.thread,
  status: "awaiting_approval",
  modelRef: "anthropic/claude-sonnet-5-5",
  attempt: 1,
  startedAt: "2026-10-18T20:10:30Z",
  endedAt: null,
  error: null,
  usage: {
    input: 5120,
    output: 412,
    cacheRead: 4096,
    cacheWrite: 0,
    reasoning: 128,
    costUsd: 0.0213,
  },
};

export const SAMPLE_MESSAGES: Message[] = [
  {
    id: FIXTURE_IDS.messages[0],
    threadId: FIXTURE_IDS.thread,
    seq: 0,
    role: "user",
    blocks: [
      { type: "text", md: "Fill in the museum permission slip from Alice and send it back." },
    ],
    providerNative: null,
    provenance: "owner",
    replyToMessageId: null,
    channelRef: null,
    runId: null,
    createdAt: "2026-10-18T20:10:00Z",
  },
  {
    id: FIXTURE_IDS.messages[1],
    threadId: FIXTURE_IDS.thread,
    seq: 1,
    role: "agent",
    blocks: [
      { type: "text", md: "Found Alice's email with **permission-slip.pdf**. Filling it in now." },
      {
        type: "tool_call",
        toolCallId: FIXTURE_IDS.toolCall,
        tool: "email.read",
        status: "ok",
        level1: "Read 3 messages from alice@example.com",
      },
      {
        type: "checklist",
        items: [
          { text: "Read the email", status: "completed" },
          { text: "Fill the PDF form", status: "in_progress" },
          { text: "Send the reply", status: "pending" },
        ],
      },
      { type: "task", taskId: FIXTURE_IDS.task },
    ],
    providerNative: {
      provider: "anthropic",
      content: [{ type: "thinking", signature: "fixture-sig" }],
    },
    provenance: "agent",
    replyToMessageId: FIXTURE_IDS.messages[0],
    channelRef: null,
    runId: FIXTURE_IDS.run,
    createdAt: "2026-10-18T20:10:45Z",
  },
  {
    id: FIXTURE_IDS.messages[2],
    threadId: FIXTURE_IDS.thread,
    seq: 2,
    role: "agent",
    blocks: [
      { type: "approval", approvalId: FIXTURE_IDS.approval },
      {
        type: "wrap_up",
        recap: "The slip is filled in and the reply is drafted; sending needs your approval.",
        ask: "Send the reply to Alice?",
        actions: [
          { label: "Send it" },
          { label: "Show me first", message: "Show me the filled PDF" },
        ],
      },
    ],
    providerNative: null,
    provenance: "agent",
    replyToMessageId: null,
    channelRef: null,
    runId: FIXTURE_IDS.run,
    createdAt: "2026-10-18T20:11:09Z",
  },
];
