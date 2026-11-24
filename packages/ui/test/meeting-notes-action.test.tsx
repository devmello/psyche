import type { LibraryItem } from "@psyche/protocol";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { isMeetingMedia, MeetingNotesAction } from "../src/screens/library/MeetingNotesAction.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

const AUDIO: LibraryItem = {
  id: "lib_audio_1",
  kind: "audio",
  name: "Planning call.m4a",
  mime: "audio/mp4",
  path: "uploads/planning-call.m4a",
  size: 4096,
  sha256: "sha256:00",
  origin: "upload",
  threadId: null,
  taskId: null,
  tags: [],
  textExtractRef: null,
  createdAt: "2026-11-18T10:00:00.000Z",
} as LibraryItem;

const DOCUMENT: LibraryItem = { ...AUDIO, id: "lib_doc_1", kind: "document", name: "notes.md" };

function setup(options: { latency?: number } = {}) {
  let gw: MockGateway | null = null;
  const navigate = vi.fn();
  render(
    <StoryWorld
      slots={{ navigate }}
      options={options.latency === undefined ? undefined : { latency: options.latency }}
      edit={(w) => {
        w.library.push(AUDIO);
      }}
      onGateway={(g) => {
        gw = g;
      }}
    >
      <MeetingNotesAction item={AUDIO} />
    </StoryWorld>,
  );
  return { navigate, gateway: () => gw as unknown as MockGateway };
}

describe("isMeetingMedia", () => {
  it("is true for audio and video items only", () => {
    expect(isMeetingMedia({ kind: "audio" })).toBe(true);
    expect(isMeetingMedia({ kind: "video" })).toBe(true);
    expect(isMeetingMedia({ kind: "document" })).toBe(false);
    expect(isMeetingMedia({ kind: "recording" })).toBe(false);
  });
});

describe("Make meeting notes", () => {
  it("renders nothing for a document", () => {
    const { container } = render(
      <StoryWorld>
        <MeetingNotesAction item={DOCUMENT} />
      </StoryWorld>,
    );
    expect(container.textContent).not.toContain("Make meeting notes");
    expect(screen.queryByRole("button", { name: "Make meeting notes" })).toBeNull();
  });

  it("disables the action while it runs, then links to the notes", async () => {
    const { navigate } = setup({ latency: 300 });
    await userEvent.click(screen.getByRole("button", { name: "Make meeting notes" }));
    const running = screen.getByRole("button", { name: "Make meeting notes" });
    expect((running as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("Making notes");

    const open = await screen.findByRole("button", { name: "Open notes" }, { timeout: 2000 });
    expect(screen.queryByRole("alert")).toBeNull();
    await userEvent.click(open);
    expect(navigate).toHaveBeenCalledWith("/home?post=post_meeting_notes_fixture");
  });

  it("shows the Gateway's refusal with Try again, and succeeds on retry", async () => {
    const { gateway } = setup();
    await waitFor(() => expect(gateway()).toBeTruthy());
    gateway().failNext("meetings.notes.create", "unavailable", "The Mac helper is offline.");

    await userEvent.click(screen.getByRole("button", { name: "Make meeting notes" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The Mac helper is offline.");
    expect(screen.queryByRole("button", { name: "Open notes" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Open notes" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
