import { Artifact, ArtifactVersion } from "@psyche/protocol";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  appendArtifactVersion,
  artifactVersionChain,
  getArtifact,
  insertArtifact,
  listArtifactsPage,
  listArtifactVersions,
} from "../src/index.ts";
import { memoryDb } from "./helpers.ts";

const create = (db: ReturnType<typeof memoryDb>, threadId: string | null = "thr_1") =>
  insertArtifact(
    db,
    {
      libraryItemId: "lib_1",
      type: "doc",
      title: "Plan",
      nameSlug: "plan",
      threadId,
      content: "hello",
      bytes: 5,
      hash: "h1",
    },
    { author: "agent", summary: "5 bytes", runId: "run_1", toolCallId: "tc_1" },
  );

describe("artifacts", () => {
  it("creates version 1 as a snapshot and round-trips protocol shapes", () => {
    const db = memoryDb();
    const a = create(db);
    expect(Value.Check(Artifact, a.artifact)).toBe(true);
    expect(a.artifact.version).toBe(1);
    const [v1] = listArtifactVersions(db, a.artifact.id);
    expect(v1?.snapshot).toBe("hello");
    expect(Value.Check(ArtifactVersion, v1?.version)).toBe(true);
    expect(v1?.version).toMatchObject({ kind: "snapshot", author: "agent", runId: "run_1" });
  });

  it("appends versions only on the expected base and rebuilds chains from snapshots", () => {
    const db = memoryDb();
    const { artifact } = create(db);
    const ops = [{ op: "replace" as const, old: "hello", new: "hi" }];
    const v2 = appendArtifactVersion(
      db,
      1,
      { content: "hi", view: null },
      {
        artifactId: artifact.id,
        version: 2,
        author: "user",
        ops,
        bytes: 2,
        hash: "h2",
        summary: "1 replace",
      },
    );
    expect(v2?.artifact.version).toBe(2);
    expect(v2?.content).toBe("hi");
    // A stale base writes nothing.
    expect(
      appendArtifactVersion(
        db,
        1,
        { content: "x", view: null },
        { artifactId: artifact.id, version: 2, author: "agent", bytes: 1, hash: "x", summary: "" },
      ),
    ).toBeNull();
    appendArtifactVersion(
      db,
      2,
      { content: "yo", view: null },
      {
        artifactId: artifact.id,
        version: 3,
        author: "agent",
        snapshot: "yo",
        bytes: 2,
        hash: "h3",
        summary: "rewrite",
      },
    );
    expect(artifactVersionChain(db, artifact.id, 2).map((v) => v.version.version)).toEqual([1, 2]);
    expect(artifactVersionChain(db, artifact.id, 3).map((v) => v.version.version)).toEqual([3]);
    expect(artifactVersionChain(db, artifact.id, 9).map((v) => v.version.version)).toEqual([3]);
    expect(listArtifactVersions(db, artifact.id, 1).map((v) => v.version.author)).toEqual([
      "user",
      "agent",
    ]);
    expect(getArtifact(db, artifact.id)?.artifact.version).toBe(3);
  });

  it("lists newest first, optionally per thread", () => {
    const db = memoryDb();
    const a = create(db, "thr_1");
    const b = create(db, "thr_2");
    expect(listArtifactsPage(db).items.map((x) => x.id)).toEqual([b.artifact.id, a.artifact.id]);
    expect(listArtifactsPage(db, { threadId: "thr_1" }).items.map((x) => x.id)).toEqual([
      a.artifact.id,
    ]);
    expect(listArtifactsPage(db, { limit: 1 }).hasMore).toBe(true);
  });
});
