import type { FileEntry, LibraryItem } from "@psyche/protocol";
import {
  ChevronRight,
  File,
  FileImage,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderOpen,
  Library,
  Link2,
  Mail,
  Presentation,
} from "lucide-react";
import { type CSSProperties, type ReactElement, type ReactNode, useState } from "react";
import { EmptyState, LoadingCards } from "../../components/page.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { Button } from "../../components/ui/button.tsx";
import { useGatewayQuery, useLibrary, useSettings } from "../../data/hooks.ts";
import { formatRelative } from "../../lib/format.ts";
import { useNow } from "../../lib/use-now.ts";
import { cn } from "../../lib/utils.ts";
import { usePersona } from "../../slots.tsx";
import { formatBytes } from "../library/library-items.ts";
import { folderGrants } from "../settings/FileAccessSection.tsx";
import type { FolderGrant } from "../settings/types.ts";

/**
 * Files pane (UI design §3.7, feature P4): the folders the owner granted (ro / rw) and the
 * Library as a tree, beside a preview of the picked file. The preview is a slot: the composed
 * app renders `@psyche/viewers` there, so the kit stays free of the viewers' bundle.
 */

/** A file the pane can preview: a granted-folder path or a Library path, never both. */
export interface FileRef {
  path?: string;
  libraryPath?: string;
  name: string;
  size: number | null;
  modifiedAt: string | null;
  /** Set for Library items (quarantined downloads need "Trust this file", §3.12). */
  libraryItem?: LibraryItem;
}

export interface FilesPaneProps {
  /** A file to show first: an absolute path, as `view.open` targets the Files pane. */
  target?: string | null;
  /** Renders the preview; without it the pane names the file only (stories, tests). */
  renderViewer?: (file: FileRef) => ReactNode;
  /** Opens Settings → File access to share a folder. */
  onShareFolder?: () => void;
  now?: number;
}

/** The Files pane target for a Library item (`view.open` targets are absolute paths). */
export const libraryTarget = (item: Pick<LibraryItem, "path">): string => `library:${item.path}`;

/** What a pane target names: an absolute path, or `library:<LibraryItem.path>`. */
export function fileRefForTarget(
  target: string | null | undefined,
  library: readonly LibraryItem[],
): FileRef | null {
  if (target?.startsWith("/")) {
    return { path: target, name: basename(target), size: null, modifiedAt: null };
  }
  if (target?.startsWith("library:")) {
    const libraryPath = target.slice("library:".length);
    if (libraryPath === "") return null;
    const item = library.find((i) => i.path === libraryPath);
    return item
      ? {
          libraryPath,
          name: item.name,
          size: item.size,
          modifiedAt: item.createdAt,
          libraryItem: item,
        }
      : { libraryPath, name: basename(libraryPath), size: null, modifiedAt: null };
  }
  return null;
}

/** `/Users/ada/Documents` → `~/Documents`, for labels only. */
export function displayPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}

const basename = (path: string) => path.replace(/\/+$/, "").split("/").pop() ?? path;

/** An icon by extension: the tree's only hint of what a viewer will show. */
export function fileIcon(name: string): typeof File {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "heic", "svg", "avif"].includes(ext)) return FileImage;
  if (["xlsx", "xls", "csv", "tsv", "ods", "numbers"].includes(ext)) return FileSpreadsheet;
  if (["pptx", "ppt", "key", "odp"].includes(ext)) return Presentation;
  if (ext === "eml") return Mail;
  if (["pdf", "docx", "doc", "odt", "md", "txt", "rtf", "pages"].includes(ext)) return FileText;
  return File;
}

const indent = (depth: number): CSSProperties => ({ paddingLeft: `${0.5 + depth * 0.875}rem` });

const ROW =
  "flex w-full min-w-0 items-center gap-1.5 rounded-md py-1 pr-2 text-left text-sm hover:bg-gray-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function sameFile(a: FileRef | null, b: FileRef): boolean {
  return a !== null && a.path === b.path && a.libraryPath === b.libraryPath;
}

interface TreeProps {
  depth: number;
  selected: FileRef | null;
  onSelect: (file: FileRef) => void;
}

function FileRow({ file, depth, selected, onSelect }: TreeProps & { file: FileRef }): ReactElement {
  const Icon = fileIcon(file.name);
  const active = sameFile(selected, file);
  return (
    <li>
      <button
        type="button"
        className={cn(ROW, active && "bg-gray-4 font-medium")}
        style={indent(depth)}
        aria-current={active ? "true" : undefined}
        title={file.path ?? file.libraryPath}
        onClick={() => onSelect(file)}
      >
        <span className="size-3.5 shrink-0" aria-hidden="true" />
        <Icon className="size-4 shrink-0 text-gray-11" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{file.name}</span>
      </button>
    </li>
  );
}

