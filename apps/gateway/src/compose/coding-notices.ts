import { basename, join } from "node:path";
import type { LaunchConfigReport } from "@psyche/agent-core";
import type { NotifyInput } from "@psyche/protocol";

/**
 * The owner's notices about `code.run` and app launch config (#1434 review r2, #1435 review r1):
 * - entries a run created were moved into the quarantine: one notice per run, whose "Keep it"
 *   puts them back (`KEEP_ACTION`);
 * - existing entries changed during a run: one notice per workspace that keeps every changed
 *   path, updated in place (and shown again) only when a path or what it holds is new. None is
 *   ever dropped: for a launch-config file the sandbox can write, this notice is the only guard.
 *   A path that could not be moved joins it too. A path it never listed before alerts again (a
 *   new notice, so a new banner), not only an unread mark;
 * - what could not be moved is still in place and not held: its own notice too, every run;
 * - a move brought in something other than what was checked (a folder swapped for a link): its
 *   own notice, naming where it is held, with Keep it;
 * - the walk fell back to the top levels, or the sandbox was made again: informational, at most
 *   one per workspace an hour.
 */

/** The action prefix of "Keep it"; its argument is the quarantine id. */
export const KEEP_ACTION = "launch_config.keep";
const HOUR_MS = 3_600_000;
const MAX_LISTED = 5;
/** Paths one workspace's change notice remembers at most (the oldest go first). */
const MAX_REMEMBERED = 500;

type Notify = (input: NotifyInput) => Promise<{ id: string } | undefined> | unknown;

/** Informational notices: at most one per workspace and kind an hour. */
export class CodingNoticeLimiter {
  readonly #last = new Map<string, number>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  allow(root: string, kind: string): boolean {
    const key = `${kind}\0${root}`;
    const last = this.#last.get(key);
    const now = this.#now();
    if (last !== undefined && now - last < HOUR_MS) return false;
    this.#last.set(key, now);
    return true;
  }
}

/** `a, b, c (+2)` in the English fallback; clients get the list as one value. */
function listed(paths: readonly string[]): string {
  const shown = paths.slice(0, MAX_LISTED).join(", ");
  return paths.length > MAX_LISTED ? `${shown} (+${paths.length - MAX_LISTED})` : shown;
}

/** The id of the notification `notify` answered with, when it says. */
async function idOf(sent: unknown): Promise<string | undefined> {
  try {
    const n = (await sent) as { id?: unknown } | undefined;
    return typeof n?.id === "string" ? n.id : undefined;
  } catch {
    return undefined;
  }
}

export interface CodingNoticeOptions {
  /** Closes a notice, so the next one with its key is new and alerts again. */
  resolve?: (id: string) => Promise<unknown> | unknown;
  /** Where held entries are (`$PSYCHE_HOME/quarantine/code-run`), named in the incident notice. */
  quarantineDir?: string;
  limiter?: CodingNoticeLimiter;
}

