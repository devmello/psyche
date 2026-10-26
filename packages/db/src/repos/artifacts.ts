import type {
  Artifact,
  ArtifactAuthor,
  ArtifactOp,
  ArtifactTableView,
  ArtifactVersion,
} from "@psyche/protocol";
import { and, asc, desc, eq, gt, lte, sql } from "drizzle-orm";
import type { PsycheDb } from "../open.ts";
import {
  type ArtifactRow,
  type ArtifactVersionRow,
  artifacts,
  artifactVersions,
} from "../schema.ts";

/**
 * Canvas artifacts and their versions (chat-experience-2026 §4.4; migration
 * 202610262200_gateway_artifacts). The Gateway's artifact store applies ops and decides when to
 * snapshot; this module only reads and writes rows. Nothing here deletes.
 */

/** An artifact row with its latest content (the store's working shape). */
export interface StoredArtifact {
  artifact: Artifact;
  content: string;
  view: ArtifactTableView | null;
}

export interface NewArtifact {
  id?: string;
  libraryItemId: string;
  type: Artifact["type"];
  title: string;
  nameSlug: string;
  language?: string | null;
  threadId?: string | null;
  untrusted?: boolean;
  content: string;
  bytes: number;
  hash: string;
  createdAt?: string;
}

export interface NewArtifactVersion {
  artifactId: string;
  version: number;
  author: ArtifactAuthor;
  /** Present when this version stores the full content. */
  snapshot?: string | null;
  ops?: readonly ArtifactOp[] | null;
  view?: ArtifactTableView | null;
  bytes: number;
  hash: string;
  summary: string;
  runId?: string | null;
  toolCallId?: string | null;
  restoredFrom?: number | null;
  createdAt?: string;
}

/** A stored version with what it takes to rebuild content. */
export interface StoredArtifactVersion {
  version: ArtifactVersion;
  snapshot: string | null;
  view: ArtifactTableView | null;
}

export function artifactFromRow(row: ArtifactRow): Artifact {
  const a: Artifact = {
    id: row.id,
    libraryItemId: row.libraryItemId,
    type: row.type as Artifact["type"],
    title: row.title,
    version: row.version,
    nameSlug: row.nameSlug,
    sourceRef: null,
    updatedAt: row.updatedAt,
    threadId: row.threadId,
    bytes: row.bytes,
  };
  if (row.language !== null) a.language = row.language;
  if (row.untrusted === 1) a.untrusted = true;
  return a;
}

function storedFromRow(row: ArtifactRow): StoredArtifact {
  return {
    artifact: artifactFromRow(row),
    content: row.content,
    view: row.view === null ? null : (JSON.parse(row.view) as ArtifactTableView),
  };
}

export function artifactVersionFromRow(row: ArtifactVersionRow): StoredArtifactVersion {
  const version: ArtifactVersion = {
    artifactId: row.artifactId,
    version: row.version,
    author: row.author as ArtifactAuthor,
    kind: row.kind as ArtifactVersion["kind"],
    bytes: row.bytes,
    hash: row.hash,
    summary: row.summary,
    runId: row.runId,
    toolCallId: row.toolCallId,
    createdAt: row.createdAt,
  };
  if (row.ops !== null) version.ops = JSON.parse(row.ops) as ArtifactOp[];
  if (row.restoredFrom !== null) version.restoredFrom = row.restoredFrom;
  return {
    version,
    snapshot: row.snapshot,
    view: row.view === null ? null : (JSON.parse(row.view) as ArtifactTableView),
  };
}