function Note({ depth, children }: { depth: number; children: ReactNode }): ReactElement {
  return (
    <li className="py-1 pr-2 text-xs text-muted-foreground" style={indent(depth + 1)}>
      {children}
    </li>
  );
}

/** Skeleton rows in the tree while a folder loads (§3.0). */
function TreeLoading({ depth, label }: { depth: number; label: string }): ReactElement {
  return (
    <li style={indent(depth)} className="py-1 pr-2">
      <LoadingCards label={label} count={2} lines={1} layout="rows" />
    </li>
  );
}

function listError(error: string): string {
  return /outside every granted folder|forbidden/i.test(error)
    ? "This folder is no longer shared."
    : /does not exist|not_found/i.test(error)
      ? "This folder is gone."
      : `Psyche couldn't list this folder (${error}).`;
}

function FolderChildren({ path, depth, selected, onSelect }: TreeProps & { path: string }) {
  const q = useGatewayQuery("files.list", { path });
  if (q.loading && q.data === undefined)
    return <TreeLoading depth={depth} label="Loading the folder" />;
  if (q.error !== null && q.data === undefined) {
    return (
      <Note depth={depth - 1}>
        {listError(q.error)}{" "}
        <Button type="button" variant="link" size="xs" className="h-auto p-0" onClick={q.reload}>
          Try again
        </Button>
      </Note>
    );
  }
  const entries = q.data?.entries ?? [];
  if (entries.length === 0) return <Note depth={depth - 1}>Empty folder.</Note>;
  return (
    <>
      {entries.map((e: FileEntry) =>
        e.kind === "folder" ? (
          <FolderNode
            key={e.path}
            path={e.path}
            label={e.name}
            depth={depth}
            selected={selected}
            onSelect={onSelect}
          />
        ) : e.kind === "file" ? (
          <FileRow
            key={e.path}
            file={{
              path: e.path,
              name: e.name,
              size: e.size ?? null,
              modifiedAt: e.modifiedAt ?? null,
            }}
            depth={depth}
            selected={selected}
            onSelect={onSelect}
          />
        ) : (
          <li key={e.path}>
            <span
              className={cn(ROW, "cursor-default text-muted-foreground hover:bg-transparent")}
              style={indent(depth)}
              title="A link; Psyche doesn't follow links out of shared folders"
            >
              <span className="size-3.5 shrink-0" aria-hidden="true" />
              <Link2 className="size-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{e.name}</span>
            </span>
          </li>
        ),
      )}
      {q.data?.nextOffset != null ? (
        <Note depth={depth - 1}>Only the first {entries.length} items are shown.</Note>
      ) : null}
    </>
  );
}

