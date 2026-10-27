import type { Block, Message } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { blocksToShow, indexThreadBlocks } from "../src/blocks/thread-blocks.tsx";

const question = (id: string): Block => ({ type: "question", inputRequestId: id });
const message = (id: string, blocks: Block[]) =>
  ({ id, threadId: "t", seq: 0, role: "agent", blocks }) as unknown as Message;

describe("question cards", () => {
  it("shows one card when a message stored the same question twice", () => {
    const m = message("m1", [
      { type: "text", md: "Which role?" },
      question("inp_1"),
      question("inp_1"),
    ]);
    const shown = blocksToShow(m, indexThreadBlocks([m]));
    expect(shown.filter((b) => b.type === "question")).toHaveLength(1);
    expect(shown.filter((b) => b.type === "text")).toHaveLength(1);
  });

  it("shows a question once across messages, and keeps different questions", () => {
    const a = message("m1", [question("inp_1")]);
    const b = message("m2", [question("inp_1"), question("inp_2")]);
    const index = indexThreadBlocks([a, b]);
    expect(blocksToShow(a, index)).toEqual([question("inp_1")]);
    expect(blocksToShow(b, index)).toEqual([question("inp_2")]);
  });
});
