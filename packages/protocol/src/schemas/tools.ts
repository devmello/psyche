import { type Static, Type } from "@sinclair/typebox";
import {
  Decision,
  Id,
  IsoDateTime,
  JsonSchema,
  Nullable,
  ProvenanceOut,
  SideEffect,
  StringEnum,
  Target,
  TargetKind,
} from "../common.ts";
import { ToolCallStatus } from "./blocks.ts";

/**
 * Which display a computer-use session drives (linux design §5, §11): the owner's own desktop
 * (`direct`), an invisible display on the owner's machine (`virtual_screen`), or a container or
 * VM with its own apps and files (`separate_desktop`). Only the enum lives here; the tool params
 * that carry it are local to the Gateway and default to `direct`, so the Mac is unchanged.
 */
export const ComputerSurface = StringEnum(["direct", "virtual_screen", "separate_desktop"], {
  $id: "ComputerSurface",
});
export type ComputerSurface = Static<typeof ComputerSurface>;

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
    /** The run-trace step that shows this call (`stp_…`; run trace §4.2). */
    stepId: Type.Optional(Id),
  },
  { $id: "ToolCall" },
);
export type ToolCall = Static<typeof ToolCall>;
