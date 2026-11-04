import type { ThreadListEntry } from "@psyche/protocol";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import {
  ChatOutbox,
  GatewayProvider,
  GatewayStore,
  type OutboxStorage,
  useOutbox,
  useThread,
} from "../src/data/index.ts";
import { MockGateway } from "../src/data/mock-gateway.ts";

/**
 * A remote window's composer while the Host is unreachable (acceptance 6): what is sent waits,
 * shows as waiting, and reaches the Gateway once after the connection is back.
 */

const NOW = "2026-10-18T10:12:00Z";
const thread: ThreadListEntry = {
  thread: {
    id: "thr_main",
    kind: "main",
    title: "Main chat",
    titleSource: "auto",
    parentThreadId: null,
    forkedFromMessageId: null,
    sessionKey: "owner:main",
    personaOverlay: null,
    permissionMode: "balanced",
    modelRef: null,
    pinned: false,
    archivedAt: null,
    expiresAt: null,
    activeWriterRunId: null,
    createdAt: NOW,
    updatedAt: NOW,
    lastMessageAt: NOW,
  },
  activity: { running: 0, awaitingInput: 0, awaitingApproval: 0 },
};

function memoryStorage(): OutboxStorage {
  const data = new Map<string, string>();
  return { get: (k) => data.get(k) ?? null, set: (k, v) => void data.set(k, v) };
}

function setup(withOutbox: boolean) {
  const gateway = new MockGateway({ threads: [thread] }, { now: () => NOW });
  const outbox = withOutbox ? new ChatOutbox(memoryStorage()) : undefined;
  const store = new GatewayStore(gateway, { now: () => NOW, ...(outbox ? { outbox } : {}) });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <GatewayProvider client={gateway} store={store}>
      {children}
    </GatewayProvider>
  );
  return { gateway, outbox, store, wrapper };
}

const sends = (g: MockGateway) => g.calls.filter((c) => c.method === "chat.send");

describe("sending while the Gateway is unreachable", () => {
  it("waits in the outbox, shows as waiting, and goes out once on reconnect", async () => {
    const { gateway, outbox, wrapper } = setup(true);
    const { result } = renderHook(() => ({ t: useThread("thr_main"), o: useOutbox("thr_main") }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.t.loading).toBe(false));
    act(() => gateway.setConnection("offline"));

    await act(() => result.current.t.send("remind me at five"));
    expect(sends(gateway)).toHaveLength(0);
    expect(result.current.o.enabled).toBe(true);
    expect(result.current.o.waiting.map((w) => w.params.content)).toEqual(["remind me at five"]);
    const key = outbox?.items()[0]?.key;

    act(() => gateway.setConnection("connecting"));
    act(() => gateway.setConnection("open"));
    await waitFor(() => expect(sends(gateway)).toHaveLength(1));
    expect(sends(gateway)[0]).toMatchObject({ params: { content: "remind me at five" } });
    expect(sends(gateway)[0]?.idempotencyKey).toBe(key);
    await waitFor(() => expect(result.current.o.waiting).toEqual([]));

    // Another reconnect does not send it again.
    act(() => gateway.setConnection("offline"));
    act(() => gateway.setConnection("connecting"));
    act(() => gateway.setConnection("open"));
    await new Promise((r) => setTimeout(r, 30));
    expect(sends(gateway)).toHaveLength(1);
  });

  it("lets the owner take a waiting message back", async () => {
    const { gateway, wrapper } = setup(true);
    const { result } = renderHook(() => ({ t: useThread("thr_main"), o: useOutbox("thr_main") }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.t.loading).toBe(false));
    act(() => gateway.setConnection("offline"));
    await act(() => result.current.t.send("never mind"));
    const key = result.current.o.waiting[0]?.key as string;
    act(() => result.current.o.remove(key));
    await waitFor(() => expect(result.current.o.waiting).toEqual([]));
    act(() => gateway.setConnection("open"));
    await new Promise((r) => setTimeout(r, 30));
    expect(sends(gateway)).toHaveLength(0);
  });

  it("is off where no outbox is set (This Mac and the web keep their disabled composer)", async () => {
    const { gateway, wrapper } = setup(false);
    const { result } = renderHook(() => useOutbox("thr_main"), { wrapper });
    expect(result.current.enabled).toBe(false);
    act(() => gateway.setConnection("offline"));
    expect(result.current.waiting).toEqual([]);
  });
});
