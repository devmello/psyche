import { type AgentToolRegistration, defineTool } from "@psyche/agent-core";
import { createPermissionBroker } from "@psyche/permissions";
import { FakeClock } from "@psyche/testing";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import {
  type CursorStore,
  FeedStore,
  type FolderFile,
  NOTES_FOLDER_SOURCE,
  NotesFolderWatcher,
  ProposalService,
} from "../src/index.ts";
import { T0, testDb } from "./helpers.ts";

/** The recordings-folder watch (#953) with a fake directory, copy and cursor store. */

class MemoryCursors implements CursorStore {
  readonly map = new Map<string, string>();
  getCursor(source: string, key: string) {
    return this.map.get(`${source}/${key}`);
  }
  setCursor(source: string, key: string, cursor: string) {
    this.map.set(`${source}/${key}`, cursor);
  }
}

const FOLDER = "/Users/me/Recordings";

const file = (name: string, size = 1000, mtimeMs = 1): FolderFile => ({
  name,
  path: `${FOLDER}/${name}`,
  size,
  mtimeMs,
});

function rig(cursors = new MemoryCursors(), db = testDb(new FakeClock(T0))) {
  const clock = new FakeClock(T0);
  const broker = createPermissionBroker({
    clock,
    approvers: {
      device: async (id) => (id === "dev_mac" ? { scopes: ["operator.approvals"] } : undefined),
      isOwnerSender: async () => false,
    },
  });
  const created: unknown[] = [];
  const tools = new Map<string, AgentToolRegistration>([
    [
      "meetings.notes.create",
      defineTool({
        name: "meetings.notes.create",
        description: "Make notes",
        input: Type.Object({ libraryItemId: Type.String(), title: Type.Optional(Type.String()) }),
        sideEffect: "write",
        run: async (p) => {
          created.push(p);
          return { output: { status: "done" }, provenance: "trusted" as const };
        },
      }),
    ],
  ]);
  let n = 0;
  const proposals = new ProposalService({
    db: db.sqlite,
    clock,
    broker,
    tools: { get: (name) => tools.get(name) },
    mainThread: async () => "thr_main",
    newId: () => `prop_${++n}`,
  });
  const feed = new FeedStore(db.sqlite);
  const state = {
    folder: FOLDER as string | undefined,
    granted: true,
    files: [] as FolderFile[],
    copies: [] as string[],
    listed: 0,
    refusal: undefined as string | undefined,
    skips: [] as string[],
    errors: [] as unknown[],
    failCopy: false,
  };
  const watcher = new NotesFolderWatcher({
    clock,
    cursors,
    feed,
    proposals,
    folder: () => state.folder,
    refusal: () => state.refusal,
    granted: () => state.granted,
    list: async () => {
      state.listed += 1;
      return state.files;
    },
    copy: async (f) => {
      if (state.failCopy) throw new Error("disk full");
      state.copies.push(f.name);
      return { libraryItemId: `item_${f.name}` };
    },
    newId: () => `post_${++n}`,
    onSkip: (r) => state.skips.push(r),
    onError: (e) => state.errors.push(e),
  });
  return { clock, db, broker, cursors, proposals, feed, watcher, state, created };
}

const posts = (r: ReturnType<typeof rig>) =>
  r.db.sqlite.prepare("SELECT id, kind, refs FROM feed_posts").all() as {
    id: string;
    kind: string;
    refs: string;
  }[];

