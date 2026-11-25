import type { LibraryItem } from "@psyche/protocol";
import { describe, expect, it, vi } from "vitest";
import { GatewayStore } from "../src/data/index.ts";
import { MockGateway } from "../src/data/mock-gateway.ts";
import { replaceLibraryWindow } from "../src/data/state.ts";

const NOW = "2026-10-18T10:12:00Z";

function item(id: string, createdAt: string, kind: LibraryItem["kind"] = "document"): LibraryItem {
  return {
    id,
    kind,
    name: `${id}.txt`,
    mime: "text/plain",
    path: `uploads/${id}`,
    size: 1,
    sha256: "x",
    origin: "upload",
    threadId: null,
    taskId: null,
    tags: [],
    textExtractRef: null,
    createdAt,
  };
}

function setup() {
  const gateway = new MockGateway({}, { now: () => NOW });
  const store = new GatewayStore(gateway, { now: () => NOW });
  let seq = 100;
  const emit = (event: string, payload: unknown) => {
    seq += 1;
    (store as unknown as { onEvent(e: unknown): void }).onEvent({
      event,
      payload,
      seq,
      stateVersion: seq,
    });
  };
  const seed = (...keys: string[]) =>
    store.update((s) => ({
      ...s,
      queries: {
        ...s.queries,
        ...Object.fromEntries(
          keys.map((k) => [k, { data: {}, error: null, loading: false, version: 5 }]),
        ),
      },
    }));
  const stale = (key: string) => store.getState().queries[key]?.version === -1;
  return { store, emit, seed, stale };
}

describe("store: events that refresh read queries", () => {
  it("settings.changed reloads settings.get reads of that key and of all settings, not other keys", () => {
    const { emit, seed, stale } = setup();
    const helper = `settings.get:${JSON.stringify({ keys: ["devices.helper.availability"] })}`;
    const other = `settings.get:${JSON.stringify({ keys: ["theme"] })}`;
    const all = `settings.get:${JSON.stringify({})}`;
    seed(helper, other, all);
    emit("settings.changed", {
      entries: [{ key: "devices.helper.availability", value: "offline", updatedAt: NOW }],
    });
    expect(stale(helper)).toBe(true);
    expect(stale(all)).toBe(true);
    expect(stale(other)).toBe(false);
  });

  it.each([
    ["channels.updated", { channel: {} }, "channels.list:{}"],
    ["pairing.requested", { pairingRequest: {} }, "channels.list:{}"],
    ["pairing.requested", { pairingRequest: {} }, "devices.list:{}"],
    [
      "persona.updated",
      { identity: {}, changed: [], avatarRequested: false },
      "memory.persona.get:{}",
    ],
    ["vault.locked", { reason: "manual", status: {} }, "vault.status:{}"],
    ["vault.unlocked", { via: "keychain", status: {} }, "vault.status:{}"],
    ["plugins.changed", { name: "p", change: "enabled" }, "plugins.list:{}"],
  ])("%s marks %s stale, and an unrelated query stays", (event, payload, key) => {
    const { emit, seed, stale } = setup();
    seed(key, "tasks.list:{}");
    emit(event, payload);
    expect(stale(key)).toBe(true);
    expect(stale("tasks.list:{}")).toBe(false);
  });

  it("vault events leave the 1Password setup read alone", () => {
    const { emit, seed, stale } = setup();
    seed("vault.onePassword.status:{}");
    emit("vault.unlocked", { via: "keychain", status: {} });
    expect(stale("vault.onePassword.status:{}")).toBe(false);
  });
});

describe("store: library.item.changed", () => {
  it("deleted removes the item, and a list that started earlier does not bring it back", () => {
    const { store, emit } = setup();
    store.update((s) => ({
      ...s,
      library: { a: item("a", "2026-10-01T00:00:00Z"), b: item("b", "2026-10-02T00:00:00Z") },
    }));
    const before = store.version();
    emit("library.item.changed", { itemId: "a", change: "deleted" });
    expect(Object.keys(store.getState().library)).toEqual(["b"]);
    const late = replaceLibraryWindow(
      store.getState(),
      [item("a", "2026-10-01T00:00:00Z"), item("b", "2026-10-02T00:00:00Z")],
      { filtered: false, hasMore: false },
      before,
    );
    expect(Object.keys(late.library)).toEqual(["b"]);
  });

  it("updated drops the held copy and reruns the open Library loaders; created reruns them too", () => {
    const { store, emit } = setup();
    const list = vi.fn(async () => {});
    const other = vi.fn(async () => {});
    store.registerRefresher('library:{"kind":"document"}', list);
    store.registerRefresher("feed", other);
    store.update((s) => ({ ...s, library: { a: item("a", "2026-10-01T00:00:00Z") } }));
    emit("library.item.changed", { itemId: "a", change: "updated" });
    expect(store.getState().library.a).toBeUndefined();
    expect(list).toHaveBeenCalledTimes(1);
    emit("library.item.changed", { itemId: "n", change: "created" });
    expect(list).toHaveBeenCalledTimes(2);
    expect(other).not.toHaveBeenCalled();
  });

  it("deleted does not rerun loaders (nothing new to fetch)", () => {
    const { store, emit } = setup();
    const list = vi.fn(async () => {});
    store.registerRefresher("library:{}", list);
    emit("library.item.changed", { itemId: "a", change: "deleted" });
    expect(list).not.toHaveBeenCalled();
  });
});

describe("replaceLibraryWindow", () => {
  const all = [
    item("c", "2026-10-03T00:00:00Z"),
    item("b", "2026-10-02T00:00:00Z", "image"),
    item("a", "2026-10-01T00:00:00Z"),
  ];
  const withAll = () => {
    const { store } = setup();
    store.update((s) => ({ ...s, library: Object.fromEntries(all.map((i) => [i.id, i])) }));
    return store.getState();
  };
  const [c, , a] = all as [LibraryItem, LibraryItem, LibraryItem];

  it("a complete unfiltered list drops ghosts", () => {
    const r = replaceLibraryWindow(withAll(), [c], { filtered: false, hasMore: false }, 9);
    expect(Object.keys(r.library)).toEqual(["c"]);
  });

  it("a kind list only drops ghosts of that kind", () => {
    const r = replaceLibraryWindow(
      withAll(),
      [c],
      { kind: "document", filtered: false, hasMore: false },
      9,
    );
    expect(Object.keys(r.library).sort()).toEqual(["b", "c"]);
  });

  it("a first page with more behind it keeps older items and drops ghosts inside the window", () => {
    const kept = replaceLibraryWindow(withAll(), [c], { filtered: false, hasMore: true }, 9);
    expect(Object.keys(kept.library).sort()).toEqual(["a", "b", "c"]);
    // The page holds c and a: b lies between them yet is missing, so it is a ghost.
    const dropped = replaceLibraryWindow(withAll(), [c, a], { filtered: false, hasMore: true }, 9);
    expect(Object.keys(dropped.library).sort()).toEqual(["a", "c"]);
  });

  it("a filtered list never drops anything", () => {
    const r = replaceLibraryWindow(withAll(), [], { filtered: true, hasMore: false }, 9);
    expect(Object.keys(r.library).sort()).toEqual(["a", "b", "c"]);
  });

  it("keeps an item an event touched after the list was requested", () => {
    const s = withAll();
    const r = replaceLibraryWindow(
      { ...s, touched: { "library:b": 20 } },
      [],
      { filtered: false, hasMore: false },
      9,
    );
    expect(Object.keys(r.library)).toEqual(["b"]);
  });
});
