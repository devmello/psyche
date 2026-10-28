import { getThread, type PsycheDb, updateThread } from "@psyche/db";
import { DEFAULT_AUTO_MODE_ALLOWLIST } from "@psyche/model-router";
import {
  type ModelProvider,
  type ModelRef,
  type PermissionMode,
  PsycheError,
  type Thread,
} from "@psyche/protocol";
import type { Call, HandlerDef, ThreadModelPolicy } from "../context.ts";

/**
 * `threads.update` (composer `/model` and `/plan`, the mode and model pills; feature C9, B2).
 * Model choice is a security control (architecture §4.4, security §7.2): a thread may run in
 * `auto` only with a model on the auto-mode allowlist, so `auto` needs an explicit thread model
 * that passes `allowsAutoMode`, and picking a model that does not pass drops an `auto` thread to
 * `balanced`. The model pin goes to the router (`setThreadModel`: strict for that thread's
 * `router/primary` calls) before the row changes, so a model the router refuses (not
 * agent-capable) is never recorded.
 */

/** The Gateway's thread model policy, built from the composed provider. */
export type ModelPins = ThreadModelPolicy;

interface RouterLike {
  allowsAutoMode(ref: ModelRef): boolean;
  role(role: "primary"): { model: ModelRef } | undefined;
  setThreadModel(threadId: string, ref: ModelRef | undefined): Promise<void>;
}

function isRouterLike(p: unknown): p is RouterLike {
  const r = p as Partial<RouterLike> | null;
  return (
    typeof r?.allowsAutoMode === "function" &&
    typeof r.setThreadModel === "function" &&
    typeof r.role === "function"
  );
}

/** The router's own checks when the provider is the router, else the default allowlist. */
export function modelPinsFor(provider: ModelProvider): ModelPins {
  if (isRouterLike(provider)) {
    return {
      allowsAutoMode: (ref) => provider.allowsAutoMode(ref),
      defaultModel: () => provider.role("primary")?.model,
      setThreadModel: (threadId, ref) => provider.setThreadModel(threadId, ref),
    };
  }
  return {
    allowsAutoMode: (ref) => DEFAULT_AUTO_MODE_ALLOWLIST.some((p) => p.test(ref)),
  };
}

export function threadSettingsHandlers(pins: ModelPins): Record<string, HandlerDef> {
  return {
    "threads.update": {
      async run(
        call: Call,
        params: { threadId: string; permissionMode?: PermissionMode; modelRef?: ModelRef | null },
      ) {
        const { db } = call.ctx;
        const thread = getThread(db, params.threadId);
        if (thread === undefined) {
          throw new PsycheError("not_found", `thread ${params.threadId} not found`);
        }
        const modelRef: ModelRef | null =
          (params.modelRef === undefined ? thread.modelRef : params.modelRef) ?? null;
        // A thread without a pin runs on the router's default chat model, so Auto is judged
        // against that model rather than refused outright.
        const effectiveRef = modelRef ?? pins.defaultModel?.() ?? null;
        const autoAllowed = effectiveRef !== null && pins.allowsAutoMode(effectiveRef);
        if (params.permissionMode === "auto" && !autoAllowed) {
          throw new PsycheError(
            "forbidden",
            effectiveRef === null
              ? "Auto mode needs a model on the auto-mode allowlist. Pick one with /model first."
              : modelRef === null
                ? `${effectiveRef} is this thread's default model and is not on the auto-mode allowlist; pick an allowlisted one with /model, or use manual or balanced mode.`
                : `${effectiveRef} is not on the auto-mode allowlist; it can run this thread in manual or balanced mode.`,
          );
        }
        let permissionMode = params.permissionMode ?? thread.permissionMode;
        if (permissionMode === "auto" && !autoAllowed) permissionMode = "balanced";
        if (params.modelRef !== undefined && pins.setThreadModel !== undefined) {
          await pins.setThreadModel(thread.id, modelRef ?? undefined);
        }
        const updated = updateThread(db, thread.id, { permissionMode, modelRef }) as Thread;
        call.ctx.bus.bumpStateVersion();
        call.emit("thread.updated", { thread: updated }, updated.id);
        return { thread: updated };
      },
    },
  };
}

/** Re-applies stored thread pins to the router after a restart; a refused pin is logged. */
export async function restoreModelPins(
  db: PsycheDb,
  pins: ModelPins,
  warn: (msg: string, fields: Record<string, string>) => void,
): Promise<void> {
  if (pins.setThreadModel === undefined) return;
  const rows = db.sqlite
    .prepare("SELECT id, model_ref AS modelRef FROM threads WHERE model_ref IS NOT NULL")
    .all() as { id: string; modelRef: string }[];
  for (const row of rows) {
    try {
      await pins.setThreadModel(row.id, row.modelRef);
    } catch (err) {
      warn("stored thread model refused by the router", {
        threadId: row.id,
        code: PsycheError.from(err).code,
      });
    }
  }
}
