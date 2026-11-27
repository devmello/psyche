import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FixtureWorld } from "../src/fixtures/index.ts";
import { HelperPausedLine, MOVED_FACTS_KEY, MovedFactsNote } from "../src/home/HomeNotes.tsx";
import { codeSentence } from "../src/i18n/errors.ts";
import { FullDiskAccessRow } from "../src/points/HelperPermissionRow.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

afterEach(cleanup);
beforeEach(() => window.localStorage.clear());

const emptyReview = (movedPending: number): FixtureWorld["review"] => ({
  items: [],
  quarantine: [],
  runs: [],
  movedPending,
});

describe("MovedFactsNote", () => {
  it("shows the count once, opens the queue, and never comes back after Dismiss", async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    const edit = (w: FixtureWorld) => {
      w.review = emptyReview(42);
    };
    const first = render(
      <StoryWorld edit={edit}>
        <MovedFactsNote onNavigate={navigate} />
      </StoryWorld>,
    );
    expect(await screen.findByText(/42 facts learned from other people's messages/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Review" }));
    expect(navigate).toHaveBeenCalledWith("/memory/review");
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("home-moved-facts")).toBeNull();
    expect(window.localStorage.getItem(MOVED_FACTS_KEY)).toBe("1");
    first.unmount();
    // A later launch: the same count, but the owner dismissed it.
    render(
      <StoryWorld edit={edit}>
        <MovedFactsNote onNavigate={navigate} />
      </StoryWorld>,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("home-moved-facts")).toBeNull();
  });

  it("is not drawn when the migration moved nothing", async () => {
    render(
      <StoryWorld
        edit={(w) => {
          w.review = emptyReview(0);
        }}
      >
        <MovedFactsNote onNavigate={() => {}} />
      </StoryWorld>,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("home-moved-facts")).toBeNull();
  });
});

const mailOn = (w: FixtureWorld) => {
  w.searchSources = {
    sources: { mail: { enabled: true, processing: "cloud", agent: true } },
    exclude: { contacts: [], chats: [], accounts: [], folders: [] },
  };
};

describe("HelperPausedLine", () => {
  it("says Mail and Messages are paused when the helper is offline and Mail is on", async () => {
    const openSettings = vi.fn();
    render(
      <StoryWorld
        edit={(w) => {
          mailOn(w);
          for (const n of w.nodes) if (n.kind === "mac-helper") n.status = "offline";
        }}
        slots={{ openSettings }}
      >
        <HelperPausedLine />
      </StoryWorld>,
    );
    expect(await screen.findByText(/Mail and Messages are paused/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Open Devices" }));
    expect(openSettings).toHaveBeenCalledWith("devices");
  });

  it("stays quiet when the helper is online", async () => {
    render(
      <StoryWorld edit={mailOn}>
        <HelperPausedLine />
      </StoryWorld>,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("home-helper-paused")).toBeNull();
  });

  it("stays quiet when neither Mail nor Messages is on, even with the helper offline", async () => {
    render(
      <StoryWorld
        edit={(w) => {
          w.searchSources = {
            sources: { notes: { enabled: true, processing: "cloud", agent: true } },
            exclude: { contacts: [], chats: [], accounts: [], folders: [] },
          };
          for (const n of w.nodes) if (n.kind === "mac-helper") n.status = "offline";
        }}
      >
        <HelperPausedLine />
      </StoryWorld>,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("home-helper-paused")).toBeNull();
  });

  it("stays quiet when no helper was ever paired", async () => {
    render(
      <StoryWorld
        edit={(w) => {
          mailOn(w);
          w.nodes = w.nodes.filter((n) => n.kind !== "mac-helper");
        }}
      >
        <HelperPausedLine />
      </StoryWorld>,
    );
    await waitFor(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("home-helper-paused")).toBeNull();
  });
});

describe("Messages Full Disk Access copy", () => {
  it("names Psyche (Helper) and the restart, in the row and in the refusal", () => {
    render(<FullDiskAccessRow persona="Psyche" onOpen={() => {}} />);
    const row = screen.getByTestId("full-disk-access-row").textContent ?? "";
    expect(row).toMatch(/Psyche \(Helper\)/);
    expect(row).toMatch(/restart/i);
    const refusal = codeSentence("full_disk_access_missing") ?? "";
    expect(refusal).toMatch(/Psyche \(Helper\)/);
    expect(refusal).toMatch(/restart/i);
  });
});
