import type { LibraryItem } from "@psyche/protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { MockBrowserRecording, MockGateway } from "../src/data/mock-gateway.ts";
import {
  BrowserRecordingViewer,
  frameFor,
} from "../src/screens/library/BrowserRecordingViewer.tsx";
import { LibraryScreen } from "../src/screens/library/LibraryScreen.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

const ITEM = {
  id: "lib_rec_1",
  kind: "recording",
  name: "Booking a flight",
  mime: "application/x-psyche-recording",
  path: "recordings/rec_1",
  size: 10,
  sha256: "sha256:00",
  origin: "agent",
  threadId: null,
  taskId: null,
  tags: [],
  textExtractRef: null,
  createdAt: "2026-11-18T10:00:00.000Z",
} as LibraryItem;

const at = (s: number) => `2026-11-18T10:00:0${s}.000Z`;

const RECORDING: MockBrowserRecording = {
  recording: {
    id: "rec_1",
    taskId: null,
    threadId: null,
    startedAt: at(0),
    endedAt: at(3),
    frameCount: 2,
    eventCount: 3,
    bytes: 10,
    libraryItemId: ITEM.id,
    runId: null,
  },
  events: [
    {
      seq: 1,
      at: at(0),
      tabId: "t1",
      kind: "navigation",
      summary: "Opened example.com",
      url: "https://example.com/",
      frameSeq: 1,
    },
    {
      seq: 2,
      at: at(1),
      tabId: "t1",
      kind: "action",
      summary: 'Clicked button "Search"',
      action: "click",
    },
    {
      seq: 3,
      at: at(2),
      tabId: "t1",
      kind: "navigation",
      summary: "Opened example.com/results",
      url: "https://example.com/results",
      frameSeq: 2,
    },
  ],
  frames: [
    {
      frame: { seq: 1, at: at(0), tabId: "t1", url: "https://example.com/" },
      mime: "image/png",
      data: "AAAA",
    },
    {
      frame: { seq: 2, at: at(2), tabId: "t1", url: "https://example.com/results" },
      mime: "image/png",
      data: "BBBB",
    },
  ],
};

function setup(
  recordings: MockBrowserRecording[] = [RECORDING],
  slots?: { navigate?: (route: string) => void },
) {
  let gw: MockGateway | null = null;
  const onClose = vi.fn();
  render(
    <StoryWorld
      {...(slots === undefined ? {} : { slots })}
      onGateway={(g) => {
        gw = g;
        g.world.browserRecordings = recordings;
      }}
    >
      <BrowserRecordingViewer item={ITEM} onClose={onClose} />
    </StoryWorld>,
  );
  return { gateway: () => gw as unknown as MockGateway, onClose };
}

describe("frameFor", () => {
  it("uses the step's own frame, else the latest earlier one, else none", () => {
    const events = RECORDING.events;
    expect(frameFor(events, 0)).toBe(1);
    expect(frameFor(events, 1)).toBe(1);
    expect(frameFor(events, 2)).toBe(2);
    expect(frameFor([{ ...events[1]! }], 0)).toBeNull();
    expect(frameFor([], 0)).toBeNull();
  });
});

describe("Browser recording viewer", () => {
  it("shows the first step's frame and every step, and scrubbing moves the picture", async () => {
    setup();
    const dialog = await screen.findByRole("dialog");
    const img = (await within(dialog).findByRole("img")) as HTMLImageElement;
    expect(img.src).toBe("data:image/png;base64,AAAA");
    expect(within(dialog).getAllByText("Step 1 of 3").length).toBeGreaterThan(0);
    expect(within(dialog).getByText('Clicked button "Search"')).toBeTruthy();

    await userEvent.click(
      within(dialog).getByRole("button", { name: /Opened example.com\/results/ }),
    );
    await waitFor(() =>
      expect((within(dialog).getByRole("img") as HTMLImageElement).src).toBe(
        "data:image/png;base64,BBBB",
      ),
    );
    // A step with no frame of its own keeps the latest earlier picture.
    await userEvent.click(within(dialog).getByRole("button", { name: /Clicked button/ }));
    await waitFor(() =>
      expect((within(dialog).getByRole("img") as HTMLImageElement).src).toBe(
        "data:image/png;base64,AAAA",
      ),
    );
  });

  it("plays through the steps and stops on the last one", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      setup();
      const dialog = await screen.findByRole("dialog");
      await within(dialog).findByRole("img");
      await userEvent.click(within(dialog).getByRole("button", { name: "Play" }));
      await vi.advanceTimersByTimeAsync(2100);
      await waitFor(() =>
        expect(within(dialog).getAllByText("Step 3 of 3").length).toBeGreaterThan(0),
      );
      expect(within(dialog).getByRole("button", { name: "Play" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders page-influenced text as plain text, never as a link or markup", async () => {
    setup([
      {
        ...RECORDING,
        events: [
          {
            ...RECORDING.events[0]!,
            summary: "<img src=x onerror=alert(1)> https://evil.example/",
          },
        ],
      },
    ]);
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/<img src=x/)).toBeTruthy();
    expect(dialog.querySelector("a")).toBeNull();
    expect(dialog.querySelector("img[onerror]")).toBeNull();
  });

  it("says so when the recording is gone", async () => {
    setup([]);
    expect(await screen.findByText("This recording isn't available any more.")).toBeTruthy();
  });

  it("opens the task that made the recording, and closes the viewer", async () => {
    const navigate = vi.fn();
    const { onClose } = setup(
      [{ ...RECORDING, recording: { ...RECORDING.recording, taskId: "task_7" } }],
      {
        navigate,
      },
    );
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("img");
    await userEvent.click(within(dialog).getByRole("button", { name: "Open task" }));
    expect(navigate).toHaveBeenCalledWith("/agent/activity/task_7");
    expect(onClose).toHaveBeenCalled();
  });

  it("hides Open task when the recording has no task, but keeps Review in Permissions", async () => {
    setup([RECORDING], { navigate: vi.fn() });
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("img");
    expect(within(dialog).queryByRole("button", { name: "Open task" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Review in Permissions" })).toBeTruthy();
  });

  it("opens the Permissions screen from Review in Permissions", async () => {
    const navigate = vi.fn();
    const { onClose } = setup([RECORDING], { navigate });
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("img");
    await userEvent.click(within(dialog).getByRole("button", { name: "Review in Permissions" }));
    expect(navigate).toHaveBeenCalledWith("/settings/permissions");
    expect(onClose).toHaveBeenCalled();
  });

  it("offers neither link when the host has no navigation", async () => {
    setup([RECORDING]);
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("img");
    expect(within(dialog).queryByRole("button", { name: "Review in Permissions" })).toBeNull();
  });
});

describe("Library", () => {
  it("opens a recorded browser session in the replay viewer", async () => {
    render(
      <StoryWorld
        edit={(w) => {
          w.library.push(ITEM);
        }}
        onGateway={(g) => {
          g.world.browserRecordings = [RECORDING];
        }}
      >
        <LibraryScreen section="documents" now={Date.parse("2026-11-19T10:00:00Z")} />
      </StoryWorld>,
    );
    await userEvent.dblClick(await screen.findByRole("button", { name: /Open Booking a flight/ }));
    const viewer = await screen.findByTestId("recording-viewer");
    expect(await within(viewer).findByRole("img")).toBeTruthy();
  });
});
