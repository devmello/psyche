import type { Block, InputRequest, Message } from "@psyche/protocol";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  answerShownByUser,
  blocksToShow,
  indexThreadBlocks,
} from "../src/blocks/thread-blocks.tsx";
import { ChatThread } from "../src/chat/Thread.tsx";
import { type createFixtureWorld, IDS } from "../src/fixtures/index.ts";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

const T = IDS.threads.main;
type World = ReturnType<typeof createFixtureWorld>;

function msg(id: string, seq: number, role: Message["role"], blocks: Block[]): Message {
  return {
    id,
    threadId: T,
    seq,
    role,
    blocks,
    providerNative: null,
    provenance: role === "user" ? "owner" : "agent",
    replyToMessageId: null,
    channelRef: null,
    runId: null,
    createdAt: "2026-10-19T10:00:00Z",
  } as Message;
}

const text = (md: string): Block => ({ type: "text", md });
const question = (id: string): Block => ({ type: "question", inputRequestId: id });

function request(id: string, over: Partial<InputRequest> = {}): InputRequest {
  return {
    id,
    taskId: null,
    threadId: T,
    questions: [
      {
        question: "Which calendar should holds go on?",
        header: "Calendar",
        options: [{ label: "Personal" }, { label: "Work" }],
        multiSelect: false,
      },
    ],
    status: "answered",
    answer: { Calendar: "Personal" },
    createdAt: "2026-10-19T09:59:00Z",
    answeredAt: "2026-10-19T10:00:30Z",
    answeredByDeviceId: null,
    ...over,
  };
}

function thread(edit: (w: World) => void) {
  return render(
    <StoryWorld edit={edit}>
      <div style={{ height: 900 }}>
        <ChatThread threadId={T} now={STORY_NOW} />
      </div>
    </StoryWorld>,
  );
}

/** The fixture thread's own messages are out of the way: only ours are in `main`. */
function only(w: World, ...messages: Message[]) {
  w.messages = w.messages.filter((m) => m.threadId !== T);
  w.messages.push(...messages);
}

describe("answered question cards", () => {
  it("drops the card from a message when a later user message already says the answer", () => {
    const a = msg("m_q", 1, "agent", [text("Which calendar?"), question("inp_a")]);
    const u = msg("m_u", 2, "user", [text("Personal please")]);
    const index = {
      ...indexThreadBlocks([a, u]),
      answeredQuestions: new Map([["inp_a", ["Personal"]]]),
    };
    expect(blocksToShow(a, index).map((b) => b.type)).toEqual(["text"]);
    // Not said by any user message: the card stays (it renders as one answer line).
    const quiet = { ...index, userTexts: [] };
    expect(blocksToShow(a, quiet).map((b) => b.type)).toEqual(["text", "question"]);
    // An unanswered question is never dropped.
    const open = { ...index, answeredQuestions: new Map<string, readonly string[]>() };
    expect(blocksToShow(a, open).map((b) => b.type)).toEqual(["text", "question"]);
  });

  it("only counts user messages after the question", () => {
    const early = msg("m_u0", 1, "user", [text("Personal")]);
    const a = msg("m_q", 2, "agent", [question("inp_a")]);
    const index = indexThreadBlocks([early, a]);
    expect(answerShownByUser(index, "m_q", ["Personal"])).toBe(false);
    expect(answerShownByUser(index, "m_q", [])).toBe(false);
  });

  it("shows no card on reload, only the compact answer line when no user message shows it", async () => {
    thread((w) => {
      only(w, msg("m_q", 1, "agent", [text("Which calendar?"), question("inp_a")]));
      w.inputRequests.push(request("inp_a"));
    });
    const log = await screen.findByRole("log", { name: "Conversation" });
    const line = await within(log).findByTestId("question-answer-line");
    expect(line.textContent).toBe("↳ Personal");
    expect(within(log).queryByText("Answered questions")).toBeNull();
    expect(within(log).queryByRole("button", { name: "Answer" })).toBeNull();
    expect(within(log).getByText("Which calendar?")).toBeTruthy();
  });

  it("shows nothing extra when a user message already carries the answer", async () => {
    thread((w) => {
      only(
        w,
        msg("m_q", 1, "agent", [text("Which calendar?"), question("inp_a")]),
        msg("m_u", 2, "user", [text("Personal")]),
      );
      w.inputRequests.push(request("inp_a"));
    });
    const log = await screen.findByRole("log", { name: "Conversation" });
    await within(log).findByText("Which calendar?");
    await waitFor(() => expect(within(log).queryByTestId("question-answer-line")).toBeNull());
    expect(within(log).queryByText("Answered questions")).toBeNull();
  });

  it("leaves no empty row for a message that was only the question", async () => {
    thread((w) => {
      only(
        w,
        msg("m_q", 1, "agent", [question("inp_a")]),
        msg("m_u", 2, "user", [text("Personal")]),
      );
      w.inputRequests.push(request("inp_a"));
    });
    const log = await screen.findByRole("log", { name: "Conversation" });
    await within(log).findByText("Personal");
    await waitFor(() => expect(log.querySelector('[data-role="agent"]')).toBeNull());
  });

  it("removes the card as soon as it is answered", async () => {
    thread((w) => {
      only(w, msg("m_q", 1, "agent", [text("Which calendar?"), question("inp_a")]));
      w.inputRequests.push(
        request("inp_a", {
          status: "open",
          answer: null,
          answeredAt: null,
          createdAt: "2026-10-19T09:00:00Z",
        }),
      );
    });
    const log = await screen.findByRole("log", { name: "Conversation" });
    fireEvent.click(await within(log).findByRole("radio", { name: /Work/ }));
    fireEvent.click(within(log).getByRole("button", { name: "Answer" }));
    const line = await within(log).findByTestId("question-answer-line");
    expect(line.textContent).toBe("↳ Work");
    expect(within(log).queryByRole("button", { name: "Answer" })).toBeNull();
    expect(within(log).queryByRole("radio")).toBeNull();
  });

  it("keeps unanswered and cancelled cards as they were", async () => {
    thread((w) => {
      only(
        w,
        msg("m_q1", 1, "agent", [text("Open one"), question("inp_open")]),
        msg("m_q2", 2, "agent", [text("Cancelled one"), question("inp_cancelled")]),
      );
      w.inputRequests.push(
        request("inp_open", {
          status: "open",
          answer: null,
          answeredAt: null,
          createdAt: "2026-10-19T09:00:00Z",
        }),
        request("inp_cancelled", { status: "cancelled", answer: null }),
      );
    });
    const log = await screen.findByRole("log", { name: "Conversation" });
    expect(await within(log).findByRole("button", { name: "Answer" })).toBeTruthy();
    expect(await within(log).findByText("No longer needed.")).toBeTruthy();
    expect(within(log).queryByTestId("question-answer-line")).toBeNull();
  });
});

