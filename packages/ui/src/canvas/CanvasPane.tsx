import type {
  Artifact,
  ArtifactCell,
  ArtifactChart,
  ArtifactOp,
  ArtifactTable,
} from "@psyche/protocol";
import {
  ChartColumn,
  Code2,
  Copy,
  Download,
  FileText,
  GitCompare,
  Globe,
  Image as ImageIcon,
  Map as MapIcon,
  Network,
  Pencil,
  ShieldAlert,
  Table as TableIcon,
} from "lucide-react";
import * as m from "motion/react-m";
import { type ReactElement, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { DiffBlock } from "../blocks/DiffBlock.tsx";
import { Markdown } from "../blocks/Markdown.tsx";
import { Button } from "../components/ui/button.tsx";
import { NativeSelect } from "../components/ui/native-select.tsx";
import { Textarea } from "../components/ui/textarea.tsx";
import {
  type ArtifactContent,
  useArtifact,
  useArtifactActions,
  useArtifactContent,
  useArtifactVersions,
  useLibraryItem,
  useStoreState,
  useThreadArtifacts,
} from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import {
  cellFromInput,
  columnName,
  diffToOps,
  setCellOp,
  tableToCsv,
  viewRows,
} from "../lib/artifact-ops.ts";
import { useCopy } from "../lib/clipboard.ts";
import { formatTime } from "../lib/format.ts";
import { cn } from "../lib/utils.ts";
import { MapPanel } from "../map/MapPanel.tsx";
import { parseMapContent } from "../map/map-model.ts";
import { AgentGlow, Disclosure, fade } from "../motion/index.ts";
import { useSlots } from "../slots.tsx";
import { CanvasSkeleton } from "./CanvasSkeleton.tsx";
import { ChartView } from "./ChartView.tsx";

/**
 * The output canvas (docs/design/chat-experience-2026.md §4.2): one artifact at a time with the
 * thread's recents as tabs, a version picker, Copy, Download and Edit. The kit draws docs, code,
 * tables and images itself; a host can swap a body for a `packages/viewers` renderer through the
 * `renderArtifact` slot. Edits become the smallest op (`diffToOps`, a cell `set`) and a new
 * version authored by the user; an old version is read-only with "Restore as new version".
 */

const TYPE_ICON: Partial<Record<Artifact["type"], typeof FileText>> = {
  doc: FileText,
  markdown: FileText,
  code: Code2,
  table: TableIcon,
  sheet: TableIcon,
  image: ImageIcon,
  chart: ChartColumn,
  map: MapIcon,
  diagram: Network,
  diff: GitCompare,
  html: Globe,
};
const EDITABLE = new Set<Artifact["type"]>(["doc", "markdown", "code", "table", "diagram", "html"]);
const MAX_TABS = 5;

/** What a host renderer gets to draw an artifact body. */
export interface ArtifactRenderProps {
  artifact: Artifact;
  content: ArtifactContent;
  editing: boolean;
  /** Text types: the edited text (committed on Save). */
  onChange: (text: string) => void;
}

export interface CanvasPaneProps {
  artifactId: string;
  /** The thread whose artifacts are the recents tabs. */
  threadId: string | null;
  /** Switches the pane to another artifact (a recents tab). */
  onSelect?: (artifact: Artifact) => void;
}

const fileName = (a: Artifact): string =>
  `${a.nameSlug}.${a.type === "table" || a.type === "sheet" ? "csv" : a.type === "chart" || a.type === "map" ? "json" : a.type === "diagram" ? "mmd" : a.type === "diff" ? "patch" : a.type === "html" ? "html" : a.type === "code" ? (a.language ?? "txt") : "md"}`;

function asTable(content: ArtifactContent): ArtifactTable | null {
  try {
    return JSON.parse(content.content) as ArtifactTable;
  } catch {
    return null;
  }
}

/** The text Copy and Download give: CSV for tables, the source for the rest. */
function plainText(content: ArtifactContent): string {
  const table = content.type === "table" || content.type === "sheet" ? asTable(content) : null;
  return table === null ? content.content : tableToCsv(table);
}

export function CanvasPane({ artifactId, threadId, onSelect }: CanvasPaneProps): ReactElement {
  const { artifact, loading } = useArtifact(artifactId);
  const [picked, setPicked] = useState<number | null>(null);
  // A new latest version (the agent's next edit) moves the pane forward unless one was picked.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the artifact changes
  useEffect(() => setPicked(null), [artifactId]);
  const version = picked ?? artifact?.version ?? null;
  const { content, error } = useArtifactContent(artifact === null ? null : artifactId, version);
  const latest = artifact !== null && version === artifact.version;
  // The agent is working on this thread: the pane it may be editing glows.
  const agentActing = useStoreState(
    (s) =>
      threadId !== null &&
      Object.values(s.runs).some((r) => r.threadId === threadId && r.status === "running"),
  );

  // Switching artifacts keeps the previous one on screen, dimmed, until the next arrives
  // (smoothness-2026 §4: no blank "Loading" in between). With nothing before it: the skeleton.
  const last = useRef<{ artifact: Artifact; content: ArtifactContent | null } | null>(null);
  if (artifact !== null) last.current = { artifact, content };
  const stale = artifact === null && loading ? last.current : null;

  return (
    <section
      aria-label={t("canvas.label", { title: artifact?.title ?? "" })}
      className="relative flex h-full min-h-0 flex-col bg-background"
      data-testid="canvas-pane"
    >
      <AgentGlow active={agentActing} />
      <RecentsTabs threadId={threadId} activeId={artifactId} onSelect={onSelect} />
      {artifact === null ? (
        stale !== null ? (
          <div
            className="flex min-h-0 flex-1 flex-col opacity-60 transition-opacity duration-(--duration-short) ease-(--ease-standard)"
            aria-busy="true"
            inert
            data-testid="canvas-stale"
          >
            <CanvasBody
              key={stale.artifact.id}
              artifact={stale.artifact}
              content={stale.content}
              latest
              version={stale.artifact.version}
              onPick={() => {}}
              error={null}
            />
          </div>
        ) : loading ? (
          <div className="p-4">
            <CanvasSkeleton />
          </div>
        ) : (
          <p className="p-4 text-callout text-label-secondary" role="status">
            {t("canvas.missing")}
          </p>
        )
      ) : (
        <CanvasBody
          key={artifact.id}
          artifact={artifact}
          content={content}
          latest={latest}
          version={version ?? artifact.version}
          onPick={(v) => setPicked(v === artifact.version ? null : v)}
          error={error}
        />
      )}
    </section>
  );
}

function RecentsTabs({
  threadId,
  activeId,
  onSelect,
}: {
  threadId: string | null;
  activeId: string;
  onSelect?: ((artifact: Artifact) => void) | undefined;
}): ReactElement | null {
  const { artifacts } = useThreadArtifacts(threadId);
  const tabs = artifacts.slice(0, MAX_TABS);
  if (tabs.length < 2 || onSelect === undefined) return null;
  return (
    <div
      role="tablist"
      aria-label={t("canvas.recents")}
      className="flex shrink-0 gap-1 overflow-x-auto border-b border-separator px-2 pt-2"
    >
      {tabs.map((a) => {
        const Icon = TYPE_ICON[a.type] ?? FileText;
        const active = a.id === activeId;
        return (
          <button
            key={a.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(a)}
            className={cn(
              "inline-flex max-w-48 shrink-0 items-center gap-1.5 rounded-t-md px-2.5 py-1.5 text-callout outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active
                ? "bg-fill-secondary text-label-primary"
                : "text-label-secondary hover:bg-fill-tertiary",
            )}
          >
            <Icon className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{a.title}</span>
          </button>
        );
      })}
    </div>
  );
}

function CanvasBody({
  artifact,
  content,
  latest,
  version,
  onPick,
  error,
}: {
  artifact: Artifact;
  content: ArtifactContent | null;
  latest: boolean;
  version: number;
  onPick: (version: number) => void;
  error: string | null;
}): ReactElement {
  const slots = useSlots();
  const actions = useArtifactActions();
  const { state: copyState, copy } = useCopy();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [allowed, setAllowed] = useState(false);
  const Icon = TYPE_ICON[artifact.type] ?? FileText;
  const table = artifact.type === "table" || artifact.type === "sheet";
  const canEdit = latest && EDITABLE.has(artifact.type) && content !== null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new version ends an edit
  useEffect(() => {
    setEditing(false);
    setDraft(null);
  }, [artifact.id, version]);
  // Run is per artifact and per version: a new version from an untrusted source is off again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on the artifact and version
  useEffect(() => setAllowed(false), [artifact.id, version]);

  const commit = async (ops: ArtifactOp[]) => {
    if (ops.length === 0) return true;
    setSaving(true);
    setNotice(null);
    try {
      const res = await actions.update(artifact.id, version, ops);
      if (res.conflict !== undefined) {
        setNotice(t("canvas.conflict"));
        return false;
      }
      return true;
    } catch (e) {
      setNotice(t("canvas.saveFailed", { message: describeError(e) }));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    if (content === null || draft === null) return setEditing(false);
    if (await commit(diffToOps(content.content, draft))) {
      setEditing(false);
      setDraft(null);
    }
  };

  const download = () => {
    if (content === null) return;
    const url = URL.createObjectURL(new Blob([plainText(content)], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName(artifact);
    a.click();
    URL.revokeObjectURL(url);
  };

  // HTML runs only in the host's sandbox, and stays off for content from untrusted sources until
  // the owner presses Run (docs/design/chat-experience-2026.md §4.6, decision 5).
  const html = artifact.type === "html";
  const gated = html && artifact.untrusted === true && !allowed;
  const bodyKey = content === null ? "pending" : "loaded";
  const shownBody = useRef<string | null>(null);
  useEffect(() => {
    shownBody.current = bodyKey;
  });
  const custom: ReactNode =
    content === null || gated || (html && editing)
      ? undefined
      : slots.renderArtifact?.({
          artifact,
          content,
          editing,
          onChange: setDraft,
        });

  return (
    <>
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-separator px-4 py-2">
        <Icon className="size-4 shrink-0 text-label-secondary" aria-hidden="true" />
        <h2 className="min-w-0 flex-1 truncate text-headline">{artifact.title}</h2>
        {artifact.untrusted === true ? (
          <span className="inline-flex items-center gap-1 text-callout text-approval-text">
            <ShieldAlert className="size-3.5" aria-hidden="true" />
            {t("canvas.untrusted")}
          </span>
        ) : null}
        <VersionPicker artifact={artifact} version={version} onPick={onPick} />
        <Button
          size="sm"
          variant="ghost"
          disabled={content === null}
          onClick={() => content !== null && void copy(plainText(content))}
          aria-label={copyState === "copied" ? t("canvas.copied") : t("canvas.copy")}
        >
          <Copy aria-hidden="true" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={content === null}
          onClick={download}
          aria-label={t("canvas.download")}
        >
          <Download aria-hidden="true" />
        </Button>
        {canEdit && !table ? (
          editing ? (
            <>
              <Button size="sm" variant="secondary" onClick={() => setEditing(false)}>
                {t("common.cancel")}
              </Button>
              <Button size="sm" disabled={saving} onClick={() => void save()}>
                {t("common.save")}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setDraft(content?.content ?? "");
                setEditing(true);
              }}
            >
              <Pencil aria-hidden="true" /> {t("common.edit")}
            </Button>
          )
        ) : null}
        {!latest ? (
          <Button
            size="sm"
            onClick={() =>
              void actions.restore(artifact.id, version).then(
                () => onPick(artifact.version + 1),
                (e: unknown) => setNotice(t("canvas.saveFailed", { message: describeError(e) })),
              )
            }
          >
            {t("canvas.restore")}
          </Button>
        ) : null}
      </header>
      {/* The notices open and close with height + opacity, so the body does not jump (C5). */}
      <Disclosure open={notice !== null} className="shrink-0">
        <p role="alert" className="px-4 py-2 text-callout text-danger-text">
          {notice}
        </p>
      </Disclosure>
      <Disclosure open={!latest} className="shrink-0">
        <p className="px-4 pt-2 text-callout text-label-secondary">
          {t("canvas.oldVersion", { version })}
        </p>
      </Disclosure>
      {/* Skeleton → content, and version → version, crossfade in the same box (150 ms). */}
      <m.div
        key={bodyKey}
        initial={shownBody.current !== null && shownBody.current !== bodyKey ? fade.initial : false}
        animate={fade.animate}
        className="min-h-0 flex-1 overflow-auto p-4"
      >
        {content === null ? (
          error !== null && error !== undefined ? (
            <p className="text-callout text-label-secondary" role="status">
              {error}
            </p>
          ) : (
            <CanvasSkeleton />
          )
        ) : custom !== undefined && custom !== null ? (
          custom
        ) : table ? (
          <TableBody
            content={content}
            editable={canEdit}
            onSet={(row, col, value) => void commit([setCellOp(row, col, value)])}
          />
        ) : artifact.type === "image" ? (
          <ImageBody itemId={content.content} />
        ) : artifact.type === "chart" ? (
          <ChartBody content={content} />
        ) : artifact.type === "map" ? (
          <MapBody content={content} />
        ) : artifact.type === "diff" ? (
          <DiffBlock diff={content.content} maxLines={2000} />
        ) : editing ? (
          artifact.type !== "code" && slots.renderEditor ? (
            slots.renderEditor({
              path: fileName(artifact),
              value: draft ?? content.content,
              onChange: setDraft,
            })
          ) : (
            <Textarea
              aria-label={artifact.title}
              className="h-full min-h-80 font-mono text-mono"
              value={draft ?? content.content}
              onChange={(e) => setDraft(e.target.value)}
            />
          )
        ) : html && !editing ? (
          <HtmlBody
            gated={gated}
            source={content.content}
            hasPreview={slots.renderArtifact !== undefined}
            onRun={() => setAllowed(true)}
          />
        ) : artifact.type === "code" || artifact.type === "diagram" ? (
          <pre className="overflow-x-auto font-mono text-mono text-label-primary">
            <code>{content.content}</code>
          </pre>
        ) : (
          // Lists hang their markers outside the text column: inset the body so they show.
          <div className="ps-4">
            <Markdown>{content.content}</Markdown>
          </div>
        )}
      </m.div>
    </>
  );
}

function VersionPicker({
  artifact,
  version,
  onPick,
}: {
  artifact: Artifact;
  version: number;
  onPick: (version: number) => void;
}): ReactElement {
  const { versions } = useArtifactVersions(artifact.id);
  const list = useMemo(
    () =>
      versions.length > 0
        ? [...versions].reverse()
        : [
            {
              version: artifact.version,
              author: "agent" as const,
              createdAt: artifact.updatedAt,
            },
          ],
    [versions, artifact.version, artifact.updatedAt],
  );
  return (
    <NativeSelect
      size="sm"
      aria-label={t("canvas.version")}
      value={String(version)}
      onChange={(e) => onPick(Number(e.target.value))}
    >
      {list.map((v) => (
        <option key={v.version} value={v.version}>
          {t("canvas.versionOption", {
            version: v.version,
            author: v.author,
            time: formatTime(v.createdAt),
          })}
        </option>
      ))}
    </NativeSelect>
  );
}

function display(v: ArtifactCell | undefined): string {
  return v === null || v === undefined ? "" : String(v);
}

function TableBody({
  content,
  editable,
  onSet,
}: {
  content: ArtifactContent;
  editable: boolean;
  onSet: (row: number, col: number, value: ArtifactCell) => void;
}): ReactElement {
  const table = asTable(content);
  const [cell, setCell] = useState<{ row: number; col: number; text: string } | null>(null);
  if (table === null) return <pre className="font-mono text-mono">{content.content}</pre>;
  const rows = viewRows(table, content.view);
  const done = (keep: boolean) => {
    if (keep && cell !== null) {
      const before = display(table.rows[cell.row]?.[cell.col]);
      if (before !== cell.text) onSet(cell.row, cell.col, cellFromInput(cell.text));
    }
    setCell(null);
  };
  return (
    <table className="w-full border-collapse text-body tabular-nums">
      <thead>
        <tr>
          {table.columns.map((c, i) => (
            <th
              key={`${c}-${columnName(i)}`}
              scope="col"
              className="sticky top-0 border-b border-separator bg-background px-2 py-1 text-start text-callout font-semibold text-label-secondary"
            >
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.index} className="border-b border-separator">
            {table.columns.map((c, col) => {
              const active = cell !== null && cell.row === r.index && cell.col === col;
              return (
                <td
                  key={`${c}-${columnName(col)}`}
                  className={cn(
                    "px-2 py-1",
                    typeof r.cells[col] === "number" && "text-end",
                    editable && "cursor-text hover:bg-fill-tertiary",
                  )}
                  onDoubleClick={
                    editable
                      ? () => setCell({ row: r.index, col, text: display(r.cells[col]) })
                      : undefined
                  }
                >
                  {active ? (
                    <input
                      // biome-ignore lint/a11y/noAutofocus: the cell the user just opened
                      autoFocus
                      aria-label={`${c} ${r.index + 1}`}
                      className="w-full bg-transparent outline-none ring-2 ring-ring"
                      value={cell.text}
                      onChange={(e) => setCell({ ...cell, text: e.target.value })}
                      onBlur={() => done(true)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") done(true);
                        if (e.key === "Escape") done(false);
                      }}
                    />
                  ) : (
                    display(r.cells[col])
                  )}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** An HTML artifact with no live preview: off for untrusted sources, source otherwise. */
function HtmlBody({
  gated,
  source,
  hasPreview,
  onRun,
}: {
  gated: boolean;
  source: string;
  hasPreview: boolean;
  onRun: () => void;
}): ReactElement {
  return (
    <div className="flex flex-col gap-3">
      {gated ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-fill-quaternary p-3 text-callout">
          <ShieldAlert className="size-4 shrink-0 text-approval-text" aria-hidden="true" />
          <p className="min-w-0 flex-1 text-label-primary">{t("canvas.htmlOff")}</p>
          <Button size="sm" onClick={onRun}>
            {t("canvas.htmlRun")}
          </Button>
        </div>
      ) : hasPreview ? null : (
        <p className="text-callout text-label-secondary">{t("canvas.htmlNoPreview")}</p>
      )}
      <pre className="overflow-x-auto font-mono text-mono text-label-primary">
        <code>{source}</code>
      </pre>
    </div>
  );
}

function ChartBody({ content }: { content: ArtifactContent }): ReactElement {
  let chart: ArtifactChart | null = null;
  try {
    chart = JSON.parse(content.content) as ArtifactChart;
  } catch {
    // A malformed spec shows its text below.
  }
  if (chart === null || !Array.isArray(chart.series) || !Array.isArray(chart.categories))
    return <pre className="font-mono text-mono">{content.content}</pre>;
  return <ChartView chart={chart} />;
}

function MapBody({ content }: { content: ArtifactContent }): ReactElement {
  const map = parseMapContent(content.content);
  if (map === null) return <pre className="font-mono text-mono">{content.content}</pre>;
  return <MapPanel map={map} variant="full" />;
}

function ImageBody({ itemId }: { itemId: string }): ReactElement {
  const { item } = useLibraryItem(itemId);
  const { renderPreview } = useSlots();
  if (item === null)
    return <p className="text-callout text-label-secondary">{t("canvas.loading")}</p>;
  return <>{renderPreview?.({ item, kind: "file" }) ?? <p className="text-body">{item.name}</p>}</>;
}
