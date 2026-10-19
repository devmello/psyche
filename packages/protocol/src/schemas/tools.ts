import { type Static, Type } from "@sinclair/typebox";
import {
  Decision,
  Id,
  IsoDateTime,
  JsonSchema,
  Nullable,
  ProvenanceOut,
  SideEffect,
  Target,
  TargetKind,
} from "../common.ts";
import { ToolCallStatus } from "./blocks.ts";

/**
 * Tool declaration (architecture §4.3). The registry is the single source for the
 * Permission Broker and the tool-toggle settings. Connector tools are `mcp__<server>__<tool>`.
 */
export const ToolSpec = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    description: Type.String(),
    inputSchema: JsonSchema,
    sideEffect: SideEffect,
    targetKind: Type.Optional(TargetKind),
    provenanceOut: ProvenanceOut,
  },
  { $id: "ToolSpec" },
);
export type ToolSpec = Static<typeof ToolSpec>;

export const ToolCall = Type.Object(
  {
    id: Id,
    runId: Id,
    messageId: Nullable(Id),
    tool: Type.String(),
    paramsRedacted: Type.Unknown({
      description: "Params with {{cred:…}} placeholders kept; never secrets",
    }),
    paramsHash: Type.String(),
    sideEffect: SideEffect,
    target: Nullable(Target),
    decision: Nullable(Decision),
    decisionRule: Nullable(Type.String()),
    approvalId: Nullable(Id),
    taintIn: Type.Boolean(),
    taintOut: Type.Boolean(),
    resultRef: Nullable(Type.String()),
    provenanceOut: ProvenanceOut,
    receiptId: Nullable(Id),
    startedAt: IsoDateTime,
    endedAt: Nullable(IsoDateTime),
    status: ToolCallStatus,
  },
  { $id: "ToolCall" },
);
export type ToolCall = Static<typeof ToolCall>;