describe("recordings folder watch (#953)", () => {
  it("the first scan is a baseline: existing recordings are not offered", async () => {
    const r = rig();
    r.state.files = [file("old1.m4a"), file("old2.mp3")];
    expect(await r.watcher.scan()).toMatchObject({ offered: 0, baseline: 2 });
    await r.watcher.scan();
    await r.watcher.scan();
    expect(r.state.copies).toEqual([]);
    expect(posts(r)).toEqual([]);
  });

  it("a new stable audio file is copied and offered exactly once", async () => {
    const r = rig();
    r.state.files = [file("old.m4a")];
    await r.watcher.scan();
    r.state.files = [file("old.m4a"), file("standup.m4a", 5000, 9), file("notes.txt")];
    expect((await r.watcher.scan()).offered).toBe(0); // first sighting
    expect((await r.watcher.scan()).offered).toBe(1); // unchanged across two scans
    expect((await r.watcher.scan()).offered).toBe(0);
    expect(r.state.copies).toEqual(["standup.m4a"]);
    const [post] = posts(r);
    expect(posts(r)).toHaveLength(1);
    expect(post?.kind).toBe("suggestion");
    const proposalId = (JSON.parse(post?.refs ?? "{}") as { proposalIds: string[] })
      .proposalIds[0] as string;
    expect(r.proposals.get(proposalId)).toMatchObject({
      status: "pending",
      postId: post?.id,
      calls: [
        {
          tool: "meetings.notes.create",
          params: { libraryItemId: "item_standup.m4a", title: "standup" },
        },
      ],
    });
  });

  it("a restart with the same cursor store does not offer a file again", async () => {
    const cursors = new MemoryCursors();
    const first = rig(cursors);
    await first.watcher.scan();
    first.state.files = [file("a.m4a")];
    await first.watcher.scan();
    await first.watcher.scan();
    expect(first.state.copies).toEqual(["a.m4a"]);

    const second = rig(cursors);
    second.state.files = [file("a.m4a")];
    await second.watcher.scan();
    await second.watcher.scan();
    expect(second.state.copies).toEqual([]);
    expect(posts(second)).toEqual([]);
  });

  it("a folder that is not granted is not scanned", async () => {
    const r = rig();
    r.state.granted = false;
    r.state.files = [file("a.m4a")];
    expect(await r.watcher.scan()).toMatchObject({ offered: 0 });
    await r.watcher.scan();
    expect(r.state.listed).toBe(0);
    expect(r.state.skips).toHaveLength(1); // said once, not every scan
    expect(r.cursors.map.size).toBe(0);
  });

  it("approving the card runs meetings.notes.create with the Library item id", async () => {
    const r = rig();
    await r.watcher.scan();
    r.state.files = [file("call.wav", 10, 5)];
    await r.watcher.scan();
    await r.watcher.scan();
    const proposal = r.proposals.list({}).proposals[0];
    expect(proposal).toBeDefined();
    const { issued } = await r.proposals.approve(proposal?.id ?? "");
    expect(r.created).toEqual([]); // nothing runs before the approval
    r.clock.advance(500);
    await r.broker.answer({
      approvalId: issued.approval.id,
      answerToken: issued.answerTokens.desktop ?? "",
      decision: "approve",
      scope: "once",
      decidedBy: { deviceId: "dev_mac", surface: "desktop" },
    });
    await r.proposals.idle();
    expect(r.created).toEqual([{ libraryItemId: "item_call.wav", title: "call" }]);
    expect(r.proposals.get(proposal?.id ?? "").status).toBe("done");
    // The file stays marked seen.
    await r.watcher.scan();
    expect(r.state.copies).toEqual(["call.wav"]);
  });

  it("a file whose size or modification time is still changing is not offered yet", async () => {
    const r = rig();
    await r.watcher.scan();
    r.state.files = [file("live.m4a", 100, 1)];
    await r.watcher.scan();
    r.state.files = [file("live.m4a", 200, 2)]; // still being written
    await r.watcher.scan();
    r.state.files = [file("live.m4a", 200, 3)]; // same size, newer mtime
    await r.watcher.scan();
    expect(r.state.copies).toEqual([]);
    await r.watcher.scan();
    expect(r.state.copies).toEqual(["live.m4a"]);
  });

  it("changing the folder sets a new baseline for the new path", async () => {
    const r = rig();
    await r.watcher.scan();
    r.state.folder = "/Users/me/Other";
    r.state.files = [file("existing.m4a")];
    expect(await r.watcher.scan()).toMatchObject({ offered: 0, baseline: 1 });
    await r.watcher.scan();
    expect(r.state.copies).toEqual([]);
  });

  it("turning the watch off and on again starts from a fresh baseline", async () => {
    const r = rig();
    await r.watcher.scan();
    r.state.folder = "";
    expect((await r.watcher.scan()).skipped).toBeDefined();
    r.state.folder = FOLDER;
    r.state.files = [file("added-while-off.m4a")];
    expect(await r.watcher.scan()).toMatchObject({ offered: 0, baseline: 1 });
    expect(r.state.copies).toEqual([]);
    expect(r.cursors.getCursor(NOTES_FOLDER_SOURCE, "state")).toContain(FOLDER);
  });

  it("a copy that keeps failing is retried, then given up without an offer", async () => {
    const r = rig();
    await r.watcher.scan();
    r.state.files = [file("big.m4a")];
    r.state.failCopy = true;
    for (let i = 0; i < 6; i++) await r.watcher.scan();
    expect(r.state.errors).toHaveLength(3);
    expect(posts(r)).toEqual([]);
    r.state.failCopy = false;
    await r.watcher.scan();
    expect(r.state.copies).toEqual([]);
  });
});
