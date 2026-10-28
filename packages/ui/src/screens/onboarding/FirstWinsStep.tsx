import { type ReactElement, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { t } from "../../i18n/core.ts";
import { tk } from "../../i18n/dynamic.ts";
import { describeError } from "../../i18n/errors.ts";
import { runnableWins, WIN_IDS, type WinId } from "./capabilities.ts";

type WinState =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "done"; text: string }
  | { phase: "error"; reason: string };

/**
 * First wins: up to three starter tasks run live with what is connected. A task whose connector
 * is missing says what to connect instead of failing; the others still run.
 */
export function FirstWinsStep({
  connected,
  onRun,
}: {
  connected: ReadonlySet<string>;
  onRun?: ((win: WinId) => Promise<string>) | undefined;
}): ReactElement {
  const can = runnableWins(connected);
  const [state, setState] = useState<Partial<Record<WinId, WinState>>>({});
  const set = (win: WinId, next: WinState) => setState((s) => ({ ...s, [win]: next }));
  const run = async (win: WinId) => {
    if (!onRun) return;
    set(win, { phase: "running" });
    try {
      set(win, { phase: "done", text: await onRun(win) });
    } catch (err) {
      set(win, { phase: "error", reason: describeError(err) });
    }
  };
  const runAll = async () => {
    for (const win of WIN_IDS) if (can[win] && state[win]?.phase !== "done") await run(win);
  };
  const anyRunnable = WIN_IDS.some((w) => can[w]);
  return (
    <div className="flex flex-col gap-4" data-testid="onboarding-wins">
      <p className="text-reading text-label-secondary">{t("onboarding.wins.lead")}</p>
      <ul className="flex flex-col gap-3" aria-label={t("onboarding.wins.list")}>
        {WIN_IDS.map((win) => {
          const s = state[win] ?? { phase: "idle" };
          return (
            <li
              key={win}
              className="flex flex-col gap-2 rounded-lg bg-fill-quaternary p-4"
              data-win={win}
            >
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-headline text-label-primary">{tk(`onboarding.wins.${win}`)}</p>
                  <p className="text-callout text-label-secondary">
                    {can[win]
                      ? tk(`onboarding.wins.${win}Hint`)
                      : tk(`onboarding.wins.${win}Missing`)}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="plain"
                  disabled={!can[win] || !onRun || s.phase === "running"}
                  onClick={() => void run(win)}
                >
                  {s.phase === "running"
                    ? t("onboarding.wins.running")
                    : s.phase === "done"
                      ? t("onboarding.wins.again")
                      : t("onboarding.wins.run")}
                </Button>
              </div>
              {s.phase === "done" ? (
                <p className="whitespace-pre-wrap text-body text-label-primary" role="status">
                  {s.text}
                </p>
              ) : null}
              {s.phase === "error" ? (
                <p role="alert" className="text-callout text-danger-text">
                  {t("onboarding.wins.failed", { reason: s.reason })}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      {anyRunnable && onRun ? (
        <Button type="button" size="lg" onClick={() => void runAll()}>
          {t("onboarding.wins.runAll")}
        </Button>
      ) : (
        <p className="text-callout text-label-secondary">{t("onboarding.wins.none")}</p>
      )}
    </div>
  );
}
