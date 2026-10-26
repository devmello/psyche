import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * No hand-rolled card chrome in transcript surfaces (docs/design/chat-experience-2026.md §4.1,
 * §4.7 phase 1): new cards use `Card` from `blocks/card.tsx`. The old generation
 * (`border-gray-6 bg-gray-2`) is gone; the level-1 surface (`bg-surface-raised` +
 * `shadow-elevation-1`) appears only in the shell and in the files listed here, each with the
 * reason it keeps its own chrome. Shrink this list as cards migrate; never grow it.
 */
const ALLOWED: Record<string, string> = {
  "blocks/card.tsx": "the shell itself",
  "blocks/ApprovalCard.tsx": "the dock card morphs into the transcript row (layoutId)",
  "blocks/QuestionCard.tsx": "multi-step form inside the dock; migrates with the dock",
  "blocks/Checklist.tsx": "the pinned checklist is a list surface, not a card",
  "chat/ApprovalDock.tsx": "dock container above the composer",
  "chat/FollowUpQueue.tsx": "composer-attached queue",
  "chat/RunFailure.tsx": "role=alert with a details disclosure",
  "chat/Thread.tsx": "composer and thread chrome",
  "chat/ThreadChrome.tsx": "thread header chrome",
  "people/EntityCard.tsx": "people sheet cards; Output-class migration (phase 6)",
  "people/SuggestionCard.tsx": "people sheet cards; Output-class migration (phase 6)",
  "specialists/FeedResults.tsx": "Feed surface; specialist results become blocks in phase 6",
  "specialists/ResultCard.tsx": "specialist results; phase 6 (`specialist_result` block)",
  "teaching/ReceiptFeedback.tsx": "popover surface",
  "voice/controls.tsx": "voice capsule, outside the transcript",
};

const ROOTS = ["blocks", "chat", "specialists", "teaching", "people", "screen-ask", "voice"];
const src = join(import.meta.dirname, "../src");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? files(join(dir, e.name))
      : e.name.endsWith(".tsx") && !e.name.endsWith(".stories.tsx")
        ? [join(dir, e.name)]
        : [],
  );
}

const all = ROOTS.flatMap((r) => files(join(src, r))).map((f) => ({
  path: relative(src, f),
  text: readFileSync(f, "utf8"),
}));

describe("card chrome lint", () => {
  it("has no old-generation card chrome", () => {
    expect(
      all.filter((f) => f.text.includes("border-gray-6 bg-gray-2")).map((f) => f.path),
    ).toEqual([]);
  });

  it("keeps the level-1 surface in the shell and the allowlist only", () => {
    const offenders = all
      .filter((f) => f.text.includes("bg-surface-raised") && f.text.includes("shadow-elevation-1"))
      .map((f) => f.path)
      .filter((p) => !(p in ALLOWED));
    expect(offenders, "use <Card> from blocks/card.tsx").toEqual([]);
  });

  it("has no stale allowlist entries", () => {
    const using = new Set(
      all.filter((f) => f.text.includes("bg-surface-raised")).map((f) => f.path),
    );
    expect(Object.keys(ALLOWED).filter((p) => !using.has(p))).toEqual([]);
  });
});
