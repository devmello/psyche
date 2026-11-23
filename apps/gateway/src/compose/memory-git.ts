import { getSetting, type PsycheDb, setSetting } from "@psyche/db";
import { validateRemoteUrl, WorkspaceGit } from "@psyche/memory";
import {
  type GitSyncConfig,
  type GitSyncResult,
  type MethodParams,
  PsycheError,
} from "@psyche/protocol";
import type { Call, HandlerDef } from "../context.ts";
import type { ComposedPart, ComposeServices } from "./services.ts";

/**
 * `memory.gitSync.*` (Settings › Data controls › Back up to git): the workspace synced to the
 * owner's own private repository through `WorkspaceGit`. Admin only. Nothing is synced until
 * the owner enables it and runs a sync, and nothing runs in the background.
 *
 * Config lives in settings (`memory.gitSync`); the last result in `memory.gitSync.last`. Expected
 * failures (no git, no remote, a rejected login, a conflict, a credential found by the secret
 * scan) come back as a result with `ok: false` and an `errorCode`, so the owner sees what
 * happened. One sync runs at a time.
 */

export const GIT_SYNC_SETTING = "memory.gitSync";
export const GIT_SYNC_LAST_SETTING = "memory.gitSync.last";

const DEFAULT_CONFIG: GitSyncConfig = { remote: "", branch: "main", enabled: false };
const BRANCH = /^[A-Za-z0-9._/-]+$/;
/** Git's wording for a refused login or host key, from its stderr (LC_ALL=C). */
const AUTH_FAILED =
  /Authentication failed|Permission denied|could not read Username|Host key verification failed|terminal prompts disabled/i;

type SyncParams = MethodParams<"memory.gitSync.set">;

export function composeMemoryGit(services: ComposeServices): ComposedPart {
  const db: PsycheDb = services.db;
  let running = false;

  const readConfig = (): GitSyncConfig => {
    const v = getSetting(db, GIT_SYNC_SETTING)?.value as Partial<GitSyncConfig> | undefined;
    return {
      remote: typeof v?.remote === "string" ? v.remote : DEFAULT_CONFIG.remote,
      branch: typeof v?.branch === "string" ? v.branch : DEFAULT_CONFIG.branch,
      enabled: v?.enabled === true,
    };
  };
  const readLast = (): GitSyncResult | null => {
    const v = getSetting(db, GIT_SYNC_LAST_SETTING)?.value as GitSyncResult | undefined;
    return v && typeof v === "object" ? v : null;
  };
  const now = () => new Date(services.clock.now()).toISOString();

  /** Maps a sync failure to a clear code; the message never carries file contents. */
  function failure(err: unknown, at: string): GitSyncResult {
    const base = { at, ok: false, committed: false, files: 0, pulled: false, pushed: false };
    if (err instanceof PsycheError) {
      if (err.code === "policy_denied") {
        const files = (err.details as { files?: unknown } | undefined)?.files;
        return {
          ...base,
          errorCode: "blocked_secret",
          blocked: Array.isArray(files) ? files.map(String) : [],
          error: "A file to back up looks like it holds a credential or card number.",
        };
      }
      if (err.message === "git is not installed") {
        return { ...base, errorCode: "no_git", error: err.message };
      }
      if (AUTH_FAILED.test(err.message)) {
        return {
          ...base,
          errorCode: "auth_failed",
          error: "The git remote refused the login. Check your SSH key or git credential helper.",
        };
      }
      if (/^git (fetch|push) /.test(err.message)) {
        return { ...base, errorCode: "remote_failed", error: err.message };
      }
      return { ...base, errorCode: "failed", error: err.message };
    }
    return { ...base, errorCode: "failed", error: "The git backup failed." };
  }

  async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (running) {
      throw new PsycheError("conflict", "A git backup is already running", { retryable: true });
    }
    running = true;
    try {
      return await fn();
    } finally {
      running = false;
    }
  }

  const handlers: Record<string, HandlerDef> = {
    "memory.gitSync.get": {
      run: () => ({ config: readConfig(), last: readLast() }),
    },
    "memory.gitSync.set": {
      run: (_call: Call, params: SyncParams) => {
        if (params.remote !== "") validateRemoteUrl(params.remote);
        if (!BRANCH.test(params.branch) || params.branch.startsWith("-")) {
          throw new PsycheError("invalid_params", "invalid branch name");
        }
        if (params.enabled && params.remote === "") {
          throw new PsycheError("invalid_params", "set a remote before turning git backup on");
        }
        const config: GitSyncConfig = {
          remote: params.remote.trim(),
          branch: params.branch,
          enabled: params.enabled,
        };
        setSetting(db, GIT_SYNC_SETTING, config);
        services.logger?.log("info", "git backup settings changed", { enabled: config.enabled });
        return config;
      },
    },
    "memory.gitSync.run": {
      run: (_call: Call) =>
        exclusive(async (): Promise<GitSyncResult> => {
          const at = now();
          let result: GitSyncResult;
          const config = readConfig();
          if (!config.enabled) {
            result = {
              at,
              ok: false,
              committed: false,
              files: 0,
              pulled: false,
              pushed: false,
              errorCode: "not_enabled",
              error: "Turn git backup on before syncing.",
            };
          } else if (config.remote === "" || services.memory === undefined) {
            result = {
              at,
              ok: false,
              committed: false,
              files: 0,
              pulled: false,
              pushed: false,
              errorCode: "no_remote",
              error: "Set a remote first.",
            };
          } else {
            try {
              const git = new WorkspaceGit(services.memory);
              await git.setRemote(config.remote);
              const r = await git.sync({ remote: "origin", branch: config.branch });
              const conflicted = (r.conflicts?.length ?? 0) > 0;
              result = {
                at,
                ok: !conflicted,
                committed: r.committed,
                ...(r.commit === undefined ? {} : { commit: r.commit }),
                files: r.files,
                pulled: r.pulled,
                pushed: r.pushed,
                ...(conflicted
                  ? {
                      conflicts: r.conflicts,
                      errorCode: "conflict" as const,
                      error: "Pulled changes conflict with this Mac's memory. Nothing was pushed.",
                    }
                  : {}),
              };
            } catch (err) {
              result = failure(err, at);
            }
          }
          setSetting(db, GIT_SYNC_LAST_SETTING, result);
          services.logger?.log(result.ok ? "info" : "warn", "git backup sync finished", {
            ok: result.ok,
            files: result.files,
            errorCode: result.errorCode ?? "none",
          });
          return result;
        }),
    },
  };

  return { handlers };
}
