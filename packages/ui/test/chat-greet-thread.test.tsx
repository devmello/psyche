import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChatThread } from "../src/chat/Thread.tsx";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { IDS } from "../src/fixtures/index.ts";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

function greetCalls(gateway: MockGateway | undefined): unknown[] {
  return (gateway?.calls ?? []).filter((c) => c.method === "chat.greet").map((c) => c.params);
}

describe("the main chat asks for its greeting (#555)", () => {
  it("calls chat.greet once when the main chat is empty", async () => {
    let gateway: MockGateway | undefined;
    render(
      <StoryWorld
        edit={(world) => {
          world.messages = world.messages.filter((m) => m.threadId !== IDS.threads.main);
        }}
        onGateway={(g) => {
          gateway = g;
        }}
      >
        <div style={{ height: 900 }}>
          <ChatThread threadId={IDS.threads.main} now={STORY_NOW} />
        </div>
      </StoryWorld>,
    );
    await screen.findByTestId("chat-empty");
    await waitFor(() => expect(greetCalls(gateway)).toHaveLength(1));
    expect(greetCalls(gateway)).toEqual([{ threadId: IDS.threads.main }]);
  });

  it("does not greet a main chat that already has messages", async () => {
    let gateway: MockGateway | undefined;
    render(
      <StoryWorld
        onGateway={(g) => {
          gateway = g;
        }}
      >
        <div style={{ height: 900 }}>
          <ChatThread threadId={IDS.threads.main} now={STORY_NOW} />
        </div>
      </StoryWorld>,
    );
    await screen.findByRole("log", { name: "Conversation" });
    expect(greetCalls(gateway)).toHaveLength(0);
  });

  it("does not greet a side chat", async () => {
    let gateway: MockGateway | undefined;
    render(
      <StoryWorld
        edit={(world) => {
          world.messages = world.messages.filter((m) => m.threadId !== IDS.threads.dentist);
        }}
        onGateway={(g) => {
          gateway = g;
        }}
      >
        <div style={{ height: 900 }}>
          <ChatThread threadId={IDS.threads.dentist} now={STORY_NOW} />
        </div>
      </StoryWorld>,
    );
    await screen.findByTestId("chat-empty");
    expect(greetCalls(gateway)).toHaveLength(0);
  });
});
