/**
 * Row ↔ protocol mapping: snake_case storage rows (see `schema.ts`) to the camelCase TypeBox
 * shapes in `@psyche/protocol`. JSON columns are parsed, INTEGER booleans become booleans,
 * BLOB keys become base64url, and NULL stays `null`.
 */
import type {
  ChannelRef,
  Decision,
  Device,
  DevicePlatform,
  DeviceRole,
  DeviceScope,
  LibraryItem,
  Message,
  MessageRole,
  NodeCapability,
  NodeInfo,
  NodeKind,
  NodeStatus,
  PairingRequest,
  PairingStatus,
  PermissionMode,
  Provenance,
  ProvenanceOut,
  Run,
  RunStatus,
  SettingEntry,
  SideEffect,
  Target,
  Thread,
  ThreadKind,
  ToolCall,
  ToolCallStatus,
  Usage,
  UsageRecord,
} from "@psyche/protocol";
import type {
  DeviceRow,
  LibraryItemRow,
  MessageRow,
  NodeRow,
  PairingRequestRow,
  RunRow,
  SettingRow,
  ThreadRow,
  ToolCallRow,
  UsageRow,
} from "./schema.ts";

/** JSON.stringify for a JSON column; `undefined` becomes SQL NULL. */
export function encodeJson(value: unknown): string | null {
  if (value === undefined) return null;
  return JSON.stringify(value);
}

export function decodeJson<T>(text: string): T;
export function decodeJson<T>(text: string | null): T | null;
export function decodeJson<T>(text: string | null): T | null {
  return text === null ? null : (JSON.parse(text) as T);
}

export function toBool(value: number): boolean {
  return value !== 0;
}

export function fromBool(value: boolean | undefined): number {
  return value === true ? 1 : 0;
}

export function deviceFromRow(row: DeviceRow): Device {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform as DevicePlatform,
    role: row.role as DeviceRole,
    publicKey: Buffer.from(row.publicKey).toString("base64url"),
    scopes: decodeJson<DeviceScope[]>(row.scopes),
    pairedAt: row.pairedAt,
    lastSeenAt: row.lastSeenAt,
    revokedAt: row.revokedAt,
  };
}

export function nodeFromRow(row: NodeRow): NodeInfo {
  return {
    id: row.id,
    deviceId: row.deviceId,
    kind: row.kind as NodeKind,
    capabilities: decodeJson<NodeCapability[]>(row.capabilities),
    status: row.status as NodeStatus,
    lastHeartbeatAt: row.lastHeartbeatAt,
  };
}

export function pairingRequestFromRow(row: PairingRequestRow): PairingRequest {
  const out: PairingRequest = {
    id: row.id,
    kind: row.kind as PairingRequest["kind"],
    code: row.code,
    deviceId: row.deviceId,
    channelId: row.channelId,
    senderId: row.senderId,
    display: row.display,
    status: row.status as PairingStatus,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    decidedAt: row.decidedAt,
    decidedByDeviceId: row.decidedByDeviceId,
  };
  if (row.publicKeyFingerprint !== null) out.publicKeyFingerprint = row.publicKeyFingerprint;
  if (row.transport !== null) out.transport = row.transport as "ws" | "unix";
  if (row.remoteAddress !== null) out.remoteAddress = row.remoteAddress;
  return out;
}

export function threadFromRow(row: ThreadRow): Thread {
  return {
    id: row.id,
    kind: row.kind as ThreadKind,
    title: row.title,
    titleSource: row.titleSource as Thread["titleSource"],
    parentThreadId: row.parentThreadId,
    forkedFromMessageId: row.forkedFromMessageId,
    sessionKey: row.sessionKey,
    personaOverlay: row.personaOverlay,
    permissionMode: row.permissionMode as PermissionMode,
    modelRef: row.modelRef,
    pinned: toBool(row.pinned),
    archivedAt: row.archivedAt,
    expiresAt: row.expiresAt,
    activeWriterRunId: row.activeWriterRunId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastMessageAt: row.lastMessageAt,
    ...(row.userCreated === 1 ? { userCreated: true } : {}),
  };
}

