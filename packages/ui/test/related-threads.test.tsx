import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RelatedThreads } from "../src/blocks/RelatedThreads.tsx";
import { UiSlotsProvider } from "../src/slots.tsx";

/** E12: "From your other chats" is collapsed, plain text, and opens the chat. */
describe("RelatedThreads (E12)", () => {
  it("lists the chats as plain text behind a toggle and opens one", async () => {
    const navigate = vi.fn();
    const { container } = render(
      <UiSlotsProvider value={{ navigate }}>
        <RelatedThreads
          block={{
            type: "related_threads",
            items: [
              {
                threadId: "thr_main",
                title: "Launch plan",
                snippet: "Owner: ship **Nov 3** [link](https://evil.example)",
                lastMessageAt: null,
              },
            ],
          }}
        />
      </UiSlotsProvider>,
    );
    expect(container.textContent).toBe("From your other chats (1 chat)");
    await userEvent.click(screen.getByRole("button", { name: /From your other chats/ }));
    expect(container.textContent).toContain("Owner: ship **Nov 3** [link](https://evil.example)");
    expect(container.querySelector("a")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Launch plan" }));
    expect(navigate).toHaveBeenCalledWith("/chat/thr_main");
  });
});
