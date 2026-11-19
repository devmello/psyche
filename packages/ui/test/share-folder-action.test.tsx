import type { RunStep, ToolCall } from "@psyche/protocol";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { outsideFolderPath, ShareFolderForCall } from "../src/blocks/ShareFolderAction.tsx";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { FIXTURE_NOW, type FixtureWorld } from "../src/fixtures/index.ts";
import { StoryWorld } from "../src/stories/harness.tsx";

/**
 * The share button on a file tool's "outside every granted folder" error: it shows only for that
 * error on a file tool, calls `files.requestShare` once, and says "Shared" when the grant landed.
 * It never retries the tool.
 */

const OUTSIDE = {
  code: "forbidden",
  message: "/Users/ada/Projects/app/notes.txt is outside every granted folder",
  retryable: false,
};

function setup(
  error: RunStep["error"],
  tool = "read_file",
  share: "pending" | "already" = "pending",
) {
  let gateway: MockGateway | undefined;
  let call: ToolCall | undefined;
  const edit = (world: FixtureWorld) => {
    const run = world.runs[0];
    if (run === undefined) throw new Error("no run fixture");
    const step: RunStep = {
      id: "stp_share_1",
      runId: run.id,
      seq: 900,
      kind: "tool",
      status: "failed",
      label: "Reading notes.txt",
      startedAt: FIXTURE_NOW,
      endedAt: FIXTURE_NOW,
      attempt: 1,
      ...(error === undefined ? {} : { error }),
    };
    world.runSteps = [...(world.runSteps ?? []), step];
    call = {
      id: "tc_share_1",
      runId: run.id,
      stepId: step.id,
      tool,
      status: "failed",
    } as ToolCall;
  };
  render(
    <StoryWorld
      edit={edit}
      onGateway={(g) => {
        gateway = g;
        g.shareAnswer = share;
      }}
    >
      <Row get={() => call} />
    </StoryWorld>,
  );
  return () => gateway as MockGateway;
}

function Row({ get }: { get: () => ToolCall | undefined }) {
  const call = get();
  return call === undefined ? null : <ShareFolderForCall call={call} />;
}

const BUTTON = /share this folder \(read only\)/i;

describe("outsideFolderPath", () => {
  it("matches only the outside-folder error of a file tool", () => {
    expect(outsideFolderPath("read_file", OUTSIDE)).toBe("/Users/ada/Projects/app/notes.txt");
    expect(outsideFolderPath("list_dir", OUTSIDE)).toBe("/Users/ada/Projects/app/notes.txt");
    // Not a file tool.
    expect(outsideFolderPath("exec_host", OUTSIDE)).toBeNull();
    // Another error on a file tool.
    expect(
      outsideFolderPath("read_file", { ...OUTSIDE, message: "/x is granted read-only" }),
    ).toBeNull();
    expect(outsideFolderPath("write_file", { ...OUTSIDE, message: "no such file" })).toBeNull();
    expect(outsideFolderPath("read_file", { ...OUTSIDE, code: "not_found" })).toBeNull();
    expect(outsideFolderPath("read_file", undefined)).toBeNull();
  });
});

describe("ShareFolderForCall", () => {
  it("shows the button on the outside-folder error and calls the method once", async () => {
    const user = userEvent.setup();
    const gateway = setup(OUTSIDE);
    const button = await screen.findByRole("button", { name: BUTTON });
    await user.click(button);
    await waitFor(() => expect(gateway().shareRequests).toHaveLength(1));
    expect(gateway().shareRequests[0]).toMatchObject({
      path: "/Users/ada/Projects/app/notes.txt",
      access: "read",
    });
    // The card is up: the row waits, and the button is gone (no second call).
    expect(await screen.findByText(/waiting for your answer/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: BUTTON })).toBeNull();
    expect(gateway().shareRequests).toHaveLength(1);
  });

  it("says Shared once the folder is covered, and does not retry the tool", async () => {
    const user = userEvent.setup();
    const gateway = setup(OUTSIDE, "read_file", "already");
    await user.click(await screen.findByRole("button", { name: BUTTON }));
    expect(await screen.findByText("Shared. Ask again to continue")).toBeTruthy();
    expect(gateway().shareRequests).toHaveLength(1);
  });

  it("shows nothing for another error, another tool, or a call that did not fail", async () => {
    setup({ ...OUTSIDE, message: "/x is granted read-only" });
    setup(OUTSIDE, "exec_host");
    // Let the step load, then check no button appeared.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("button", { name: BUTTON })).toBeNull();
  });
});
