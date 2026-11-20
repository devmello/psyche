import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ImportDialog, type ImportSummary } from "../src/agent/ImportDialog.tsx";

/** The import choice: "Memories only" or "Memories and conversations" (synthetic files). */

const file = (name: string, text: string) => new File([text], name, { type: "application/json" });
const summary: ImportSummary = {
  memories: 2,
  threads: 3,
  duplicates: 1,
  skipped: [{ title: "Big chat", reason: "too_large" }],
  skippedMore: 0,
};

function setup() {
  const run = vi.fn(async (_req: unknown, onStage: (s: "memories" | "conversations") => void) => {
    onStage("memories");
    onStage("conversations");
    return summary;
  });
  const user = userEvent.setup();
  render(<ImportDialog open onOpenChange={() => {}} run={run} />);
  return { run, user };
}

describe("ImportDialog", () => {
  it("offers both choices, Memories only first", async () => {
    setup();
    const memoriesOnly = await screen.findByRole("radio", { name: "Memories only" });
    expect((memoriesOnly as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("radio", { name: "Memories and conversations" })).toBeTruthy();
    expect(screen.queryByLabelText(/Conversations file/)).toBeNull();
    expect((screen.getByRole("button", { name: "Import" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("Memories only sends just the memory file", async () => {
    const { run, user } = setup();
    await user.upload(await screen.findByLabelText("Memories file"), file("memories.json", "[]"));
    await user.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(run).toHaveBeenCalled());
    expect(run.mock.calls[0]?.[0]).toEqual({ source: "claude", mode: "memories", memories: "[]" });
  });

  it("Memories and conversations needs the conversations file, then shows a summary", async () => {
    const { run, user } = setup();
    await user.click(await screen.findByRole("radio", { name: "ChatGPT" }));
    await user.click(screen.getByRole("radio", { name: "Memories and conversations" }));
    expect((screen.getByRole("button", { name: "Import" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await user.upload(
      screen.getByLabelText(/Conversations file/),
      file("conversations.json", "[]"),
    );
    await user.click(screen.getByRole("button", { name: "Import" }));
    expect(await screen.findByText("Conversations imported: 3")).toBeTruthy();
    expect(screen.getByText("Already imported before: 1")).toBeTruthy();
    expect(screen.getByText("Conversations skipped: 1")).toBeTruthy();
    expect(screen.getByText(/Big chat: too long/)).toBeTruthy();
    expect(run.mock.calls[0]?.[0]).toEqual({
      source: "chatgpt",
      mode: "both",
      conversations: "[]",
    });
  });

  it("says why an import failed", async () => {
    const run = vi.fn(async () => {
      throw new Error("boom");
    });
    const user = userEvent.setup();
    render(<ImportDialog open onOpenChange={() => {}} run={run} />);
    await user.upload(await screen.findByLabelText("Memories file"), file("m.json", "[]"));
    await user.click(screen.getByRole("button", { name: "Import" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Couldn't import this file/);
  });

  it("refuses a memory file too big for one message, without calling the Gateway", async () => {
    const { run, user } = setup();
    const big = file("memories.json", "x".repeat(900_001));
    await user.upload(await screen.findByLabelText("Memories file"), big);
    await user.click(screen.getByRole("button", { name: "Import" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/900 KB/);
    expect(run).not.toHaveBeenCalled();
  });

  it("measures the escaped size: a quote-dense file under 900 KB raw is still refused", async () => {
    const { run, user } = setup();
    await user.upload(
      await screen.findByLabelText("Memories file"),
      file("memories.json", '"'.repeat(600_000)),
    );
    await user.click(screen.getByRole("button", { name: "Import" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/900 KB/);
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps what was imported when a step failed and offers to import again", async () => {
    const partial: ImportSummary = {
      memories: 0,
      threads: 2,
      duplicates: 0,
      skipped: [],
      skippedMore: 0,
      error: "gateway went away",
      batchesDone: 1,
      batchesTotal: 3,
    };
    const run = vi.fn(async () => partial);
    const user = userEvent.setup();
    render(<ImportDialog open onOpenChange={() => {}} run={run} />);
    await user.click(await screen.findByRole("radio", { name: "Memories and conversations" }));
    await user.upload(screen.getByLabelText(/Conversations file/), file("c.json", "[]"));
    await user.click(screen.getByRole("button", { name: "Import" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/1 of 3 batches/);
    expect(screen.getByText("Conversations imported: 2")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Import again" }));
    expect(run).toHaveBeenCalledTimes(2);
  });
});