function FolderNode({
  path,
  label,
  badge,
  depth,
  selected,
  onSelect,
  defaultOpen = false,
}: TreeProps & { path: string; label: string; badge?: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const Icon = open ? FolderOpen : Folder;
  return (
    <li>
      <button
        type="button"
        className={ROW}
        style={indent(depth)}
        aria-expanded={open}
        title={path}
        onClick={() => setOpen(!open)}
      >
        <ChevronRight
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
          aria-hidden="true"
        />
        <Icon className="size-4 shrink-0 text-gray-11" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {badge}
      </button>
      {open ? (
        <ul>
          <FolderChildren path={path} depth={depth + 1} selected={selected} onSelect={onSelect} />
        </ul>
      ) : null}
    </li>
  );
}

function LibraryNode({ selected, onSelect }: Omit<TreeProps, "depth">): ReactElement {
  const [open, setOpen] = useState(false);
  const lib = useLibrary();
  return (
    <li>
      <button
        type="button"
        className={ROW}
        style={indent(0)}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <ChevronRight
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
          aria-hidden="true"
        />
        <Library className="size-4 shrink-0 text-gray-11" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">Library</span>
        {lib.items.length > 0 ? (
          <span className="text-xs text-muted-foreground tabular-nums">{lib.items.length}</span>
        ) : null}
      </button>
      {open ? (
        <ul>
          {lib.loading && lib.items.length === 0 ? (
            <TreeLoading depth={1} label="Loading the Library" />
          ) : lib.error !== null && lib.items.length === 0 ? (
            <Note depth={0}>
              Psyche couldn't load the Library ({lib.error}).{" "}
              <Button
                type="button"
                variant="link"
                size="xs"
                className="h-auto p-0"
                onClick={lib.reload}
              >
                Try again
              </Button>
            </Note>
          ) : lib.items.length === 0 ? (
            <Note depth={0}>Nothing saved yet.</Note>
          ) : (
            lib.items.map((item) => (
              <FileRow
                key={item.id}
                file={{
                  libraryPath: item.path,
                  name: item.name,
                  size: item.size,
                  modifiedAt: item.createdAt,
                  libraryItem: item,
                }}
                depth={1}
                selected={selected}
                onSelect={onSelect}
              />
            ))
          )}
        </ul>
      ) : null}
    </li>
  );
}

export interface FilesPaneViewProps extends FilesPaneProps {
  grants: readonly FolderGrant[];
  loading?: boolean;
}

/** The pane from a list of grants (stories and tests pass them; the connected pane reads them). */
export function FilesPaneView({
  grants,
  loading = false,
  target,
  renderViewer,
  onShareFolder,
  now,
}: FilesPaneViewProps): ReactElement {
  const persona = usePersona();
  const clock = useNow(60_000, now);
  const lib = useLibrary();
  const [picked, setSelected] = useState<FileRef | null>(null);
  // The target until the owner picks something else; a Library target takes the item's
  // metadata from the store, so a quarantined download keeps its gate (§3.12).
  const selected = picked ?? fileRefForTarget(target, lib.items);
  return (
    <div className="@container flex h-full min-h-0 flex-col bg-background" data-testid="files-pane">
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,12rem)_minmax(0,1fr)] @lg:grid-cols-[minmax(11rem,15rem)_minmax(0,1fr)] @lg:grid-rows-1">
        <nav
          aria-label="Shared folders"
          className="min-h-0 overflow-auto border-b border-gray-6 p-1.5 @lg:border-r @lg:border-b-0"
        >
          <ul>
            {loading && grants.length === 0 ? (
              <TreeLoading depth={0} label="Loading shared folders" />
            ) : null}
            {grants.map((g, i) => (
              <FolderNode
                key={g.path}
                path={g.path}
                label={displayPath(g.path)}
                badge={
                  <Badge variant="outline" className="h-4 px-1 text-[0.625rem] uppercase">
                    {g.access}
                  </Badge>
                }
                depth={0}
                selected={selected}
                onSelect={setSelected}
                defaultOpen={i === 0}
              />
            ))}
            <LibraryNode selected={selected} onSelect={setSelected} />
          </ul>
          {!loading && grants.length === 0 ? (
            <div className="flex flex-col items-start gap-2 p-2 text-xs text-muted-foreground">
              <p>No folders are shared with {persona.name}.</p>
              {onShareFolder ? (
                <Button type="button" size="xs" onClick={onShareFolder}>
                  Share a folder
                </Button>
              ) : (
                <p>Share one in Settings → File access.</p>
              )}
            </div>
          ) : null}
        </nav>
        <section
          aria-label={selected ? `Preview of ${selected.name}` : "Preview"}
          className="flex min-h-0 min-w-0 flex-col"
        >
          {selected ? (
            <>
              <header className="flex h-10 shrink-0 items-center gap-2 border-b border-gray-6 px-3 text-sm">
                {(() => {
                  const Icon = fileIcon(selected.name);
                  return <Icon className="size-4 shrink-0 text-gray-11" aria-hidden="true" />;
                })()}
                <h3
                  className="min-w-0 flex-1 truncate font-medium"
                  title={selected.path ?? selected.libraryPath}
                >
                  {selected.name}
                </h3>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {[
                    selected.size === null ? null : formatBytes(selected.size),
                    selected.modifiedAt ? formatRelative(selected.modifiedAt, clock) : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </header>
              <div className="min-h-0 flex-1 overflow-auto" data-testid="files-preview">
                {renderViewer ? (
                  renderViewer(selected)
                ) : (
                  <p className="p-4 text-sm text-muted-foreground">
                    Previews need the desktop or web app.
                  </p>
                )}
              </div>
            </>
          ) : (
            <EmptyState icon={FileText} className="m-auto">
              Pick a file to preview it here.
            </EmptyState>
          )}
        </section>
      </div>
    </div>
  );
}

/** The connected pane: grants from `permissions.policy`, folders from `files.list`. */
export function FilesPane(props: FilesPaneProps): ReactElement {
  const settings = useSettings();
  return (
    <FilesPaneView
      {...props}
      grants={folderGrants(settings.settings).filter((g) => g.path.startsWith("/"))}
      loading={settings.loading && Object.keys(settings.settings).length === 0}
    />
  );
}
