import { describe, expect, it } from "vitest";
import { appendMessage, createThread, getMessage } from "../src/index.ts";
import { memoryDb } from "./helpers.ts";

describe("messages.via (voice conversation)", () => {
  it("stores via: voice for a spoken message and nothing for a typed one", () => {
    const db = memoryDb();
    const thread = createThread(db, { kind: "main", sessionKey: "owner:main" });
    const base = {
      threadId: thread.id,
      role: "user" as const,
      blocks: [{ type: "text" as const, md: "what's on today" }],
      provenance: "owner" as const,
    };
    const spoken = appendMessage(db, { ...base, via: "voice" }, { expectedWriterRunId: null });
    const typed = appendMessage(db, base, { expectedWriterRunId: null });
    expect(spoken.via).toBe("voice");
    expect("via" in typed).toBe(false);
    expect(getMessage(db, spoken.id)?.via).toBe("voice");
    expect(getMessage(db, typed.id)?.via).toBeUndefined();
  });
});
