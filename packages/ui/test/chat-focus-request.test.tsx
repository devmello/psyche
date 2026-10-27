import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { clearChatFocus, requestChatFocus } from "../src/chat/focus-request.ts";
import { ChatThread } from "../src/chat/Thread.tsx";
import { IDS } from "../src/fixtures/index.ts";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

function mount(openArtifact: (a: unknown) => void) {
  // jsdom has no layout, so scrolling is a stub we can watch.
  const scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  render(
    <StoryWorld slots={{ openArtifact }}>
      <div style={{ height: 900 }}>
        <ChatThread threadId={IDS.threads.dentist} now={STORY_NOW} />
      </div>
    </StoryWorld>,
  );
  return scrollIntoView;
}

describe("landing on an artifact's message from the Library", () => {
  it("scrolls to the message, flashes it and opens the artifact", async () => {
    const openArtifact = vi.fn();
    const scrollIntoView = mount(openArtifact);
    await screen.findByRole("log", { name: "Conversation" });
    act(() =>
      requestChatFocus({
        threadId: IDS.threads.dentist,
        messageId: IDS.messages.dentistResults,
        artifactId: IDS.artifacts.itinerary,
      }),
    );
    await waitFor(() => expect(openArtifact).toHaveBeenCalledTimes(1));
    expect(openArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ id: IDS.artifacts.itinerary }),
    );
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    const message = document.getElementById(`message-${IDS.messages.dentistResults}`);
    expect(message?.getAttribute("data-flash")).toBe("true");
  });

  it("still opens the artifact when its message is not known", async () => {
    const openArtifact = vi.fn();
    mount(openArtifact);
    await screen.findByRole("log", { name: "Conversation" });
    const request = {
      threadId: IDS.threads.dentist,
      messageId: null,
      artifactId: IDS.artifacts.itinerary,
    };
    act(() => requestChatFocus(request));
    await waitFor(() => expect(openArtifact).toHaveBeenCalledTimes(1));
    clearChatFocus(request);
  });
});
