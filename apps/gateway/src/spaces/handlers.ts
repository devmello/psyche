import { getThread } from "@psyche/db";
import {
  type Automation,
  type MethodName,
  type MethodParams,
  type MethodResult,
  PsycheError,
  type Space,
  type SpaceLink,
} from "@psyche/protocol";
import type { Call, HandlerDef } from "../context.ts";
import { proposalChats } from "./proposals.ts";
import { projectPrivateError, SpaceStore } from "./store.ts";

/**
 * `spaces.*` handlers (docs/design/spaces-2026.md §4.2), wave S1: the Space itself, links, moving
 * chats and automations, and proposals. Not here, by wave:
 * - S2: `spaces.folders.*` and `spaces.settings.set` (they stay unregistered, so they answer
 *   `not_implemented`);
 * - S4: `spaces.trackers.*` and `spaces.open`;
 * - S3: `spaces.context.preview`.
 */

/** What the handlers need from the scheduler: pause and resume, and a read for the event. */
export interface SpaceAutomations {
  setEnabled(id: string, enabled: boolean): Promise<unknown>;
  get(id: string): Promise<Automation | undefined>;
}

/** What the handlers read of a Memory project: whether it is Keep private, and its name. */
export interface SpaceProjects {
  getEntity(id: string): { name?: string; private?: boolean | undefined } | undefined;
}

export interface SpaceHandlerDeps {
  /** The scheduler. Without one the automations table is written directly (tests). */
  readonly automations?: SpaceAutomations | undefined;
  /** The people graph, to refuse a Keep-private project (SR10) and name the linked one. */
  readonly projects?: (() => SpaceProjects | undefined) | undefined;
}

type P<M extends MethodName> = MethodParams<M>;

function changed(call: Call, spaceId: string, what: string[]): void {
  call.ctx.bus.bumpStateVersion();
  call.emit("space.updated", { spaceId, changed: what });
}

function threadsChanged(call: Call, threadIds: readonly string[]): void {
  for (const id of threadIds) {
    const thread = getThread(call.ctx.db, id);
    if (thread !== undefined) call.emit("thread.updated", { thread }, id);
  }
}

const URL_REF = /^https?:\/\//i;