export function messageFromRow(row: MessageRow): Message {
  return {
    id: row.id,
    threadId: row.threadId,
    seq: row.seq,
    role: row.role as MessageRole,
    blocks: decodeJson<Message["blocks"]>(row.blocks),
    providerNative: decodeJson<unknown>(row.providerNative),
    provenance: row.provenance as Provenance,
    replyToMessageId: row.replyToMessageId,
    channelRef: decodeJson<ChannelRef>(row.channelRef),
    runId: row.runId,
    createdAt: row.createdAt,
    ...(row.lessonsApplied == null
      ? {}
      : { lessonsApplied: decodeJson<NonNullable<Message["lessonsApplied"]>>(row.lessonsApplied) }),
    ...(row.via === "voice" ? { via: "voice" as const } : {}),
  };
}

export function runFromRow(row: RunRow): Run {
  return {
    id: row.id,
    threadId: row.threadId,
    status: row.status as RunStatus,
    modelRef: row.modelRef,
    attempt: row.attempt,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    error: row.error,
    usage: decodeJson<Usage>(row.usage),
    // Run trace: unset fields stay absent, so a run without a trace maps as before.
    ...(row.kind === null ? {} : { kind: row.kind as NonNullable<Run["kind"]> }),
    ...(row.title === null ? {} : { title: row.title }),
    ...(row.parentRunId === null ? {} : { parentRunId: row.parentRunId }),
    ...(row.rootRunId === null ? {} : { rootRunId: row.rootRunId }),
    ...(row.taskId === null ? {} : { taskId: row.taskId }),
    ...(row.automationRunId === null ? {} : { automationRunId: row.automationRunId }),
    ...(row.origin === null ? {} : { origin: row.origin as NonNullable<Run["origin"]> }),
    ...(row.budget === null ? {} : { budget: decodeJson<NonNullable<Run["budget"]>>(row.budget) }),
    ...(row.deadline === null ? {} : { deadline: row.deadline }),
    ...(row.specialist === null
      ? {}
      : { specialist: decodeJson<NonNullable<Run["specialist"]>>(row.specialist) }),
    ...(row.note === null ? {} : { note: row.note }),
    ...(row.stepCount === 0 ? {} : { stepCount: row.stepCount }),
    ...(row.currentStepId === null ? {} : { currentStepId: row.currentStepId }),
    ...(row.lastStepAt === null ? {} : { lastStepAt: row.lastStepAt }),
  };
}

export function toolCallFromRow(row: ToolCallRow): ToolCall {
  return {
    id: row.id,
    runId: row.runId,
    messageId: row.messageId,
    tool: row.tool,
    paramsRedacted: decodeJson<unknown>(row.paramsRedacted),
    paramsHash: row.paramsHash,
    sideEffect: row.sideEffect as SideEffect,
    target: decodeJson<Target>(row.target),
    decision: row.decision as Decision | null,
    decisionRule: row.decisionRule,
    approvalId: row.approvalId,
    taintIn: toBool(row.taintIn),
    taintOut: toBool(row.taintOut),
    resultRef: row.resultRef,
    provenanceOut: row.provenanceOut as ProvenanceOut,
    receiptId: row.receiptId,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    status: row.status as ToolCallStatus,
    ...(row.stepId === null ? {} : { stepId: row.stepId }),
  };
}

export function settingFromRow(row: SettingRow): SettingEntry {
  return { key: row.key, value: decodeJson<unknown>(row.value), updatedAt: row.updatedAt };
}

export function usageFromRow(row: UsageRow): UsageRecord {
  return {
    id: row.id,
    runId: row.runId,
    job: row.job,
    modelRef: row.modelRef,
    input: row.input,
    output: row.output,
    cacheRead: row.cacheRead,
    cacheWrite: row.cacheWrite,
    reasoning: row.reasoning,
    costUsd: row.costUsd,
    createdAt: row.createdAt,
  };
}

export function libraryItemFromRow(row: LibraryItemRow): LibraryItem {
  const item: LibraryItem = {
    id: row.id,
    kind: row.kind as LibraryItem["kind"],
    name: row.name,
    mime: row.mime,
    path: row.path,
    size: row.size,
    sha256: row.sha256,
    origin: row.origin as LibraryItem["origin"],
    threadId: row.threadId,
    taskId: row.taskId,
    tags: JSON.parse(row.tags) as string[],
    textExtractRef: row.textExtractRef,
    createdAt: row.createdAt,
  };
  if (row.quarantined === 1) item.quarantined = true;
  return item;
}