describe("answered approval receipts", () => {
  function approvalWorld(w: World, id: string, over: Record<string, unknown>) {
    const base = w.approvals.find((x) => x.id === IDS.approvals.sendEmail);
    if (base === undefined) throw new Error("fixture approval");
    w.approvals.push({
      ...base,
      id,
      requestedBy: { ...base.requestedBy, threadId: T },
      ...over,
    } as (typeof w.approvals)[number]);
    only(w, {
      ...msg(`m_${id}`, 1, "agent", [text("Working on it."), { type: "approval", approvalId: id }]),
      runId: null,
    });
  }

  it("collapses to a one-line receipt that opens the full card on Details", async () => {
    thread((w) =>
      approvalWorld(w, "ap_ok", {
        summary: "Read Downloads",
        status: "approved",
        scopeGranted: "once",
      }),
    );
    const log = await screen.findByRole("log", { name: "Conversation" });
    const row = await within(log).findByTestId("approval-result");
    expect(row.textContent).toContain("Allowed once: Read Downloads");
    expect(log.querySelector("[data-approval-id]")).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "Show details of Read Downloads" }));
    await waitFor(() => expect(log.querySelector("[data-approval-id='ap_ok']")).not.toBeNull());
    const hide = within(row).getByRole("button", { name: "Hide details of Read Downloads" });
    expect(hide.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(hide);
    await waitFor(() => expect(log.querySelector("[data-approval-id]")).toBeNull());
  });

  it("words a denial plainly", async () => {
    thread((w) =>
      approvalWorld(w, "ap_no", { summary: "Run npm test", status: "denied", scopeGranted: null }),
    );
    const log = await screen.findByRole("log", { name: "Conversation" });
    const row = await within(log).findByTestId("approval-result");
    expect(row.textContent).toContain("Denied: Run npm test");
  });

  it("leaves a pending approval as the pointer to the dock", async () => {
    thread((w) => approvalWorld(w, "ap_wait", { summary: "Send it", status: "pending" }));
    const log = await screen.findByRole("log", { name: "Conversation" });
    expect(await within(log).findByText("Waiting for your approval")).toBeTruthy();
    expect(within(log).queryByTestId("approval-result")).toBeNull();
    expect(within(log).queryByRole("button", { name: /details/i })).toBeNull();
  });

  it("words a card closed by a chat reply (declined / answered in chat)", async () => {
    thread((w) =>
      approvalWorld(w, "ap_chat", {
        summary: "Run npm test",
        status: "denied",
        scopeGranted: null,
        invalidatedReason: "owner_replied_in_chat",
      }),
    );
    const log = await screen.findByRole("log", { name: "Conversation" });
    const row = await within(log).findByTestId("approval-result");
    expect(row.textContent).toContain("Declined — you replied in chat: Run npm test");
  });

  it("shows a question answered by a typed message as answered in chat", async () => {
    thread((w) => {
      only(w, msg("m_q", 1, "agent", [text("Which calendar?"), question("inp_a")]));
      w.inputRequests.push(request("inp_a", { answer: null }));
    });
    const log = await screen.findByRole("log", { name: "Conversation" });
    const line = await within(log).findByTestId("question-answered-in-chat");
    expect(line.textContent).toBe("Answered in chat");
  });
});
