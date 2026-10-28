import { sanitizeDisplay } from "@psyche/permissions/cards";
import type { ReactElement, ReactNode } from "react";
import { t } from "../i18n/core.ts";

export interface ReportSourceView {
  n: number;
  url: string;
  title: string;
  kind: "web" | "local";
}

export interface ReportView {
  title: string;
  summary: string;
  sections: { heading: string; body: string }[];
  openQuestions: string[];
  sources: ReportSourceView[];
}

/** `[1]` and `[1, 3]` become links to the sources list; a number with no source stays text. */
export function withCitations(text: string, sources: readonly ReportSourceView[]): ReactNode[] {
  const known = new Set(sources.map((s) => s.n));
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
    const at = m.index ?? 0;
    out.push(text.slice(last, at));
    const nums = (m[1] ?? "").split(",").map((x) => Number(x.trim()));
    out.push(
      <sup key={`c${key++}`} className="text-footnote">
        [
        {nums.map((n, i) => (
          <span key={n}>
            {i > 0 ? ", " : ""}
            {known.has(n) ? (
              <a
                href={`#source-${n}`}
                aria-label={t("research.report.cite", { n })}
                className="text-accent"
              >
                {n}
              </a>
            ) : (
              n
            )}
          </span>
        ))}
        ]
      </sup>,
    );
    last = at + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

/**
 * The research report with inline numbered citations that link to the sources list. Built from
 * third-party pages, so the text is sanitized for display and a notice says to treat it as
 * information. A section's "Dig deeper" continues the run with the sources already read.
 */
export function ResearchReport({
  report,
  onDigDeeper,
  onAsk,
}: {
  report: ReportView;
  onDigDeeper?: (sectionIndex: number) => void;
  onAsk?: () => void;
}): ReactElement {
  const clean = (s: string) => sanitizeDisplay(s, 8_000);
  return (
    <article aria-label={t("research.report.title")} className="space-y-4 text-reading">
      <h2 className="text-title text-label-primary">{clean(report.title)}</h2>
      <p className="text-footnote text-label-secondary">{t("research.report.untrusted")}</p>
      <section>
        <h3 className="text-headline text-label-primary">{t("research.report.summary")}</h3>
        <p>{withCitations(clean(report.summary), report.sources)}</p>
      </section>
      {report.sections.map((s, i) => (
        <section key={s.heading}>
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="text-headline text-label-primary">{clean(s.heading)}</h3>
            {onDigDeeper ? (
              <button
                type="button"
                className="text-footnote text-accent"
                aria-label={t("research.report.digDeeperLabel", { section: s.heading })}
                onClick={() => onDigDeeper(i)}
              >
                {t("research.report.digDeeper")}
              </button>
            ) : null}
          </div>
          <p>{withCitations(clean(s.body), report.sources)}</p>
        </section>
      ))}
      {report.openQuestions.length > 0 ? (
        <section>
          <h3 className="text-headline text-label-primary">{t("research.report.openQuestions")}</h3>
          <ul className="list-disc pl-5">
            {report.openQuestions.map((q) => (
              <li key={q}>{clean(q)}</li>
            ))}
          </ul>
        </section>
      ) : null}
      <section>
        <h3 className="text-headline text-label-primary">{t("research.report.sources")}</h3>
        <ol className="space-y-0.5 text-footnote">
          {report.sources.map((s) => (
            <li key={s.n} id={`source-${s.n}`} value={s.n}>
              {s.kind === "web" ? (
                <a href={s.url} rel="noreferrer noopener" target="_blank" className="text-accent">
                  {clean(s.title || s.url)}
                </a>
              ) : (
                <span>
                  {clean(s.title)} ({t("research.report.local")})
                </span>
              )}
            </li>
          ))}
        </ol>
      </section>
      {onAsk ? (
        <button type="button" className="text-footnote text-accent" onClick={onAsk}>
          {t("research.report.ask")}
        </button>
      ) : null}
    </article>
  );
}