export function codingNotices(notify: Notify, options: CodingNoticeOptions = {}) {
  const limiter = options.limiter ?? new CodingNoticeLimiter();
  const message = (key: string, params: Record<string, string>) => ({
    titleKey: `notice.codeRun.${key}.title`,
    bodyKey: `notice.codeRun.${key}.body`,
    params,
  });
  const send = (
    key: string,
    params: Record<string, string>,
    english: { title: string; body: string },
    extra: Partial<NotifyInput> = {},
  ): unknown => {
    try {
      const sent = notify({
        kind: "system",
        title: english.title,
        body: english.body,
        message: message(key, params),
        ...extra,
      });
      void Promise.resolve(sent).catch(() => undefined);
      return sent;
    } catch {
      return undefined;
    }
  };

  /** Per workspace: the open change notice and the paths (with what they held) it lists. */
  const changes = new Map<string, { id?: string; seen: Map<string, string> }>();
  let queue: Promise<void> = Promise.resolve();
  const changedNotice = async (root: string, fresh: Map<string, string>) => {
    const repo = basename(root);
    const state = changes.get(root) ?? { seen: new Map<string, string>() };
    changes.set(root, state);
    const sendAll = (paths: readonly string[]) => {
      const list = listed(paths);
      return send(
        "changed",
        { repo, paths: list },
        {
          title: `Launch config changed during a code run in ${repo}`,
          body: `${list} changed while a command ran in the sandbox. If that wasn't you or your editor, check it before you open the folder.`,
        },
        { dedupeKey: `code-run-changed:${root}` },
      );
    };
    // A path this notice never listed: close it, so the next is a new one and alerts again.
    const newPath = [...fresh.keys()].some((p) => !state.seen.has(p));
    if (newPath && state.id !== undefined && options.resolve !== undefined) {
      try {
        await options.resolve(state.id);
      } catch {
        // Already closed or gone: the next notify makes a new one all the same.
      }
      state.id = undefined;
    }
    for (const [path, print] of fresh) {
      state.seen.delete(path);
      state.seen.set(path, print);
    }
    while (state.seen.size > MAX_REMEMBERED) {
      state.seen.delete(state.seen.keys().next().value as string);
    }
    const id = await idOf(sendAll([...state.seen.keys()].reverse()));
    if (id !== undefined && state.id !== undefined && id !== state.id) {
      // The owner closed the last one, so this is a new notice: it lists only what is new.
      state.seen = new Map(fresh);
      await idOf(sendAll([...fresh.keys()]));
    }
    if (id !== undefined) state.id = id;
  };

  return {
    report(report: LaunchConfigReport, root: string): Promise<void> {
      const repo = basename(root);
      if (report.quarantined.length > 0 && report.quarantineId !== undefined) {
        const paths = listed(report.quarantined);
        send(
          "held",
          { repo, paths },
          {
            title: `Psyche held back launch config from a code run in ${repo}`,
            body: `A command in the sandbox created ${paths}. Apps or your next command could run code from it, so Psyche moved it aside without deleting it. If you or your tools made it, tap Keep it.`,
          },
          {
            actions: [
              {
                id: `${KEEP_ACTION}:${report.quarantineId}`,
                label: "Keep it",
                labelKey: "notice.action.keepIt",
              },
            ],
            dedupeKey: `code-run-held:${report.quarantineId}`,
          },
        );
      }
      // Every changed path with what it holds now, and what could not be moved.
      const now = new Map<string, string>([
        ...report.changed.map((p) => [p, report.fingerprints[p] ?? "changed"] as const),
        ...report.unmoved.map((p) => [p, "unmoved"] as const),
      ]);
      if (now.size > 0) {
        queue = queue.then(() => {
          const seen = changes.get(root)?.seen;
          const fresh = new Map([...now].filter(([p, print]) => seen?.get(p) !== print));
          return fresh.size > 0 ? changedNotice(root, fresh) : undefined;
        });
      }
      // Launch config still in place, not held: its own notice, new every run, so it alerts.
      if (report.unmoved.length > 0) {
        const paths = listed(report.unmoved);
        send(
          "unmoved",
          { repo, paths },
          {
            title: `Launch config from a code run in ${repo} is still in place`,
            body: `A command in the sandbox created ${paths}, and Psyche could not move it aside, so it is not held. Apps or your next command could run code from it. Check it, or delete it, before you open the folder or run anything there.`,
          },
        );
      }
      if (report.incidents.length > 0 && report.quarantineId !== undefined) {
        const paths = listed(report.incidents);
        const place =
          options.quarantineDir === undefined
            ? report.quarantineId
            : join(options.quarantineDir, report.quarantineId);
        send(
          "incident",
          { repo, paths, place },
          {
            title: `Psyche held back something that may not be from a code run in ${repo}`,
            body: `While ${paths} was moved aside, a folder on its way changed, so what was moved may come from somewhere else. It is kept in ${place}. Look at it before you tap Keep it, which puts it at ${paths} in ${repo}.`,
          },
          {
            actions: [
              {
                id: `${KEEP_ACTION}:${report.quarantineId}`,
                label: "Keep it",
                labelKey: "notice.action.keepIt",
              },
            ],
            dedupeKey: `code-run-incident:${report.quarantineId}`,
          },
        );
      }
      if (report.partial && limiter.allow(root, "partial")) {
        send(
          "partial",
          { repo },
          {
            title: `${repo} is too large to check fully`,
            body: "Psyche checked only the top folders for launch config that code runs create.",
          },
        );
      }
      return queue;
    },
    recreated(root: string): void {
      const repo = basename(root);
      if (!limiter.allow(root, "recreated")) return;
      send(
        "recreated",
        { repo },
        {
          title: `The sandbox for ${repo} was set up again`,
          body: "Its read-only folders changed, so running servers and anything installed outside the repository are gone. Start again what you need.",
        },
      );
    },
  };
}
