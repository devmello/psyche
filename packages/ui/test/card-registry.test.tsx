import type { Block, Message } from "@psyche/protocol";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Card } from "../src/blocks/card.tsx";
import { MessageBlocks } from "../src/blocks/MessageBlocks.tsx";
import {
  blockRenderer,
  RegisteredBlock,
  registerBlock,
  registerToolView,
  toolViewFor,
} from "../src/blocks/registry.tsx";
import {
  fromApprovalStatus,
  fromStepStatus,
  fromTaskStatus,
  fromToolCallStatus,
} from "../src/index.tsx";

const message = (blocks: Block[]): Message =>
  ({ id: "msg_1", role: "agent", blocks, provenance: "trusted" }) as unknown as Message;
const ctx = { message: message([]), pinChecklist: false, untrusted: false };

describe("status adapters", () => {
  it("maps every source onto the one vocabulary", () => {
    expect(fromToolCallStatus("ok")).toEqual({ status: "done" });
    expect(fromToolCallStatus("uncertain")).toEqual({ status: "done", warning: true });
    expect(fromToolCallStatus("blocked")).toEqual({ status: "blocked" });
    expect(fromTaskStatus("queued")).toEqual({ status: "pending" });
    expect(fromTaskStatus("awaiting_approval")).toEqual({ status: "waiting" });
    expect(fromTaskStatus("paused")).toEqual({ status: "waiting" });
    expect(fromApprovalStatus("approved")).toEqual({ status: "done" });
    expect(fromApprovalStatus("expired")).toEqual({ status: "cancelled" });
    expect(fromStepStatus("skipped")).toEqual({ status: "cancelled" });
  });
});

describe("Card", () => {
  it("puts the primary action last and reports its kind", () => {
    const open = vi.fn();
    render(
      <Card
        label="Doc"
        title="Doc"
        status={{ status: "done" }}
        actions={[
          { id: "open", label: "Open", kind: "open", primary: true, onSelect: open },
          { id: "copy", label: "Copy", kind: "send", onSelect: () => {} },
        ]}
      />,
    );
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Copy", "Open"]);
    expect(buttons[1]?.dataset.actionKind).toBe("open");
    buttons[1]?.click();
    expect(open).toHaveBeenCalledOnce();
    expect(screen.getByRole("article", { name: "Doc" }).dataset.status).toBe("done");
  });
});

describe("block registry", () => {
  afterEach(() => vi.restoreAllMocks());

  it("registers every built-in block type", () => {
    for (const type of [
      "text",
      "tool_call",
      "plan",
      "checklist",
      "approval",
      "question",
      "artifact",
      "file",
      "receipt",
      "task",
      "wrap_up",
      "related_threads",
      "compaction",
      "learned",
      "taught",
    ] as const)
      expect(blockRenderer(type), type).toBeDefined();
  });

  it("renders an unknown type as a fallback card", () => {
    render(<RegisteredBlock block={{ type: "hologram" } as unknown as Block} ctx={ctx} />);
    expect(screen.getByTestId("unknown-block").textContent).toContain("hologram");
  });

  it("lets a registration override and restore a renderer", () => {
    const restore = registerBlock("text", { View: ({ block }) => <p>custom {block.md}</p> });
    render(<MessageBlocks message={message([{ type: "text", md: "hi" }])} />);
    expect(screen.getByText("custom hi")).toBeTruthy();
    restore();
    expect(blockRenderer("text")?.View).not.toBeUndefined();
  });
});

describe("tool views", () => {
  it("resolves by tool name, then result kind", () => {
    const A = () => null;
    const B = () => null;
    const offA = registerToolView("calendar.list", A);
    const offB = registerToolView("kind:mail", B);
    expect(toolViewFor("calendar.list")).toBe(A);
    expect(toolViewFor("mail.search", "mail")).toBe(B);
    expect(toolViewFor("other")).toBeUndefined();
    offA();
    offB();
    expect(toolViewFor("calendar.list")).toBeUndefined();
  });
});
