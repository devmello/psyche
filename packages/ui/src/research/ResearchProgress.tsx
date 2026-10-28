import { sanitizeDisplay } from "@psyche/permissions/cards";
import { Check, CircleAlert, Loader2, Square } from "lucide-react";
import type { ReactElement } from "react";
import { t } from "../i18n/core.ts";
import type { ResearchStepId, ResearchView } from "./model.ts";

const STEPS: readonly ResearchStepId[] = [
  "plan",
  "read",
  "extract",
  "crosscheck",
  "synthesize",
  "save",
];

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/**
 * Live progress of a deep-research run: the plan, the step in progress, the sources read and the
 * token use against the estimate. Stoppable at any time. Source titles are third-party text, so
 * they go through the display sanitizer.
 */
export function ResearchProgress({
  view,
  onStop,
  onOpenReport,
}: {
  view: ResearchView;
  onStop?: () => void;
  onOpenReport?: (artifactId: string) => void;
}): ReactElement {
  const running = view.status === "running";
  const at = view.step === null ? -1 : STEPS.indexOf(view.step);
  const read = view.sources.filter((s) => s.status === "read").length;
  return (
    <section
      aria-label={t("research.progress.label")}
      data-testid="research-progress"
      className="rounded-2xl bg-fill-quaternary p-4"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-headline text-label-primary">{t("research.progress.title")}</h3>
        {running && onStop ? (
          <button
            type="button"
            onClick={onStop}
            className="inline-flex items-center gap-1.5 rounded-full bg-fill-tertiary px-3 py-1 text-footnote text-label-primary"
          >
            <Square className="size-3" aria-hidden />
            {t("research.progress.stop")}
          </button>
        ) : null}
      </div>

      {view.includeLocal ? (
        <p className="mt-1 text-footnote text-label-secondary">{t("research.progress.local")}</p>
      ) : null}

      {view.questions.length > 0 ? (
        <section className="mt-3" aria-label={t("research.progress.plan")}>
          <ol className="list-decimal space-y-0.5 pl-5 text-reading text-label-primary">
            {view.questions.map((q) => (
              <li key={q}>{sanitizeDisplay(q, 300)}</li>
            ))}
          </ol>
        </section>
      ) : null}

      <ol className="mt-3 space-y-1" aria-label={t("research.progress.label")}>
        {STEPS.map((s, i) => {
          const state =
            view.status === "done" || i < at ? "done" : i === at && running ? "active" : "todo";
          return (
            <li
              key={s}
              data-state={state}
              className="flex items-center gap-2 text-footnote text-label-secondary data-[state=active]:text-label-primary"
              aria-current={state === "active" ? "step" : undefined}
            >
              {state === "done" ? (
                <Check className="size-3.5" aria-hidden />
              ) : state === "active" ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <span className="size-3.5" aria-hidden />
              )}
              {t(`research.step.${s}`)}
            </li>
          );
        })}
      </ol>

      {view.sources.length > 0 ? (
        <section className="mt-3" aria-label={t("research.progress.sourcesHeading")}>
          <p className="text-footnote text-label-secondary">
            {t("research.progress.sources", { n: read })} ·{" "}
            {t("research.progress.claims", { n: view.claims })}
          </p>
          <ul className="mt-1 space-y-0.5">
            {view.sources.map((s) => (
              <li key={s.url} className="flex items-center gap-2 text-footnote">
                <span className="text-label-tertiary">
                  {t(`research.progress.source.${s.status}`)}
                </span>
                <span className="truncate text-label-primary">
                  {sanitizeDisplay(s.title || hostOf(s.url), 120)}
                </span>
                <span className="truncate text-label-tertiary">{hostOf(s.url)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="mt-3 text-footnote text-label-secondary">
        {view.status === "done"
          ? t("research.progress.tokensActual", {
              used: view.tokens,
              estimate: view.estimatedTokens,
            })
          : t("research.progress.tokens", { used: view.tokens, estimate: view.estimatedTokens })}
      </p>

      {view.status === "stopped" ? (
        <p className="mt-2 flex items-center gap-1.5 text-footnote text-label-secondary">
          <CircleAlert className="size-3.5" aria-hidden />
          {t("research.progress.stopped")}
        </p>
      ) : null}
      {view.status === "done" && view.artifactId !== null && onOpenReport ? (
        <button
          type="button"
          className="mt-2 rounded-full bg-accent px-3 py-1 text-footnote text-white"
          onClick={() => onOpenReport(view.artifactId as string)}
        >
          {t("research.progress.openReport")}
        </button>
      ) : null}
    </section>
  );
}
