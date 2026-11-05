import type { PsycheDb } from "@psyche/db";
import {
  type MethodParams,
  type MethodResult,
  type PermissionBroker,
  PsycheError,
  type Task,
} from "@psyche/protocol";
import type { Call, HandlerDef } from "../context.ts";
import type { Logger } from "../log.ts";
import type { BusySources, UpdateGate } from "../update-gate.ts";
import { DEFAULT_UPDATE_TIMEOUT_MS } from "../update-gate.ts";

/**
 * `gateway.prepareUpdate` (updates design §2.2, §2.6): the Gateway's half of "Restart to update".
 *
 * `prepare` closes the update gate (no new chat turns or tasks), waits for running turns and
 * tasks, flushes the database and answers `ready`; the desktop then boots the LaunchAgent out and
 * lets the app swap. `check` only reports what is busy, for the UI's "Restart anyway?" step.
 * `cancel` opens the gate again. If nothing follows, the gate opens by itself (`update-gate.ts`).
 */

const DEFAULT_WAIT_MS = 30_000;
const POLL_MS = 250;
const LIST_LIMIT = 20;

type Report = MethodResult<"gateway.prepareUpdate">;
type Busy = Report["busy"];

export interface UpdateHandlerDeps {
  db: PsycheDb;
  gate: UpdateGate;
  /** The task engine: tasks with a turn running (`tasks.list`'s source). */
  runningTasks: () => Promise<Pick<Task, "id" | "title">[]>;
  broker: Pick<PermissionBroker, "list">;
  busy: Pick<BusySources, "count">;
  log?: Logger;
  now?: () => number;
  /** Test hook. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The same gate as `devices.setupToken.create`: the Host's own desktop shell (loopback, no
 * Origin, the per-launch handshake secret). A paired remote device must never stop or pause the
 * Host's Gateway, even with admin.
 */
export function requireLocalDesktop(call: Call): void {
  if (
    call.identity.desktopShell !== true ||
    !call.conn.peer.remoteLoopback ||
    call.conn.peer.origin !== null
  ) {
    throw new PsycheError("forbidden", "Only Psyche on the Host itself can prepare an update");
  }
}

export function updateHandlers(deps: UpdateHandlerDeps): Record<string, HandlerDef> {
  const { db, gate } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  /** What an update would interrupt right now. */
  async function busy(): Promise<Busy> {
    const tasks = await deps.runningTasks();
    // Chat (and automation) turns. Task turns are counted as tasks, helper runs belong to the
    // run that started them, and a run parked on an approval is not running.
    const chats = db.sqlite
      .prepare(
        `SELECT id, thread_id FROM runs
         WHERE status = 'running' AND task_id IS NULL AND parent_run_id IS NULL
           AND (kind IS NULL OR kind IN ('chat', 'automation'))
         ORDER BY started_at DESC`,
      )
      .all() as { id: string; thread_id: string }[];
    const approvals = await deps.broker.list({ status: "pending" });
    return {
      runningTasks: tasks.length,
      activeChats: chats.length,
      pendingApprovals: approvals.length,
      recordings: deps.busy.count("recordings"),
      tasks: tasks.slice(0, LIST_LIMIT).map((t) => ({ id: t.id, title: t.title.slice(0, 200) })),
      chats: chats.slice(0, LIST_LIMIT).map((c) => ({ threadId: c.thread_id, runId: c.id })),
    };
  }

  async function report(b: Busy): Promise<Report> {
    const deadline = gate.deadline;
    return {
      state: gate.state,
      ready: gate.state === "ready",
      deadline: deadline === null ? null : new Date(deadline).toISOString(),
      busy: b,
      // What is still running is not stopped here (see the method's description).
      checkpointed:
        gate.state === "ready"
          ? { tasks: b.runningTasks, chats: b.activeChats }
          : { tasks: 0, chats: 0 },
    };
  }

  return {
    "gateway.prepareUpdate": {
      async run(call: Call, params: MethodParams<"gateway.prepareUpdate">): Promise<Report> {
        requireLocalDesktop(call);
        const mode = params.mode ?? "prepare";
        if (mode === "cancel") {
          if (gate.cancel()) deps.log?.log("info", "update cancelled; service resumed");
          return report(await busy());
        }
        if (mode === "check") return report(await busy());

        const timeoutMs = params.timeoutMs ?? DEFAULT_UPDATE_TIMEOUT_MS;
        const waitUntil = now() + (params.waitMs ?? DEFAULT_WAIT_MS);
        gate.close(timeoutMs);
        deps.log?.log("info", "update prepared: no new turns or tasks", { timeoutMs });
        let current = await busy();
        while (
          gate.state === "draining" &&
          current.runningTasks + current.activeChats > 0 &&
          now() < waitUntil
        ) {
          await sleep(POLL_MS);
          current = await busy();
        }
        // Cancelled, or timed out, while waiting: service has resumed, so it is not ready.
        if (gate.state === "open") return report(current);
        // Flush the write-ahead log into the main file so the files on disk are whole.
        try {
          db.sqlite.pragma("wal_checkpoint(TRUNCATE)");
        } catch {
          // Another connection holds the log; the next start replays it.
        }
        gate.markReady();
        deps.log?.log("info", "update ready", {
          runningTasks: current.runningTasks,
          activeChats: current.activeChats,
          pendingApprovals: current.pendingApprovals,
        });
        return report(current);
      },
    },
  };
}
