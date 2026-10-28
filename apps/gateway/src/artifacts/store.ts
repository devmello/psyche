import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  appendArtifactVersion,
  artifactVersionChain,
  findArtifactMessageId,
  getArtifact,
  getLibraryItem,
  insertArtifact,
  listArtifactsPage,
  listArtifactVersions,
  type PsycheDb,
  type StoredArtifact,
  setArtifactMessageId,
  upsertLibraryItemByPath,
} from "@psyche/db";
import {
  type Artifact,
  type ArtifactAuthor,
  type ArtifactConflict,
  type ArtifactOp,
  type ArtifactRef,
  type ArtifactTableView,
  type ArtifactVersion,
  PsycheError,
} from "@psyche/protocol";
import { libraryRoot } from "../compose/library.ts";
import {
  applyOps,
  isChartType,
  isDocumentType,
  isMapType,
  isTableType,
  isTextType,
  normalizeContent,
  summarize,
} from "./ops.ts";

/**
 * The Gateway's artifact version store (docs/design/chat-experience-2026.md §4.4): every version
 * kept, ops between snapshots, a snapshot every `SNAPSHOT_EVERY` versions or whenever the ops are
 * large next to the content. Optimistic concurrency on `base`. The latest content is mirrored to
 * the Library (`artifacts/<id>/<slug>.<ext>`, kind `artifact`) so it is a file like any other.
 */

export const SNAPSHOT_EVERY = 10;
/** Content above this many bytes is refused (tool calls and canvas edits alike). */
export const MAX_ARTIFACT_BYTES = 2_000_000;

export interface WriteTrace {
  author: ArtifactAuthor;
  runId?: string | null;
  toolCallId?: string | null;
}

export interface ArtifactWrite {
  artifact: Artifact;
  ref: ArtifactRef;
  conflict?: ArtifactConflict;
  /** The version written (absent on conflict). */
  version?: ArtifactVersion;
  /** Rewrites among the ops (watched: patches should dominate). */
  rewrites: number;
}

export interface ArtifactStoreDeps {
  db: PsycheDb;
  home: string;
  publish?: (artifact: Artifact, version: ArtifactVersion) => void;
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const bytesOf = (s: string): number => Buffer.byteLength(s, "utf8");

const EXT: Partial<Record<Artifact["type"], string>> = {
  doc: "md",
  markdown: "md",
  code: "txt",
  table: "json",
  sheet: "json",
  html: "html",
  chart: "json",
  map: "json",
  diagram: "mmd",
  diff: "patch",
  slides: "deck.json",
  workbook: "book.json",
};
const MIME: Partial<Record<Artifact["type"], string>> = {
  doc: "text/markdown",
  markdown: "text/markdown",
  code: "text/plain",
  table: "application/json",
  sheet: "application/json",
  html: "text/html",
  chart: "application/json",
  map: "application/json",
  diagram: "text/plain",
  diff: "text/x-diff",
  slides: "application/json",
  workbook: "application/json",
};

export function slugify(title: string): string {
  const s = title
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 60);
  return s === "" ? "artifact" : s;
}

export const refOf = (a: Artifact, hash: string, summary: string): ArtifactRef => ({
  artifactId: a.id,
  version: a.version,
  type: a.type,
  title: a.title,
  bytes: a.bytes ?? 0,
  hash,
  summary,
});

export interface CreateInput {
  type: Artifact["type"];
  title: string;
  content: string;
  language?: string;
  threadId?: string | null;
  untrusted?: boolean;
}

export class ArtifactStore {
  readonly #d: ArtifactStoreDeps;

  constructor(deps: ArtifactStoreDeps) {
    this.#d = deps;
  }

