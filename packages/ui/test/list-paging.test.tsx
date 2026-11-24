import type { FeedPost, LibraryItem, Task } from "@psyche/protocol";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import {
  GatewayProvider,
  GatewayStore,
  useFeed,
  useLibrary,
  useLoadRemaining,
  useTasks,
} from "../src/data/index.ts";
import { collectAllPages } from "../src/data/list-pages.ts";
import { MockGateway } from "../src/data/mock-gateway.ts";

// More rows than one Gateway page (50), so a hook that drops `nextCursor` shows only the first page.
const ROWS = 120;
const NOW = "2026-10-18T10:12:00Z";

type Handler = (params: Record<string, unknown>) => unknown;

/** Serves `rows` the way the Gateway pages: `limit` rows (default 50) from the cursor, then the cursor. */
function servePage<T>(rows: readonly T[], key: string, params: Record<string, unknown>) {
  const start = typeof params.cursor === "string" ? Number(params.cursor) : 0;
  const limit = typeof params.limit === "number" ? params.limit : 50;
  const end = Math.min(rows.length, start + limit);
  return { [key]: rows.slice(start, end), nextCursor: end < rows.length ? String(end) : null };
}

function setup() {
  const gateway = new MockGateway({}, { now: () => NOW });
  const store = new GatewayStore(gateway, { now: () => NOW });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <GatewayProvider client={gateway} store={store}>
      {children}
    </GatewayProvider>
  );
  // The mock answers `method` from this table: a paged handler stands in for the Gateway's.
  const serve = (method: string, handler: Handler) => {
    (gateway as unknown as { handlers: Record<string, Handler> }).handlers[method] = handler;
  };
  return { serve, wrapper };
}

const taskRows = Array.from({ length: ROWS }, (_, i) => ({
  id: `task_${i}`,
  threadId: "thr_main",
  title: `Task ${i}`,
  goal: "Goal",
  status: "done",
  createdFrom: "chat",
  plan: null,
  checklist: [],
  currentStepId: null,
  attempt: 1,
  leaseOwner: null,
  leaseUntil: null,
  browserSessionId: null,
  sandboxId: null,
  summary: null,
  outcome: null,
  createdAt: NOW,
  updatedAt: new Date(Date.parse(NOW) - i * 1000).toISOString(),
  completedAt: null,
})) as unknown as Task[];

const libraryRows = Array.from({ length: ROWS }, (_, i) => ({
  id: `lib_${i}`,
  kind: "document",
  name: `Doc ${i}.txt`,
  mime: "text/plain",
  path: `uploads/doc-${i}.txt`,
  size: 10,
  sha256: `sha256:${"0".repeat(64)}`,
  origin: "upload",
  threadId: null,
  taskId: null,
  tags: [],
  textExtractRef: null,
  createdAt: new Date(Date.parse(NOW) - i * 1000).toISOString(),
})) as unknown as LibraryItem[];

const feedRows = Array.from({ length: ROWS }, (_, i) => ({
  id: `post_${i}`,
  title: `Post ${i}`,
  bodyMd: "Body",
  citations: [],
  cluster: null,
  score: 1,
  reasons: [],
  exploration: false,
  briefingId: null,
  feedback: null,
  createdAt: new Date(Date.parse(NOW) - i * 1000).toISOString(),
})) as unknown as FeedPost[];

describe("collectAllPages", () => {
  it("reads every page of a cursor-paged list", async () => {
    const got = await collectAllPages(async (cursor) => {
      const start = Number(cursor ?? 0);
      const end = Math.min(ROWS, start + 50);
      return {
        items: taskRows.slice(start, end).map((t) => t.id),
        nextCursor: end < ROWS ? String(end) : null,
      };
    });
    expect(got).toHaveLength(ROWS);
    expect(got[ROWS - 1]).toBe(`task_${ROWS - 1}`);
  });

  it("stops when the Gateway repeats a cursor instead of looping", async () => {
    let calls = 0;
    const got = await collectAllPages(async () => {
      calls += 1;
      return { items: [calls], nextCursor: "same" };
    });
    expect(calls).toBe(2);
    expect(got).toEqual([1, 2]);
  });
});

describe("list hooks past the first page", () => {
  it("useTasks loads every page of tasks, merged by id", async () => {
    const { serve, wrapper } = setup();
    serve("tasks.list", (p) => servePage(taskRows, "tasks", p));
    const { result } = renderHook(() => useTasks(), { wrapper });
    await waitFor(() => expect(result.current.all).toHaveLength(50));
    expect(result.current.hasMore).toBe(true);
    await act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.all).toHaveLength(100));
    await act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.all).toHaveLength(ROWS));
    expect(result.current.hasMore).toBe(false);
  });

  it("useLibrary loads every page of Library items", async () => {
    const { serve, wrapper } = setup();
    serve("library.list", (p) => servePage(libraryRows, "items", p));
    const { result } = renderHook(() => useLibrary(), { wrapper });
    await waitFor(() => expect(result.current.items).toHaveLength(50));
    await act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.items).toHaveLength(100));
    await act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.items).toHaveLength(ROWS));
    expect(result.current.hasMore).toBe(false);
  });

  it("useFeed loads the next page of posts and keeps the brief time", async () => {
    const { serve, wrapper } = setup();
    serve("feed.list", (p) => ({
      ...servePage(feedRows, "posts", p),
      nextBriefAt: "2026-10-19T07:00:00Z",
    }));
    const { result } = renderHook(() => useFeed(), { wrapper });
    await waitFor(() => expect(result.current.posts).toHaveLength(50));
    expect(result.current.hasMore).toBe(true);
    await act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.posts).toHaveLength(100));
    expect(result.current.nextBriefAt).toBe("2026-10-19T07:00:00Z");
  });

  it("useLoadRemaining keeps paging until the list is complete", async () => {
    const { serve, wrapper } = setup();
    serve("tasks.list", (p) => servePage(taskRows, "tasks", p));
    const { result } = renderHook(
      () => {
        const tasks = useTasks();
        useLoadRemaining(tasks);
        return tasks;
      },
      { wrapper },
    );
    await waitFor(() => expect(result.current.all).toHaveLength(ROWS));
    expect(result.current.hasMore).toBe(false);
  });
});
