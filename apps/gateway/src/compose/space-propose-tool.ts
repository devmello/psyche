import { type AgentToolRegistration, defineTool } from "@psyche/agent-core";
import type { PsycheDb } from "@psyche/db";
import {
  type EventName,
  type EventPayload,
  PsycheError,
  SPACE_LIMITS,
  type TaintSource,
  type ToolResult,
} from "@psyche/protocol";
import { Type } from "@sinclair/typebox";
import {
  type MigrationMemory,
  type MigrationThreadStates,
  migrationHandlers,
} from "../spaces/migration.ts";
import { createProposal } from "../spaces/proposals.ts";
import { turnTaint } from "../widgets/tools.ts";
import type { ComposedPart } from "./services.ts";

/**
 * `space_propose` (docs/design/spaces-2026.md §4.3, SP4, SR9) and the migration offers (§8).
 * The tool never creates a Space: it records a proposal and the Home card asks the owner, who
 * creates it with a plain tap. It takes a name, a reason, a project and chats, and nothing else.
 * Its text from a tainted turn keeps the turn's taint, and the card shows it as quoted data.
 */

const DESCRIPTION =
  "Propose a new Space (a lasting workspace for one project: its chats, files and trackers). " +
  "This only suggests: the owner sees a card on Home and decides. Use it when the owner keeps returning to one " +
  "project across several chats, not for a one-off question. Give a short name, one sentence on why, " +
  "optionally the Memory project (entityId) and the chats to bring in (default: this chat). " +
  "You cannot set folders, instructions or permissions, and you cannot create the Space yourself.";

const Input = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: SPACE_LIMITS.name }),
    reason: Type.String({ minLength: 1, maxLength: 600 }),
    entityId: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
    threadIds: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { maxItems: 10 }),
    ),
  },
  { additionalProperties: false },
);

const toolError = (e: unknown): ToolResult => {
  const err = e instanceof PsycheError ? e : new PsycheError("internal", String(e));
  return {
    output: { error: { code: err.code, message: err.message } },
    isError: true,
    provenance: "trusted",
  };
};

/** Taint sources kept short: an origin or sender is third-party text. */
function cleanTaint(taint: readonly TaintSource[]): TaintSource[] {
  const cut = (s: string | undefined) => (s === undefined ? undefined : s.slice(0, 200));
  return taint.slice(0, 5).map((t) => ({
    sourceKind: t.sourceKind.slice(0, 80),
    ...(t.origin === undefined ? {} : { origin: cut(t.origin) as string }),
    ...(t.sender === undefined ? {} : { sender: cut(t.sender) as string }),
  }));
}

export interface SpaceProposeDeps {
  readonly db: PsycheDb;
  readonly register: (tool: AgentToolRegistration) => () => void;
  readonly publish: <E extends EventName>(
    event: E,
    payload: EventPayload<E>,
    threadId?: string,
  ) => void;
  /** The people graph, for project checks and the migration offer. */
  readonly memory?:
    | (() => (MigrationMemory & { getEntity(id: string): unknown }) | undefined)
    | undefined;
  readonly states?: MigrationThreadStates | undefined;
}

export function spaceProposeTool(deps: SpaceProposeDeps): AgentToolRegistration {
  return defineTool({
    name: "space_propose",
    description: DESCRIPTION,
    input: Input,
    sideEffect: "none",
    describeCall: (p) => ({ summary: `Suggested a Space "${p.name}"` }),
    run: async (p, ctx) => {
      try {
        const memory = deps.memory?.();
        const { proposal, created } = createProposal(
          {
            db: deps.db,
            ...(memory === undefined
              ? {}
              : {
                  projectExists: (id: string) => {
                    const e = memory.getEntity(id) as
                      | { kind?: string; private?: boolean }
                      | undefined;
                    return e?.kind === "project" && e.private !== true;
                  },
                }),
          },
          {
            name: p.name,
            reason: p.reason,
            entityId: p.entityId,
            threadIds: p.threadIds,
            currentThreadId: ctx.threadId,
            taint: cleanTaint(turnTaint(ctx)),
          },
        );
        if (created) deps.publish("space.proposal.created", { proposal });
        return {
          output: {
            proposalId: proposal.id,
            status: created ? "suggested" : "already suggested",
            note: "The owner decides. Do not say the Space exists.",
          },
          provenance: "trusted",
        };
      } catch (e) {
        return toolError(e);
      }
    },
  });
}

/** The tool and the migration handlers, as one composed part. */
export function composeSpaceOffers(deps: SpaceProposeDeps): ComposedPart {
  const unregister = deps.register(spaceProposeTool(deps));
  return {
    handlers: migrationHandlers({
      db: deps.db,
      memory: deps.memory,
      states: deps.states,
    }),
    stop: () => unregister(),
  };
}
