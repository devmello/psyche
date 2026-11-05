import type { Block, Message } from "@psyche/protocol";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { type ReactElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatThread } from "../src/chat/Thread.tsx";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { IDS } from "../src/fixtures/index.ts";
import { LifeAnswerCard } from "../src/screens/search/LifeAnswerCard.tsx";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

afterEach(cleanup);

/**
 * "Open as a chat" (future-features §1): the chat is opened with the answer's opaque id and
 * nothing else, and the answer at the start of the chat shows the same chips, which open the
 * source viewer.
 */

const T = IDS.threads.main;
const MAIL_HIT = {
  scope: "connectors" as const,
  id: "mail:1",
  title: "Contract timing",
  snippet: "the contract will be ready by Friday, signed copy to follow",
  score: 1,
  threadId: null,
  route: null,
  provenance: "untrusted" as const,
  createdAt: Date.parse("2026-10-28T09:00:00.000Z"),
};

const lifeBlock = (over: Record<string, unknown> = {}): Block =>
  ({
    type: "life_answer",
    answerId: "ans-1",
    question: "when will the contract be ready",
    answer: "The contract will be ready on Friday [P1].",
    model: "cloud",
    factIds: [],
    passageIds: ["mail:1"],
    facts: [],
    passages: [
      { id: "mail:1", source: "mail", title: "Contract timing", createdAt: MAIL_HIT.createdAt },
    ],
    ...over,
  }) as Block;

function userMessage(blocks: Block[]): Message {
  return {
    id: "m-answer",
    threadId: T,
    seq: 1,
    role: "user",
    blocks,
    providerNative: null,
    provenance: "owner",
    replyToMessageId: null,
    channelRef: null,
    runId: null,
    createdAt: "2026-10-19T10:00:00Z",
  } as Message;
}

describe("the answer at the start of a chat", () => {
  it("shows the claims with their chips, and a chip opens the source in the viewer", async () => {
    render(
      <StoryWorld
        edit={(w) => {
          w.searchHits = [MAIL_HIT];
          w.messages = w.messages.filter((m) => m.threadId !== T);
          w.messages.push(
            userMessage([lifeBlock(), { type: "text", md: "when will the contract be ready" }]),
          );
        }}
      >
        <div style={{ height: 900 }}>
          <ChatThread threadId={T} now={STORY_NOW} />
        </div>
      </StoryWorld>,
    );
    const block = await screen.findByTestId("life-answer-block");
    expect(block.textContent).toContain("The contract will be ready on Friday.");
    const chip = within(block).getByTestId("life-answer-source");
    expect(chip.textContent).toBe("Mail: Contract timing");
    fireEvent.click(chip);
    fireEvent.click(await within(block).findByTestId("life-answer-open-passage"));
    const text = await within(block).findByTestId("source-text");
    expect(text.textContent).toContain("signed copy to follow");
  });

  it("shows nothing for an answer the Gateway left no claim in", () => {
    render(
      <StoryWorld
        edit={(w) => {
          w.messages = w.messages.filter((m) => m.threadId !== T);
          w.messages.push(
            userMessage([
              lifeBlock({ answer: "", passageIds: [], passages: [] }),
              { type: "text", md: "when will the contract be ready" },
            ]),
          );
        }}
      >
        <div style={{ height: 900 }}>
          <ChatThread threadId={T} now={STORY_NOW} />
        </div>
      </StoryWorld>,
    );
    expect(screen.queryByTestId("life-answer-block")).toBeNull();
  });
});

describe("Open as a chat", () => {
  let gateway: MockGateway | undefined;
  const gw = () => gateway as MockGateway;

  function Flow({ navigate }: { navigate: (to: string) => void }): ReactElement {
    const [route, setRoute] = useState("/search");
    const slots = {
      navigate: (to: string) => {
        navigate(to);
        setRoute(to);
      },
    };
    return (
      <StoryWorld
        slots={slots}
        onGateway={(g) => {
          gateway = g;
        }}
      >
        <div style={{ height: 900 }}>
          {route.startsWith("/chat/") ? (
            <ChatThread threadId={route.slice("/chat/".length)} now={STORY_NOW} />
          ) : (
            <LifeAnswerCard
              state={{
                phase: "done",
                question: "when will the contract be ready",
                onAsk: () => undefined,
                result: {
                  answer: "The contract will be ready on Friday [P1].",
                  answerId: "ans-1",
                  facts: [],
                  passages: [
                    {
                      id: "mail:1",
                      source: "mail",
                      title: "Contract timing",
                      createdAt: MAIL_HIT.createdAt,
                    },
                  ],
                  reason: null,
                },
              }}
            />
          )}
        </div>
      </StoryWorld>
    );
  }

  it("opens a chat with the answer's id as the context and sends the id, nothing else", async () => {
    const navigate = vi.fn();
    const user = userEvent.setup();
    render(<Flow navigate={navigate} />);
    await user.click(screen.getByRole("button", { name: "Open as a chat" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(expect.stringMatching(/^\/chat\//)));
    const chip = await screen.findByTestId("context-chip");
    expect(within(chip).getByText("Answer: when will the contract be ready")).toBeTruthy();
    const box = await screen.findByRole("textbox", { name: /^Message / });
    expect(box.getAttribute("placeholder")).toBe("Ask about this answer");
    await waitFor(() =>
      expect((box as HTMLTextAreaElement).value).toBe("when will the contract be ready"),
    );
    await user.click(await screen.findByRole("button", { name: /^Send/ }));
    await waitFor(() => {
      const send = gw().calls.find((c) => c.method === "chat.send");
      expect(send?.params).toMatchObject({
        context: { kind: "life_answer", id: "ans-1" },
        content: "when will the contract be ready",
      });
      // The id only: no answer text, no cited ids, no title for the Gateway to be tempted by.
      const sent = JSON.stringify(send?.params);
      expect(sent).not.toContain("Friday");
      expect(sent).not.toContain("mail:1");
      expect(sent).not.toContain("Contract timing");
    });
  });

  it("falls back to the question alone when the answer has no id", () => {
    const prefillComposer = vi.fn();
    render(
      <StoryWorld slots={{ prefillComposer }}>
        <LifeAnswerCard
          state={{
            phase: "done",
            question: "when will the contract be ready",
            onAsk: () => undefined,
            result: {
              answer: "The contract will be ready on Friday [P1].",
              facts: [],
              passages: [{ id: "mail:1", source: "mail", title: "T", createdAt: 0 }],
              reason: null,
            },
          }}
        />
      </StoryWorld>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open as a chat" }));
    expect(prefillComposer).toHaveBeenCalledExactlyOnceWith("when will the contract be ready");
  });
});