/** Inserts an artifact at version 1 together with its snapshot version. */
export function insertArtifact(
  db: PsycheDb,
  input: NewArtifact,
  first: Omit<NewArtifactVersion, "artifactId" | "version" | "snapshot" | "bytes" | "hash">,
): StoredArtifact {
  return db.sqlite.transaction(() => {
    const now = input.createdAt ?? db.now();
    const row = db.drizzle
      .insert(artifacts)
      .values({
        id: input.id ?? db.newId(),
        libraryItemId: input.libraryItemId,
        type: input.type,
        title: input.title,
        nameSlug: input.nameSlug,
        language: input.language ?? null,
        threadId: input.threadId ?? null,
        untrusted: input.untrusted === true ? 1 : 0,
        version: 1,
        content: input.content,
        view: null,
        bytes: input.bytes,
        hash: input.hash,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    insertArtifactVersion(db, {
      ...first,
      artifactId: row.id,
      version: 1,
      snapshot: input.content,
      bytes: input.bytes,
      hash: input.hash,
      createdAt: now,
    });
    return storedFromRow(row);
  })();
}

export function insertArtifactVersion(db: PsycheDb, v: NewArtifactVersion): StoredArtifactVersion {
  const row = db.drizzle
    .insert(artifactVersions)
    .values({
      artifactId: v.artifactId,
      version: v.version,
      author: v.author,
      kind: v.snapshot == null ? "ops" : "snapshot",
      ops: v.ops == null ? null : JSON.stringify(v.ops),
      snapshot: v.snapshot ?? null,
      view: v.view == null ? null : JSON.stringify(v.view),
      bytes: v.bytes,
      hash: v.hash,
      summary: v.summary,
      runId: v.runId ?? null,
      toolCallId: v.toolCallId ?? null,
      restoredFrom: v.restoredFrom ?? null,
      createdAt: v.createdAt ?? db.now(),
    })
    .returning()
    .get();
  return artifactVersionFromRow(row);
}

/**
 * Writes version `version.version` and moves the artifact's head to it, in one transaction.
 * Returns null (and writes nothing) when the head is no longer `base`: a concurrent writer won.
 */
export function appendArtifactVersion(
  db: PsycheDb,
  base: number,
  head: { content: string; view: ArtifactTableView | null; title?: string },
  version: NewArtifactVersion,
): StoredArtifact | null {
  return db.sqlite.transaction(() => {
    const now = version.createdAt ?? db.now();
    const row = db.drizzle
      .update(artifacts)
      .set({
        version: version.version,
        content: head.content,
        view: head.view === null ? null : JSON.stringify(head.view),
        bytes: version.bytes,
        hash: version.hash,
        updatedAt: now,
        ...(head.title === undefined ? {} : { title: head.title }),
      })
      .where(and(eq(artifacts.id, version.artifactId), eq(artifacts.version, base)))
      .returning()
      .get();
    if (row === undefined) return null;
    insertArtifactVersion(db, { ...version, createdAt: now });
    return storedFromRow(row);
  })();
}

export function getArtifact(db: PsycheDb, id: string): StoredArtifact | null {
  const row = db.drizzle.select().from(artifacts).where(eq(artifacts.id, id)).get();
  return row === undefined ? null : storedFromRow(row);
}

export function listArtifactsPage(
  db: PsycheDb,
  options: { threadId?: string; offset?: number; limit?: number } = {},
): { items: Artifact[]; hasMore: boolean } {
  const limit = options.limit ?? 50;
  const rows = db.drizzle
    .select()
    .from(artifacts)
    .where(options.threadId === undefined ? undefined : eq(artifacts.threadId, options.threadId))
    .orderBy(desc(artifacts.updatedAt), desc(artifacts.id))
    .limit(limit + 1)
    .offset(options.offset ?? 0)
    .all();
  return { items: rows.slice(0, limit).map(artifactFromRow), hasMore: rows.length > limit };
}

/** Every version of an artifact, oldest first (`after` skips versions ≤ it). */
export function listArtifactVersions(
  db: PsycheDb,
  artifactId: string,
  after = 0,
): StoredArtifactVersion[] {
  return db.drizzle
    .select()
    .from(artifactVersions)
    .where(and(eq(artifactVersions.artifactId, artifactId), gt(artifactVersions.version, after)))
    .orderBy(asc(artifactVersions.version))
    .all()
    .map(artifactVersionFromRow);
}

/**
 * The versions needed to rebuild `version`: the nearest snapshot at or below it, then every
 * version after that snapshot up to `version`, oldest first. Empty when the version is unknown.
 */
export function artifactVersionChain(
  db: PsycheDb,
  artifactId: string,
  version: number,
): StoredArtifactVersion[] {
  const snap = db.drizzle
    .select({ v: sql<number>`max(${artifactVersions.version})` })
    .from(artifactVersions)
    .where(
      and(
        eq(artifactVersions.artifactId, artifactId),
        eq(artifactVersions.kind, "snapshot"),
        lte(artifactVersions.version, version),
      ),
    )
    .get();
  if (snap?.v == null) return [];
  return db.drizzle
    .select()
    .from(artifactVersions)
    .where(
      and(
        eq(artifactVersions.artifactId, artifactId),
        sql`${artifactVersions.version} BETWEEN ${snap.v} AND ${version}`,
      ),
    )
    .orderBy(asc(artifactVersions.version))
    .all()
    .map(artifactVersionFromRow);
}
