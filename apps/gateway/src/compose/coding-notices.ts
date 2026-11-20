import { basename } from "node:path";
import type { LaunchConfigReport } from "@psyche/agent-core";
import type { NotifyInput } from "@psyche/protocol";

/**
 * The owner's notices about `code.run` and app launch config (#1434 review r2):
 * - entries a run created were moved into the quarantine: one notice per run, whose "Keep it"
 *   puts them back (`KEEP_ACTION`);
 * - existing entries changed during a run (often the owner's own IDE or Claude Code): a notice
 *   naming them, at most one per workspace an hour, and never twice in a row for the same files;
 * - the walk fell back to the top levels, or the sandbox was made again: the same limit.
 */

/** The action prefix of "Keep it"; its argument is the quarantine id. */
export const KEEP_ACTION = "launch_config.keep";
const HOUR_MS = 3_600_000;
const MAX_LISTED = 5;

type Notify = (input: NotifyInput) => unknown;

/** At most one notice per workspace and kind an hour, and not the same files twice in a row. */
export class CodingNoticeLimiter {
  readonly #last = new Map<string, { at: number; files: string }>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  allow(root: string, kind: string, files: readonly string[] = []): boolean {
    const key = `${kind}\0${root}`;
    const set = [...files].sort().join("\0");
    const last = this.#last.get(key);
    const now = this.#now();
    if (last !== undefined && (now - last.at < HOUR_MS || (set !== "" && set === last.files))) {
      return false;
    }
    this.#last.set(key, { at: now, files: set });
    return true;
  }
}

/** `a, b, c and 2 more`, in the English fallback; clients get the list as one value. */
function listed(paths: readonly string[]): string {
  const shown = paths.slice(0, MAX_LISTED).join(", ");
  return paths.length > MAX_LISTED ? `${shown} (+${paths.length - MAX_LISTED})` : shown;
}

export function codingNotices(notify: Notify, limiter = new CodingNoticeLimiter()) {
  const send = (
    key: string,
    params: Record<string, string>,
    english: { title: string; body: string },
    extra: Partial<NotifyInput> = {},
  ) =>
    void Promise.resolve(
      notify({
        kind: "system",
        title: english.title,
        body: english.body,
        message: {
          titleKey: `notice.codeRun.${key}.title`,
          bodyKey: `notice.codeRun.${key}.body`,
          params,
        },
        ...extra,
      }),
    ).catch(() => undefined);

  return {
    report(report: LaunchConfigReport, root: string): void {
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
      if (report.changed.length > 0 && limiter.allow(root, "changed", report.changed)) {
        const paths = listed(report.changed);
        send(
          "changed",
          { repo, paths },
          {
            title: `Launch config changed during a code run in ${repo}`,
            body: `${paths} changed while a command ran in the sandbox. If that wasn't you or your editor, check it before you open the folder.`,
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
