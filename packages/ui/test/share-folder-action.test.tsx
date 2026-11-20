import type { ToolCall } from "@psyche/protocol";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { outsideFolderPath, ShareFolderForCall } from "../src/blocks/ShareFolderAction.tsx";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import type { FixtureWorld } from "../src/fixtures/index.ts";
import { StoryWorld } from "../src/stories/harness.tsx";

/**
 * The share button under a file tool the permission engine denied for being outside every
 * granted folder. The fixture is the shape a real Gateway stores for that call (pinned by
 * apps/gateway/test/files-denied-shape.test.ts): `blocked`, rule `folder:not_granted`, the path as
 * target. The button shows only for that, to admin devices, and calls `files.requestShare` once.
 */

const PATH = "/Users/ada/Projects/app/notes.txt";

const denied = (over: Partial<ToolCall> = {}): ToolCall =>
  ({
    id: "tc_share_1",
    runId: "run_x",
    tool: "read_file",
    status: "blocked",
    decision: "deny",
    decisionRule: "folder:not_granted",
    target: { kind: "path", value: PATH },
    ...over,
  }) as ToolCall;

function setup(
  over: Partial<ToolCall> = {},
  opts: { share?: "pending" | "already"; admin?: boolean } = {},
) {
  let gateway: MockGateway | undefined;
  let call = denied(over);
  render(
    <StoryWorld
      edit={(world: FixtureWorld) => {
        const run = world.runs[0];
        if (run === undefined) throw new Error("no run fixture");
        call = { ...call, runId: run.id };
      }}
      onGateway={(g) => {
        gateway = g;
        g.shareAnswer = opts.share ?? "pending";
        g.admin = opts.admin ?? true;
      }}
    >
      <Row get={() => call} />
    </StoryWorld>,
  );
  return () => gateway as MockGateway;
}

function Row({ get }: { get: () => ToolCall }) {
  return <ShareFolderForCall call={get()} />;
}

const BUTTON = /share this folder \(read only\)/i;
const settle = () => new Promise((r) => setTimeout(r, 50));

describe("outsideFolderPath", () => {
  it("reads the Gateway's fields, and nothing else", () => {
    expect(outsideFolderPath(denied())).toBe(PATH);
    expect(outsideFolderPath(denied({ tool: "list_dir" }))).toBe(PATH);
    // Another tool, another rule, another status, no path target.
    expect(outsideFolderPath(denied({ tool: "exec_host" }))).toBeNull();
    expect(outsideFolderPath(denied({ tool: "write_file" }))).toBeNull();
    expect(outsideFolderPath(denied({ decisionRule: "folder:read_only" }))).toBeNull();
    expect(outsideFolderPath(denied({ decisionRule: null }))).toBeNull();
    expect(outsideFolderPath(denied({ status: "failed" }))).toBeNull();
    expect(outsideFolderPath(denied({ status: "ok" }))).toBeNull();
    expect(outsideFolderPath(denied({ target: null }))).toBeNull();
    expect(
      outsideFolderPath(denied({ target: { kind: "origin", value: "https://x.test" } })),
    ).toBeNull();
  });

  it("does not trust text: an error line that says so is not enough", () => {
    const call = { ...denied({ status: "failed", decisionRule: null, target: null }) } as ToolCall &
      Record<string, unknown>;
    call.level1 = `${PATH} is outside every granted folder`;
    expect(outsideFolderPath(call)).toBeNull();
  });
});

describe("ShareFolderForCall", () => {
  it("shows the button on a denied file tool and calls the method once", async () => {
    const user = userEvent.setup();
    const gateway = setup();
    await user.click(await screen.findByRole("button", { name: BUTTON }));
    expect(await screen.findByText(/waiting for your answer/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: BUTTON })).toBeNull();
    expect(gateway().shareRequests).toHaveLength(1);
    expect(gateway().shareRequests[0]).toMatchObject({ path: PATH, access: "read" });
  });

  it("says Shared once the folder is covered, and does not retry the tool", async () => {
    const user = userEvent.setup();
    const gateway = setup({}, { share: "already" });
    await user.click(await screen.findByRole("button", { name: BUTTON }));
    expect(await screen.findByText("Shared. Ask again to continue")).toBeTruthy();
    expect(gateway().shareRequests).toHaveLength(1);
  });

  it("shows nothing for other calls", async () => {
    setup({ status: "failed" });
    setup({ tool: "exec_host" });
    setup({ decisionRule: "folder:read_only" });
    await settle();
    expect(screen.queryByRole("button", { name: BUTTON })).toBeNull();
  });

  it("shows nothing on a device without operator.admin", async () => {
    setup({}, { admin: false });
    await settle();
    expect(screen.queryByRole("button", { name: BUTTON })).toBeNull();
  });
});
