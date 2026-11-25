import type { Task } from "@psyche/protocol";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { GatewayProvider, GatewayStore, useLoadRemaining, useTasks } from "../src/data/index.ts";
import { MockGateway } from "../src/data/mock-gateway.ts";

const NOW = "2026-10-18T10:12:00Z";
const ROWS = 300;

type Handler = (params: Record<string, unknown>) => unknown;

function servePage(rows: readonly unknown[], key: string, params: Record<string, unknown>) {
  const start = typeof params.cursor === "string" ? Number(params.cursor) : 0;
  const end = Math.min(rows.length, start + 50);
  return { [key]: rows.slice(start, end), nextCursor: end < rows.length ? String(end) : null };
}

describe("useLoadRemaining cap", () => {
  it("stops after maxPages so a picker cannot load an unbounded list", async () => {
    const gateway = new MockGateway({}, { now: () => NOW });
    const store = new GatewayStore(gateway, { now: () => NOW });
    const rows = Array.from({ length: ROWS }, (_, i) => ({
      id: `task_${i}`,
      threadId: "thr_main",
      title: `Task ${i}`,
      goal: "Goal",
      status: "done",
      createdFrom: "chat",
      plan: null,
      checklist: [],
      currentStepId: null,
      attempt: 1,
      leaseOwner: null,
      leaseUntil: null,
      browserSessionId: null,
      sandboxId: null,
      summary: null,
      outcome: null,
      createdAt: NOW,
      updatedAt: new Date(Date.parse(NOW) - i * 1000).toISOString(),
      completedAt: null,
    })) as unknown as Task[];
    (gateway as unknown as { handlers: Record<string, Handler> }).handlers["tasks.list"] = (p) =>
      servePage(rows, "tasks", p);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <GatewayProvider client={gateway} store={store}>
        {children}
      </GatewayProvider>
    );
    const { result } = renderHook(
      () => {
        const tasks = useTasks();
        useLoadRemaining(tasks, 2);
        return tasks;
      },
      { wrapper },
    );
    await waitFor(() => expect(result.current.all).toHaveLength(150));
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.all).toHaveLength(150);
    expect(result.current.hasMore).toBe(true);
  });
});
