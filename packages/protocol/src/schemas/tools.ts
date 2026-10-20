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
    /**
     * Who wrote `description` and the text in `inputSchema`: `untrusted` for a third-party
     * MCP server (security §11, #281), so the loop can taint and the model can be told it is
     * data. Absent means Psyche's own tool text.
     */
    descriptionProvenance: Type.Optional(ProvenanceOut),
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
