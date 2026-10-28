import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { clearComposerBusy, isComposerBusy } from "../src/chat/composer-busy.ts";
import { ChatThread } from "../src/chat/Thread.tsx";
import { isEmptyUserChat } from "../src/data/empty-chat.ts";
import { useThreads } from "../src/data/hooks.ts";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { IDS } from "../src/fixtures/index.ts";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

afterEach(clearComposerBusy);

function Probe({ onThreads }: { onThreads: (t: ReturnType<typeof useThreads>) => void }) {
  const threads = useThreads();
  onThreads(threads);
  return (
    <ul>
      {threads.active.map((t) => (
        <li key={t.thread.id}>{t.thread.id}</li>
      ))}
    </ul>
  );
}

function mountThreads() {
  let latest: ReturnType<typeof useThreads> | undefined;
  let gateway: MockGateway | undefined;
  render(
    <StoryWorld
      onGateway={(g) => {
        gateway = g;
      }}
    >
      <Probe onThreads={(t) => (latest = t)} />
    </StoryWorld>,
  );
  return {
    threads: () => latest as ReturnType<typeof useThreads>,
    gw: () => gateway as MockGateway,
  };
}

describe("New chat in the thread hooks", () => {
  it("reuses the empty chat, keeps it out of the list, and lists it once it has a message", async () => {
    const { threads, gw } = mountThreads();
    await waitFor(() => expect(threads().active.length).toBeGreaterThan(0));
    const before = threads().active.length;

    let first: Awaited<ReturnType<ReturnType<typeof threads>["newChat"]>> | undefined;
    await act(async () => {
      first = await threads().newChat("side");
    });
    expect(first?.userCreated).toBe(true);
    expect(threads().active).toHaveLength(before);
    expect(threads().active.some((t) => t.thread.id === first?.id)).toBe(false);

    // Again, with the empty chat on screen: the same chat, no second thread.
    let again: typeof first;
    await act(async () => {
      again = await threads().newChat("side", first?.id);
    });
    expect(again?.id).toBe(first?.id);
    expect(gw().world.threads.filter((t) => isEmptyUserChat(t))).toHaveLength(1);
    expect(gw().calls.filter((c) => c.method === "threads.newChat")).toHaveLength(2);

    // An incognito chat is its own kind.
    let incognito: typeof first;
    await act(async () => {
      incognito = await threads().newChat("incognito");
    });
    expect(incognito?.id).not.toBe(first?.id);
  });

  it("drops a thread from the list when the Gateway says it was deleted", async () => {
    const { threads, gw } = mountThreads();
    await waitFor(() => expect(threads().active.length).toBeGreaterThan(0));
    const victim = threads().active[0]?.thread.id as string;
    act(() => gw().emit("thread.deleted", { threadId: victim }));
    await waitFor(() => expect(threads().all.some((t) => t.thread.id === victim)).toBe(false));
  });
});

describe("which chats count as empty", () => {
  const base = {
    thread: { userCreated: true, pinned: false, lastMessageAt: null },
    activity: { running: 0, awaitingInput: 0, awaitingApproval: 0 },
  };
  it("is only a user-created, unpinned chat with no message", () => {
    const entry = (thread: object, rest: object = {}) =>
      ({ ...base, thread: { ...base.thread, ...thread }, ...rest }) as never;
    expect(isEmptyUserChat(entry({}))).toBe(true);
    expect(isEmptyUserChat(entry({ userCreated: undefined }))).toBe(false);
    expect(isEmptyUserChat(entry({ pinned: true }))).toBe(false);
    expect(isEmptyUserChat(entry({ lastMessageAt: "2026-10-27T10:00:00.000Z" }))).toBe(false);
    expect(isEmptyUserChat(entry({}, { lastMessage: { role: "user", text: "hi", at: "x" } }))).toBe(
      false,
    );
  });
});

describe("the composer reports an unsent draft", () => {
  it("is busy while the composer holds text, and not once it is cleared", async () => {
    render(
      <StoryWorld>
        <div style={{ height: 900 }}>
          <ChatThread threadId={IDS.threads.main} now={STORY_NOW} />
        </div>
      </StoryWorld>,
    );
    const box = await screen.findByRole("textbox", { name: /^Message / });
    expect(isComposerBusy(IDS.threads.main)).toBe(false);
    await userEvent.type(box, "half a thought");
    await waitFor(() => expect(isComposerBusy(IDS.threads.main)).toBe(true));
    fireEvent.change(box, { target: { value: "" } });
    await waitFor(() => expect(isComposerBusy(IDS.threads.main)).toBe(false));
  });
});
