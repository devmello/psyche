import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { UsageSection } from "../src/screens/settings/UsageSection.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

/**
 * Settings → Usage shows why `usage.summary` failed, with a retry. It used to say the Gateway
 * "isn't available" for every failure, including a rate limit the app caused itself.
 */
describe("Settings → Usage when usage.summary fails", () => {
  it("shows the real error and a retry that loads the numbers", async () => {
    render(
      <StoryWorld
        onGateway={(g: MockGateway) =>
          g.failNext("usage.summary", "internal", "Usage could not be read just now")
        }
      >
        <UsageSection />
      </StoryWorld>,
    );
    // A rate-limited read is retried by the client after the Gateway's retry-after (see
    // request-gate.ts), so a single rate limit no longer reaches this screen as an error.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Usage could not be read just now");
    expect(screen.queryByText("Usage isn't available yet.")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /try again|retry/i }));
    expect(await screen.findByRole("heading", { name: "This month" })).toBeTruthy();
  });

  it("a Gateway without the method gets the plain notice and no retry", async () => {
    render(
      <StoryWorld
        onGateway={(g: MockGateway) =>
          g.failNext("usage.summary", "unknown_method", "Unknown method usage.summary")
        }
      >
        <UsageSection />
      </StoryWorld>,
    );
    expect(await screen.findByText("Usage isn't available yet.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: /try again|retry/i })).toBeNull();
  });
});
