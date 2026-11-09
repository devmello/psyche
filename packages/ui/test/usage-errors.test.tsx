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
          g.failNext(
            "usage.summary",
            "rate_limited",
            "Too many requests from this device; slow down",
          )
        }
      >
        <UsageSection />
      </StoryWorld>,
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Too many requests from this device; slow down");
    expect(screen.queryByText("Usage isn't available from this Gateway yet.")).toBeNull();
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
    expect(await screen.findByText("Usage isn't available from this Gateway yet.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: /try again|retry/i })).toBeNull();
  });
});
