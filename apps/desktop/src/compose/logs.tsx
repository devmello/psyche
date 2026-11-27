import type { LogLevel, LogLine } from "@psyche/protocol";
import { activeI18n, t, useGatewayQuery } from "@psyche/ui";
import { type ReactElement, useId, useState } from "react";
import { isUnavailableMessage } from "./backups.tsx";

/**
 * In-app log viewer (feature U5; docs/06 §3.18 About → logs): `logs.tail` with level,
 * subsystem and search filters. Lines are the Gateway's structured logs, metadata only; a
 * failed tool call shows its code, tool and ids in the fields disclosure.
 */

const LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];
const LEVEL_TONE: Record<LogLevel, string> = {
  debug: "text-gray-11",
  info: "text-info-text",
  warn: "text-approval-text",
  error: "text-danger-text",
};

export interface LogFilter {
  level: LogLevel;
  subsystem: string;
  search: string;
  lines: number;
}

export const DEFAULT_FILTER: LogFilter = { level: "info", subsystem: "", search: "", lines: 200 };

/** The `logs.tail` params for a filter (empty strings mean "no filter"). */
export function tailParams(f: LogFilter): {
  lines: number;
  level: LogLevel;
  subsystem?: string;
  search?: string;
} {
  return {
    lines: f.lines,
    level: f.level,
    ...(f.subsystem ? { subsystem: f.subsystem } : {}),
    ...(f.search.trim() ? { search: f.search.trim() } : {}),
  };
}

/** One line as text, for copying. */
export function lineText(l: LogLine): string {
  const fields = l.fields && Object.keys(l.fields).length > 0 ? ` ${JSON.stringify(l.fields)}` : "";
  return `${l.ts} ${l.level.toUpperCase()}${l.subsystem ? ` [${l.subsystem}]` : ""} ${l.msg}${fields}`;
}

/** Stable React keys: the line's text, numbered when the same line repeats. */
function keyed(lines: readonly LogLine[]): { key: string; line: LogLine }[] {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    const text = lineText(line);
    const n = seen.get(text) ?? 0;
    seen.set(text, n + 1);
    return { key: n === 0 ? text : `${text}#${n}`, line };
  });
}

const select = "h-8 rounded-md border border-input bg-background px-2 text-sm";

export function LogViewer({
  defaultFilter = DEFAULT_FILTER,
}: {
  defaultFilter?: LogFilter;
}): ReactElement {
  const id = useId();
  const [filter, setFilter] = useState<LogFilter>(defaultFilter);
  const [applied, setApplied] = useState<LogFilter>(defaultFilter);
  const q = useGatewayQuery("logs.tail", tailParams(applied));
  const unavailable = isUnavailableMessage(q.error);
  const lines = q.data?.lines ?? [];
  const subsystems = q.data?.subsystems ?? [];

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex min-h-0 flex-col gap-3 rounded-lg border border-gray-6 bg-gray-2 p-4 text-sm"
      data-testid="settings-logs"
    >
      <div>
        <h3 id={`${id}-title`} className="text-base font-semibold text-foreground">
          {t("web.logs.title")}
        </h3>
        <p className="text-muted-foreground">
          {t("web.logs.description")} <code>psyche logs</code>.
        </p>
      </div>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(filter);
          if (JSON.stringify(filter) === JSON.stringify(applied)) q.reload();
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium">{t("web.logs.level")}</span>
          <select
            className={select}
            value={filter.level}
            onChange={(e) => setFilter({ ...filter, level: e.target.value as LogLevel })}
          >
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {t("web.logs.levelAndAbove", { level: l })}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium">{t("web.logs.subsystem")}</span>
          <select
            className={select}
            value={filter.subsystem}
            onChange={(e) => setFilter({ ...filter, subsystem: e.target.value })}
          >
            <option value="">{t("web.logs.allSubsystems")}</option>
            {subsystems.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium">{t("web.logs.search")}</span>
          <input
            className={select}
            value={filter.search}
            placeholder={t("web.logs.searchPlaceholder")}
            onChange={(e) => setFilter({ ...filter, search: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium">{t("web.logs.lines")}</span>
          <select
            className={select}
            value={filter.lines}
            onChange={(e) => setFilter({ ...filter, lines: Number(e.target.value) })}
          >
            {[100, 200, 500, 1000].map((n) => (
              <option key={n} value={n}>
                {activeI18n().number(n)}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="inline-flex h-8 items-center rounded-md border border-input bg-background px-3 font-medium shadow-xs hover:bg-gray-3"
        >
          {q.loading ? t("common.loading") : t("web.logs.refresh")}
        </button>
      </form>
      {unavailable ? (
        <p role="status" className="text-approval-text">
          {t("web.logs.needsGateway")} <code>psyche logs -n 200</code>.
        </p>
      ) : q.error !== null ? (
        <p role="alert" className="text-danger-text">
          {t("web.logs.loadError", { error: q.error })}
        </p>
      ) : lines.length === 0 ? (
        <p className="rounded-lg border border-dashed border-gray-6 p-3 text-muted-foreground">
          {q.loading ? t("common.loading") : t("web.logs.empty")}
        </p>
      ) : (
        <ol
          className="flex max-h-[60vh] flex-col gap-0.5 overflow-auto font-mono text-xs"
          aria-label={t("web.logs.linesLabel")}
        >
          {q.data?.truncated ? (
            <li className="text-muted-foreground">{t("web.logs.truncated")}</li>
          ) : null}
          {keyed(lines).map(({ key, line: l }) => (
            <li key={key} className="flex flex-wrap items-baseline gap-2">
              <span className="text-muted-foreground">{l.ts}</span>
              <span className={`w-12 font-semibold uppercase ${LEVEL_TONE[l.level]}`}>
                {l.level}
              </span>
              {l.subsystem ? <span className="text-gray-11">[{l.subsystem}]</span> : null}
              <span className="text-foreground">{l.msg}</span>
              {l.fields && Object.keys(l.fields).length > 0 ? (
                <details className="min-w-0 basis-full">
                  <summary className="cursor-pointer text-muted-foreground">
                    {Object.entries(l.fields)
                      .slice(0, 4)
                      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
                      .join(" ")}
                  </summary>
                  <pre className="overflow-auto whitespace-pre-wrap">
                    {JSON.stringify(l.fields, null, 2)}
                  </pre>
                </details>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