export function spacesHandlers(deps: SpaceHandlerDeps = {}): Record<string, HandlerDef> {
  const store = (call: Call) => new SpaceStore(call.ctx.db);
  const project = (id: string) => deps.projects?.()?.getEntity(id);
  /** A Keep-private project never gets a Space, whoever asks (SR10). */
  const refusePrivate = (entityId: string | null | undefined): void => {
    if (entityId != null && project(entityId)?.private === true) throw projectPrivateError();
  };

  async function automationsChanged(call: Call, ids: readonly string[]): Promise<void> {
    if (deps.automations === undefined) return;
    for (const id of ids) {
      const automation = await deps.automations.get(id);
      if (automation !== undefined) call.emit("automation.updated", { automation });
    }
  }

  async function setEnabled(call: Call, id: string, enabled: boolean): Promise<boolean> {
    if (deps.automations !== undefined) {
      try {
        await deps.automations.setEnabled(id, enabled);
        return true;
      } catch (err) {
        call.ctx.log.log("warn", "a Space could not change an automation", {
          automationId: id,
          code: PsycheError.from(err).code,
        });
        return false;
      }
    }
    const res = call.ctx.db.sqlite
      .prepare(
        `UPDATE automations SET enabled = ?, ${enabled ? "" : "next_run_at = NULL,"} updated_at = ? WHERE id = ?`,
      )
      .run(enabled ? 1 : 0, call.ctx.db.now(), id);
    return res.changes > 0;
  }

  return {
    "spaces.list": {
      run: (call: Call, p: P<"spaces.list">) => ({ spaces: store(call).list(p.archived === true) }),
    },
    "spaces.get": {
      run: (call: Call, p: P<"spaces.get">) => store(call).detail(p.spaceId),
    },
    "spaces.create": {
      transactional: true,
      run(call: Call, p: P<"spaces.create">): MethodResult<"spaces.create"> {
        refusePrivate(p.entityId);
        const space = store(call).create(p);
        changed(call, space.id, ["row"]);
        return { space };
      },
    },
    "spaces.update": {
      transactional: true,
      run(call: Call, p: P<"spaces.update">): MethodResult<"spaces.update"> {
        const { spaceId, ...patch } = p;
        refusePrivate(patch.entityId);
        const space = store(call).update(spaceId, patch);
        changed(call, spaceId, ["row"]);
        return { space };
      },
    },
    "spaces.archive": {
      async run(call: Call, p: P<"spaces.archive">): Promise<{ space: Space }> {
        const s = store(call);
        const current = s.require(p.spaceId);
        if (current.archivedAt !== null) return { space: current };
        // Its automations pause; the ones switched off here are the ones a restore switches on.
        const paused: string[] = [];
        for (const id of s.enabledAutomationIds(p.spaceId)) {
          if (await setEnabled(call, id, false)) paused.push(id);
        }
        const space = s.archive(p.spaceId, call.ctx.now().toISOString(), paused);
        changed(call, p.spaceId, ["archived"]);
        await automationsChanged(call, paused);
        return { space };
      },
    },
    "spaces.restore": {
      async run(call: Call, p: P<"spaces.restore">): Promise<{ space: Space }> {
        const s = store(call);
        const current = s.require(p.spaceId);
        if (current.archivedAt === null) return { space: current };
        const { space, paused } = s.unarchive(p.spaceId);
        const resumed: string[] = [];
        for (const id of paused) {
          // Only those still in this Space: one moved out or deleted meanwhile is left alone.
          const row = call.ctx.db.sqlite
            .prepare("SELECT space_id FROM automations WHERE id = ?")
            .get(id) as { space_id: string | null } | undefined;
          if (row?.space_id !== p.spaceId) continue;
          if (await setEnabled(call, id, true)) resumed.push(id);
        }
        changed(call, p.spaceId, ["archived"]);
        await automationsChanged(call, resumed);
        return { space };
      },
    },
    "spaces.delete": {
      transactional: true,
      run(call: Call, p: P<"spaces.delete">) {
        const threadIds = store(call).delete(p.spaceId);
        changed(call, p.spaceId, ["deleted"]);
        // The chats stay, with no Space: windows showing them re-read the row.
        threadsChanged(call, threadIds);
        return { ok: true as const };
      },
    },
    "spaces.links.add": {
      transactional: true,
      run(call: Call, p: P<"spaces.links.add">): { link: SpaceLink } {
        if (p.kind === "url" && !URL_REF.test(p.ref)) {
          throw new PsycheError("invalid_params", "a URL link must start with http:// or https://");
        }
        const link = store(call).addLink(p.spaceId, { kind: p.kind, ref: p.ref, label: p.label });
        changed(call, p.spaceId, ["links"]);
        return { link };
      },
    },
    "spaces.links.remove": {
      transactional: true,
      run(call: Call, p: P<"spaces.links.remove">) {
        store(call).removeLink(p.spaceId, p.linkId);
        changed(call, p.spaceId, ["links"]);
        return { ok: true as const };
      },
    },
    "spaces.threads.move": {
      transactional: true,
      run(call: Call, p: P<"spaces.threads.move">) {
        const target = p.spaceId ?? null;
        const { moved, from } = store(call).moveThreads(p.threadIds, target);
        // A moved chat takes effect from its next run; the counts of both Spaces change now.
        for (const id of new Set([
          ...from,
          ...(target === null || moved.length === 0 ? [] : [target]),
        ])) {
          changed(call, id, ["threads"]);
        }
        threadsChanged(call, moved);
        return { moved: moved.length };
      },
    },
    "spaces.automations.move": {
      async run(call: Call, p: P<"spaces.automations.move">) {
        const target = p.spaceId ?? null;
        const { moved, from } = call.ctx.db.sqlite.transaction(() =>
          store(call).moveAutomations(p.automationIds, target),
        )();
        for (const id of new Set([
          ...from,
          ...(target === null || moved.length === 0 ? [] : [target]),
        ])) {
          changed(call, id, ["automations"]);
        }
        await automationsChanged(call, moved);
        return { moved: moved.length };
      },
    },
    "spaces.proposals.list": {
      run: (call: Call, p: P<"spaces.proposals.list">) => ({
        // Each card shows exactly what its Create would move, and the project it would link.
        proposals: store(call)
          .proposals(p.status === "open")
          .map((proposal) => ({
            ...proposal,
            chats: proposalChats(call.ctx.db, proposal.threadIds),
            projectName:
              proposal.entityId === null
                ? null
                : (project(proposal.entityId)?.name?.slice(0, 120) ?? null),
          })),
      }),
    },
    "spaces.proposals.accept": {
      transactional: true,
      run(call: Call, p: P<"spaces.proposals.accept">): { space: Space } {
        const s = store(call);
        const proposal = s.proposal(p.proposalId);
        if (proposal.status !== "open")
          throw new PsycheError("conflict", "that proposal is already decided");
        // Checked again now: the project may have been made private since the proposal.
        refusePrivate(proposal.entityId);
        const space = s.create({
          name: p.name ?? proposal.name,
          ...(proposal.entityId === null ? {} : { entityId: proposal.entityId }),
          createdFrom: "proposal",
        });
        s.decideProposal(proposal.id, "accepted");
        // Only chats with no Space yet come in (as in migration), never main or a channel chat:
        // a chat is never taken out of another Space, private or not.
        const movable = proposalChats(call.ctx.db, proposal.threadIds).map((c) => c.id);
        const { moved } = s.moveThreads(movable, space.id);
        changed(call, space.id, ["row"]);
        threadsChanged(call, moved);
        return { space };
      },
    },
    "spaces.proposals.dismiss": {
      transactional: true,
      run(call: Call, p: P<"spaces.proposals.dismiss">) {
        store(call).decideProposal(p.proposalId, "dismissed");
        return { ok: true as const };
      },
    },
  };
}
