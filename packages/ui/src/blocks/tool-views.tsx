import type { ReactElement, ReactNode } from "react";
import { t } from "../i18n/core.ts";
import { registerToolView, type ToolViewProps } from "./registry.tsx";

/**
 * Inline previews for the tools owners see most (docs/design/chat-experience-2026.md §4.7 phase
 * 4). Each reads the result the run trace kept; shapes come from the tools themselves and every
 * field is checked, because a connector may change its output. Text from the outside world is
 * drawn as plain text, never as markup or links.
 */

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const SHOWN = 6;

function List({ rows, total }: { rows: ReactNode[]; total?: number }): ReactElement {
  const more = (total ?? rows.length) - SHOWN;
  return (
    <ul className="flex flex-col gap-1">
      {rows.slice(0, SHOWN).map((r, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a static preview never reorders
        <li key={i} className="flex min-w-0 gap-2">
          {r}
        </li>
      ))}
      {more > 0 ? (
        <li className="text-label-secondary">{t("blocks.toolView.more", { count: more })}</li>
      ) : null}
    </ul>
  );
}

const Cell = ({ children, dim }: { children: ReactNode; dim?: boolean }) => (
  <span className={dim ? "shrink-0 text-label-secondary tabular-nums" : "min-w-0 truncate"}>
    {children}
  </span>
);

const Empty = (): ReactElement => (
  <p className="text-label-secondary">{t("blocks.toolView.empty")}</p>
);

function when(v: unknown): string | undefined {
  const raw = isRec(v) ? (str(v.dateTime) ?? str(v.date)) : str(v);
  if (raw === undefined) return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return /T\d/.test(raw) || !isRec(v)
    ? d.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

function CalendarEvents({ result }: ToolViewProps): ReactElement {
  const events = Array.isArray(result) ? result : arr(isRec(result) ? result.events : undefined);
  const rows = events.filter(isRec).map((e) => (
    <>
      <Cell dim>{when(e.start) ?? ""}</Cell>
      <Cell>{str(e.title) ?? str(e.summary) ?? t("blocks.toolView.untitled")}</Cell>
    </>
  ));
  return rows.length === 0 ? <Empty /> : <List rows={rows} total={events.length} />;
}

function FreeSlots({ result }: ToolViewProps): ReactElement {
  const slots = arr(isRec(result) ? result.slots : undefined).filter(isRec);
  const rows = slots.map((s) => (
    <>
      <Cell dim>{when(s.start) ?? ""}</Cell>
      <Cell>{when(s.end) ?? ""}</Cell>
    </>
  ));
  return rows.length === 0 ? <Empty /> : <List rows={rows} />;
}

function MailList({ result }: ToolViewProps): ReactElement {
  const r = isRec(result) ? result : {};
  const items = arr(r.messages ?? r.threads).filter(isRec);
  const rows = items.map((m) => (
    <>
      <Cell dim>{str(m.from)?.replace(/<.*>/, "").trim() ?? ""}</Cell>
      <Cell>{str(m.subject) ?? str(m.snippet) ?? t("blocks.toolView.untitled")}</Cell>
    </>
  ));
  return rows.length === 0 ? <Empty /> : <List rows={rows} total={items.length} />;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function WebResults({ result }: ToolViewProps): ReactElement {
  const hits = arr(isRec(result) ? result.results : undefined).filter(isRec);
  const rows = hits.map((h) => (
    <div className="flex min-w-0 flex-col" key={str(h.url) ?? str(h.title)}>
      <span className="truncate">{str(h.title) ?? str(h.url) ?? ""}</span>
      <span className="truncate text-label-secondary">{hostOf(str(h.url) ?? "")}</span>
    </div>
  ));
  return rows.length === 0 ? <Empty /> : <List rows={rows} total={hits.length} />;
}

function Snapshot({ result }: ToolViewProps): ReactElement {
  const r = isRec(result) ? result : {};
  const lines = (str(r.snapshot) ?? "").split("\n").slice(0, 8).join("\n");
  return (
    <div className="flex flex-col gap-1">
      <span className="truncate">{str(r.title) ?? str(r.url) ?? ""}</span>
      <span className="truncate text-label-secondary">{hostOf(str(r.url) ?? "")}</span>
      {lines === "" ? null : (
        <pre className="overflow-hidden font-mono text-mono whitespace-pre-wrap text-label-secondary">
          {lines}
        </pre>
      )}
    </div>
  );
}

function ListDir({ result }: ToolViewProps): ReactElement {
  const entries = arr(isRec(result) ? result.entries : undefined).filter(isRec);
  const rows = entries.map((e) => (
    <>
      <Cell dim>{e.kind === "dir" || e.kind === "directory" ? "▸" : " "}</Cell>
      <Cell>{str(e.name) ?? ""}</Cell>
    </>
  ));
  return rows.length === 0 ? <Empty /> : <List rows={rows} total={entries.length} />;
}

function FileMatches({ result }: ToolViewProps): ReactElement {
  const matches = arr(isRec(result) ? result.matches : undefined).filter(isRec);
  const rows = matches.map((m) => (
    <>
      <Cell dim>
        {str(m.path)?.split("/").at(-1) ?? ""}:{typeof m.line === "number" ? m.line : ""}
      </Cell>
      <Cell>{str(m.text)?.trim() ?? ""}</Cell>
    </>
  ));
  return rows.length === 0 ? <Empty /> : <List rows={rows} total={matches.length} />;
}

function FileText({ result }: ToolViewProps): ReactElement {
  const r = isRec(result) ? result : {};
  const text = str(r.text) ?? str(r.content) ?? (typeof result === "string" ? result : "");
  if (text === "") return <Empty />;
  return (
    <pre className="overflow-hidden font-mono text-mono whitespace-pre-wrap">
      {text.split("\n").slice(0, 10).join("\n")}
    </pre>
  );
}

let registered = false;

/** Registers the built-in previews once (the kit calls it at load). */
export function registerBuiltinToolViews(): void {
  if (registered) return;
  registered = true;
  for (const name of ["calendar_list_events"]) registerToolView(name, CalendarEvents);
  registerToolView("calendar_find_free_time", FreeSlots);
  for (const name of [
    "mail_search",
    "mail_search_messages",
    "gmail_search_threads",
    "mail_selected",
  ])
    registerToolView(name, MailList);
  for (const name of ["web.search", "web_search"]) registerToolView(name, WebResults);
  registerToolView("browser.snapshot", Snapshot);
  registerToolView("list_dir", ListDir);
  for (const name of ["search_files", "code.search"]) registerToolView(name, FileMatches);
  for (const name of ["read_file", "code.read", "browser.read_text"])
    registerToolView(name, FileText);
}

registerBuiltinToolViews();