  get(id: string): StoredArtifact {
    const a = getArtifact(this.#d.db, id);
    if (a === null) throw new PsycheError("not_found", `no artifact ${id}`);
    return a;
  }

  list(options: { threadId?: string; offset?: number; limit?: number }) {
    return listArtifactsPage(this.#d.db, options);
  }

  /**
   * `artifact` with its origin message filled in. The message is committed after the artifact is
   * created, so it is found (and remembered) on a later read; this also backfills older rows.
   */
  withOrigin(artifact: Artifact): Artifact {
    if (artifact.messageId != null || artifact.threadId == null) return artifact;
    const messageId = findArtifactMessageId(this.#d.db, artifact);
    if (messageId === null) return artifact;
    setArtifactMessageId(this.#d.db, artifact.id, messageId);
    return { ...artifact, messageId };
  }

  versions(id: string): ArtifactVersion[] {
    this.get(id);
    return listArtifactVersions(this.#d.db, id).map((v) => v.version);
  }

  async create(input: CreateInput, trace: WriteTrace): Promise<ArtifactWrite> {
    const { db } = this.#d;
    let content: string;
    let libraryItemId: string;
    const id = db.newId();
    const slug = slugify(input.title);
    if (input.type === "image") {
      // An image artifact names a Library item that already holds the picture.
      const item = getLibraryItem(db, input.content);
      if (item == null || !item.mime.startsWith("image/"))
        throw new PsycheError("invalid_params", "image content must be a Library image item id");
      content = item.id;
      libraryItemId = item.id;
    } else if (
      isTextType(input.type) ||
      isTableType(input.type) ||
      isChartType(input.type) ||
      isDocumentType(input.type) ||
      isMapType(input.type)
    ) {
      content = normalizeContent(input.type, input.content);
      libraryItemId = await this.#mirror(id, slug, input.type, content, input.threadId ?? null);
    } else {
      throw new PsycheError(
        "invalid_params",
        `artifacts of type ${input.type} are not created here`,
      );
    }
    this.#checkSize(content);
    const summary = summarize(input.type, content);
    const stored = insertArtifact(
      db,
      {
        id,
        libraryItemId,
        type: input.type,
        title: input.title,
        nameSlug: slug,
        language: input.language ?? null,
        threadId: input.threadId ?? null,
        runId: trace.runId ?? null,
        untrusted: input.untrusted === true,
        content,
        bytes: bytesOf(content),
        hash: sha(content),
      },
      {
        author: trace.author,
        summary,
        runId: trace.runId ?? null,
        toolCallId: trace.toolCallId ?? null,
      },
    );
    const [first] = listArtifactVersions(db, id);
    const version = first?.version as ArtifactVersion;
    this.#d.publish?.(stored.artifact, version);
    return {
      artifact: stored.artifact,
      ref: refOf(stored.artifact, version.hash, summary),
      version,
      rewrites: 0,
    };
  }

  /** Applies ops on `base`; a stale base returns the conflict and writes nothing. */
  async update(
    id: string,
    base: number,
    ops: readonly ArtifactOp[],
    trace: WriteTrace,
    options: { untrusted?: boolean } = {},
  ): Promise<ArtifactWrite> {
    const head = this.get(id);
    if (base !== head.artifact.version) return this.#conflict(head, base);
    const applied = applyOps(head.artifact.type, head.content, head.view, ops);
    return this.#append(head, applied.content, applied.view, ops, trace, {
      rewrites: applied.rewrites,
      ...(options.untrusted === true ? { untrusted: true } : {}),
    });
  }

  /** Writes an old version's content as a new latest version (history is never rewritten). */
  async restore(id: string, version: number, trace: WriteTrace): Promise<ArtifactWrite> {
    const head = this.get(id);
    const old = this.contentAt(id, version);
    return this.#append(head, old.content, old.view, undefined, trace, {
      rewrites: 0,
      restoredFrom: version,
    });
  }

  /** Content (and table view) at a version: the nearest snapshot plus the ops after it. */
  contentAt(
    id: string,
    version?: number,
  ): { content: string; view: ArtifactTableView | null; version: number } {
    const head = this.get(id);
    const v = version ?? head.artifact.version;
    if (v === head.artifact.version) return { content: head.content, view: head.view, version: v };
    if (v < 1 || v > head.artifact.version)
      throw new PsycheError("not_found", `artifact ${id} has no version ${v}`);
    const chain = artifactVersionChain(this.#d.db, id, v);
    const [snap, ...rest] = chain;
    if (snap?.snapshot == null)
      throw new PsycheError("internal", `artifact ${id} lost its snapshot`);
    let content = snap.snapshot;
    let view = snap.view;
    for (const step of rest) {
      if (step.snapshot !== null) {
        content = step.snapshot;
        view = step.view;
      } else if (step.version.ops !== undefined) {
        const applied = applyOps(head.artifact.type, content, view, step.version.ops);
        content = applied.content;
        view = applied.view;
      }
    }
    return { content, view, version: v };
  }

  #conflict(head: StoredArtifact, base: number): ArtifactWrite {
    if (base > head.artifact.version || base < 1)
      throw new PsycheError("invalid_params", `base ${base} is not a version of this artifact`);
    const missed = listArtifactVersions(this.#d.db, head.artifact.id, base).map((v) => v.version);
    const last = missed.at(-1);
    return {
      artifact: head.artifact,
      ref: refOf(head.artifact, last?.hash ?? sha(head.content), last?.summary ?? ""),
      conflict: { base, latest: head.artifact.version, missed },
      rewrites: 0,
    };
  }

  async #append(
    head: StoredArtifact,
    content: string,
    view: ArtifactTableView | null,
    ops: readonly ArtifactOp[] | undefined,
    trace: WriteTrace,
    extra: { rewrites: number; restoredFrom?: number; untrusted?: boolean },
  ): Promise<ArtifactWrite> {
    this.#checkSize(content);
    const a = head.artifact;
    const next = a.version + 1;
    const lastSnapshot = artifactVersionChain(this.#d.db, a.id, a.version)[0]?.version.version ?? 0;
    const opsBytes = ops === undefined ? Number.POSITIVE_INFINITY : bytesOf(JSON.stringify(ops));
    const snapshot =
      ops === undefined ||
      extra.rewrites > 0 ||
      next - lastSnapshot >= SNAPSHOT_EVERY ||
      opsBytes > bytesOf(content) / 2;
    const summary = summarize(a.type, content, ops, head.content);
    const hash = sha(content);
    const stored = appendArtifactVersion(
      this.#d.db,
      a.version,
      { content, view },
      {
        artifactId: a.id,
        version: next,
        author: trace.author,
        snapshot: snapshot ? content : null,
        ops: ops ?? null,
        view,
        bytes: bytesOf(content),
        hash,
        summary,
        runId: trace.runId ?? null,
        toolCallId: trace.toolCallId ?? null,
        restoredFrom: extra.restoredFrom ?? null,
      },
    );
    // Lost a race between our read and the write: report it like any stale base.
    if (stored === null) return this.#conflict(this.get(a.id), a.version);
    if (extra.untrusted === true && stored.artifact.untrusted !== true) {
      this.#d.db.sqlite.prepare("UPDATE artifacts SET untrusted = 1 WHERE id = ?").run(a.id);
      stored.artifact.untrusted = true;
    }
    if (a.type !== "image")
      await this.#mirror(a.id, a.nameSlug, a.type, content, a.threadId ?? null).catch(
        () => undefined,
      );
    const version = listArtifactVersions(this.#d.db, a.id, a.version)[0]
      ?.version as ArtifactVersion;
    this.#d.publish?.(stored.artifact, version);
    return {
      artifact: stored.artifact,
      ref: refOf(stored.artifact, hash, summary),
      version,
      rewrites: extra.rewrites,
    };
  }

  #checkSize(content: string): void {
    if (bytesOf(content) > MAX_ARTIFACT_BYTES)
      throw new PsycheError(
        "invalid_params",
        `artifact content is over ${MAX_ARTIFACT_BYTES} bytes`,
      );
  }

  /** Writes the latest content to the Library and returns its item id. */
  async #mirror(
    id: string,
    slug: string,
    type: Artifact["type"],
    content: string,
    threadId: string | null,
  ): Promise<string> {
    const path = `artifacts/${id}/${slug}.${EXT[type] ?? "txt"}`;
    const abs = join(libraryRoot(this.#d.home), path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
    const item = upsertLibraryItemByPath(this.#d.db, {
      kind: "artifact",
      name: `${slug}.${EXT[type] ?? "txt"}`,
      mime: MIME[type] ?? "text/plain",
      path,
      size: bytesOf(content),
      sha256: `sha256:${sha(content)}`,
      origin: "agent",
      threadId,
    });
    return item.id;
  }
}
