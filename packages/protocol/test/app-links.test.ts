import { describe, expect, it } from "vitest";
import {
  chatLinkRoute,
  MEMORY_REVIEW_ROUTE,
  runLinkRoute,
  SCHEDULED_RUNS_ROUTE,
} from "../src/index.ts";

describe("notification links", () => {
  it("builds the chat link with the message or the approval card to land on", () => {
    expect(chatLinkRoute({ threadId: "th_1" })).toBe("/chat/th_1");
    expect(chatLinkRoute({ threadId: "th_1", messageId: "m_2" })).toBe("/chat/th_1?message=m_2");
    expect(chatLinkRoute({ threadId: "th_1", approvalId: "ap_3" })).toBe(
      "/chat/th_1?approval=ap_3",
    );
    // A message wins over an approval: it is the more specific place.
    expect(chatLinkRoute({ threadId: "th_1", messageId: "m_2", approvalId: "ap_3" })).toBe(
      "/chat/th_1?message=m_2",
    );
  });

  it("encodes ids and names the run, Scheduled → Runs and Memory → Review routes", () => {
    expect(chatLinkRoute({ threadId: "a/b?c" })).toBe("/chat/a%2Fb%3Fc");
    expect(runLinkRoute("run_1")).toBe("/overview/run/run_1");
    expect(SCHEDULED_RUNS_ROUTE).toBe("/scheduled?tab=runs");
    expect(MEMORY_REVIEW_ROUTE).toBe("/settings/memory");
  });
});
