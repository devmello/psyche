import type { MemoryMap } from "@psyche/protocol";
import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayProvider, GatewayStore, useGatewayQuery } from "../src/data/index.ts";
import { MockGateway } from "../src/data/mock-gateway.ts";
import type { FixtureWorld } from "../src/fixtures/index.ts";
import { FIXTURE_NOW } from "../src/fixtures/index.ts";
import { PEOPLE_IDS } from "../src/fixtures/people.ts";
import { MEMORY_MAP_ROUTE, parseMemoryView } from "../src/memory-page/kinds.ts";
import { MemoryScreen } from "../src/memory-page/MemoryScreen.tsx";
import { fitView, hitTest, zoomAt } from "../src/memory-page/map/map-draw.ts";
import { ForceLayout } from "../src/memory-page/map/map-layout.ts";
import {
  ALL_GROUPS,
  buildMapModel,
  focusModel,
  groupOf,
  isSparse,
  modelOverlap,
  neighbourhood,
  quietPeople,
  radiusOf,
  sameMap,
  searchNodes,
} from "../src/memory-page/map/map-model.ts";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

/** The memory map: view model, layout, drawing helpers and the Map view of the Memory page. */

type N = MemoryMap["nodes"][number];
const node = (id: string, kind: N["kind"], over: Partial<N> = {}): N => ({
  id,
  kind,
  name: id,
  weight: 0.5,
  lastInteractionAt: null,
  pinned: false,
  ...over,
});
const edge = (a: string, b: string, kind: MemoryMap["edges"][number]["kind"] = "co_mentioned") => ({
  a,
  b,
  kind,
  weight: 0.5,
});

const MAP: MemoryMap = {
  nodes: [
    node("sam", "person", { name: "Sam Lee", weight: 1 }),
    node("dana", "person", { name: "Dana Ortiz", weight: 0.8 }),
    node("zoë", "person", { name: "Zoë Ångström", weight: 0.3, quiet: true }),
    node("kit", "project", { name: "Kitchen remodel", weight: 0.7 }),
    node("lis", "event", { name: "Lisbon trip", weight: 0.4 }),
    node("rock", "topic", { name: "Climbing", weight: 0.2 }),
    node("acme", "org", { name: "Acme", weight: 0.3 }),
    node("far", "person", { name: "Far Away", weight: 0.1 }),
  ],
  edges: [
    edge("sam", "kit", "works_on"),
    edge("dana", "kit", "works_on"),
    edge("sam", "lis", "met_in"),
    edge("sam", "dana"),
    edge("dana", "rock", "related"),
    edge("rock", "far"),
  ],
  total: 8,
  truncated: false,
};

describe("map model", () => {
  it("folds kinds into five groups", () => {
    expect(groupOf("person")).toBe("people");
    expect(groupOf("assignment")).toBe("projects");
    expect(groupOf("project")).toBe("projects");
    expect(groupOf("event")).toBe("events");
    expect(groupOf("topic")).toBe("topics");
    expect(groupOf("org")).toBe("other");
    expect(groupOf("place")).toBe("other");
  });

  it("sizes by weight, within bounds", () => {
    expect(radiusOf(0)).toBeLessThan(radiusOf(0.5));
    expect(radiusOf(0.5)).toBeLessThan(radiusOf(1));
    expect(radiusOf(-3)).toBe(radiusOf(0));
    expect(radiusOf(9)).toBe(radiusOf(1));
  });

  it("filters by group and drops the links that lose an end", () => {
    const m = buildMapModel(MAP, { groups: new Set(["people", "projects"]) });
    expect(m.nodes.map((n) => n.id)).not.toContain("lis");
    expect(m.links).toHaveLength(3);
    expect(buildMapModel(MAP, { groups: ALL_GROUPS }).links).toHaveLength(6);
  });

  it("finds a neighbourhood by hops, and nothing for an unknown id", () => {
    const m = buildMapModel(MAP);
    const ids = (hops: number) =>
      neighbourhood(m, "sam", hops)
        .map((i) => m.nodes[i]?.id)
        .sort();
    expect(ids(1)).toEqual(["dana", "kit", "lis", "sam"]);
    expect(ids(2)).toContain("rock");
    expect(ids(2)).not.toContain("far");
    expect(neighbourhood(m, "nobody")).toEqual([]);
  });

  it("focus keeps the node and its neighbours, with only the links among them", () => {
    const f = focusModel(buildMapModel(MAP), "sam");
    expect(f.nodes.map((n) => n.id).sort()).toEqual(["dana", "kit", "lis", "sam"]);
    expect(f.links).toHaveLength(4);
    expect(f.truncated).toBe(false);
  });

  it("searches names ahead of substrings, ignoring case and accents", () => {
    const m = buildMapModel(MAP);
    expect(searchNodes(m, "sam")[0]?.id).toBe("sam");
    expect(searchNodes(m, "ZOE")[0]?.id).toBe("zoë");
    expect(searchNodes(m, "angstrom")[0]?.id).toBe("zoë");
    expect(searchNodes(m, "lee").map((n) => n.id)).toEqual(["sam"]);
    expect(searchNodes(m, "")).toEqual([]);
    expect(searchNodes(m, "zzz")).toEqual([]);
    // Prefix beats word-start beats substring.
    const p = buildMapModel({
      ...MAP,
      nodes: [
        node("a", "person", { name: "Marian Ortiz", weight: 1 }),
        node("b", "person", { name: "Ortiz Dana", weight: 0.1 }),
        node("c", "person", { name: "Pedro Portizo", weight: 0.9 }),
      ],
      edges: [],
    });
    expect(searchNodes(p, "ortiz").map((n) => n.id)).toEqual(["b", "a", "c"]);
  });

  it("lists people who have gone quiet, and calls a thin map sparse", () => {
    const m = buildMapModel(MAP);
    expect(quietPeople(m).map((n) => n.id)).toEqual(["zoë"]);
    expect(isSparse(m)).toBe(false);
    expect(isSparse(buildMapModel({ ...MAP, edges: [] }))).toBe(true);
    expect(isSparse(buildMapModel({ ...MAP, nodes: MAP.nodes.slice(0, 2), edges: [] }))).toBe(true);
    expect(isSparse(buildMapModel({ nodes: [], edges: [], total: 0, truncated: false }))).toBe(
      false,
    );
  });
});

describe("force layout", () => {
  const ring = (n: number) => {
    const links = Array.from({ length: n }, (_, i) => ({ a: i, b: (i + 1) % n, weight: 0.5 }));
    return { radii: Array.from({ length: n }, () => 6), links };
  };

  it("is deterministic and settles", () => {
    const a = new ForceLayout(ring(30));
    const b = new ForceLayout(ring(30));
    a.run(10_000);
    b.run(10_000);
    expect(a.settled).toBe(true);
    expect(Array.from(a.x)).toEqual(Array.from(b.x));
    expect([...a.x, ...a.y].every(Number.isFinite)).toBe(true);
  });

  it("keeps linked nodes closer than unlinked ones, and spreads nodes apart", () => {
    const l = new ForceLayout({
      radii: [8, 8, 8, 8],
      links: [{ a: 0, b: 1, weight: 1 }],
    });
    l.run(10_000);
    const d = (i: number, j: number) =>
      Math.hypot((l.x[i] ?? 0) - (l.x[j] ?? 0), (l.y[i] ?? 0) - (l.y[j] ?? 0));
    expect(d(0, 1)).toBeLessThan(d(0, 2));
    expect(d(2, 3)).toBeGreaterThan(8);
  });

  it("copes with no nodes, one node and nodes at the same point", () => {
    expect(new ForceLayout({ radii: [], links: [] }).settled).toBe(true);
    const one = new ForceLayout({ radii: [5], links: [] });
    one.run(1000);
    expect(Number.isFinite(one.x[0])).toBe(true);
    const same = new ForceLayout({ radii: [5, 5, 5], links: [] });
    same.x.fill(3);
    same.y.fill(3);
    same.run(1000);
    expect([...same.x, ...same.y].every(Number.isFinite)).toBe(true);
    expect(same.x[0]).not.toBe(same.x[1]);
  });

  it("lays out a few thousand nodes within a time budget", () => {
    const n = 3000;
    const links = Array.from({ length: n * 2 }, (_, i) => ({
      a: i % n,
      b: (i * 7 + 13) % n,
      weight: 0.3,
    }));
    const l = new ForceLayout({ radii: Array.from({ length: n }, () => 5), links });
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) l.tick();
    const perTick = (performance.now() - t0) / 20;
    expect(perTick).toBeLessThan(60);
    expect([...l.x].every(Number.isFinite)).toBe(true);
  });

  it("stops after a time slice and resumes", () => {
    const l = new ForceLayout(ring(400));
    let t = 0;
    const settled = l.run(5, () => (t += 3));
    expect(settled).toBe(false);
    expect(l.run(60_000)).toBe(true);
  });
});

describe("map view maths", () => {
  it("fits the bounds inside the box", () => {
    const v = fitView({ x0: -100, y0: -50, x1: 100, y1: 50 }, 800, 400);
    expect(v.x + v.k * -100).toBeGreaterThanOrEqual(0);
    expect(v.x + v.k * 100).toBeLessThanOrEqual(800);
    expect(v.y + v.k * -50).toBeGreaterThanOrEqual(0);
    expect(v.y + v.k * 50).toBeLessThanOrEqual(400);
  });

  it("zooms about a point and clamps", () => {
    const v = { k: 1, x: 10, y: 20 };
    const z = zoomAt(v, 2, 100, 100);
    expect(z.x + z.k * ((100 - v.x) / v.k)).toBeCloseTo(100);
    expect(zoomAt(v, 1e9, 0, 0).k).toBe(8);
    expect(zoomAt(v, 1e-9, 0, 0).k).toBe(0.05);
  });

  it("hits the node under the pointer, the heavier one first", () => {
    const m = buildMapModel(MAP);
    const x = [0, 4, 200, 300, 400, 500, 600, 700];
    const y = [0, 0, 0, 0, 0, 0, 0, 0];
    const view = { k: 1, x: 0, y: 0 };
    expect(hitTest(m, x, y, view, 1, 1)).toBe(0);
    expect(hitTest(m, x, y, view, 200, 2)).toBe(2);
    expect(hitTest(m, x, y, view, 100, 100)).toBe(-1);
  });
});

describe("routes", () => {
  it("reads ?view= and falls back to the list", () => {
    expect(parseMemoryView("map")).toBe("map");
    expect(parseMemoryView("nope")).toBe("list");
    expect(parseMemoryView(null)).toBe("list");
    expect(MEMORY_MAP_ROUTE).toBe("/memory?view=map");
  });
});

function setup(ui: ReactElement, edit?: (w: FixtureWorld) => void) {
  const navigate = vi.fn();
  const user = userEvent.setup();
  render(
    <StoryWorld {...(edit ? { edit } : {})} slots={{ navigate }}>
      {ui}
    </StoryWorld>,
  );
  return { navigate, user };
}

describe("the Map view of the Memory page", () => {
  it("is a List | Map toggle on the page, not a new place", async () => {
    const { navigate, user } = setup(<MemoryScreen now={STORY_NOW} />);
    const toggle = await screen.findByTestId("memory-view-toggle");
    expect(within(toggle).getByRole("button", { name: "List" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    await user.click(within(toggle).getByRole("button", { name: "Map" }));
    expect(navigate).toHaveBeenLastCalledWith("/memory?view=map");
    // The chip row is unchanged.
    const kinds = screen.getByRole("navigation", { name: "What to show" });
    expect(within(kinds).getAllByRole("button")).toHaveLength(7);
  });

  it("List returns to the chip the owner was on", async () => {
    const { navigate, user } = setup(<MemoryScreen kind="projects" view="map" now={STORY_NOW} />);
    const toggle = await screen.findByTestId("memory-view-toggle");
    expect(within(toggle).getByRole("button", { name: "Map" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    await user.click(within(toggle).getByRole("button", { name: "List" }));
    expect(navigate).toHaveBeenLastCalledWith("/memory?kind=projects");
  });

  it("shows the fixture graph: search, filters, legend and an accessible list", async () => {
    setup(<MemoryScreen view="map" now={STORY_NOW} />);
    const map = await screen.findByTestId("memory-map");
    expect(within(map).getByRole("combobox", { name: "Find on the map" })).toBeTruthy();
    const filters = within(map).getByRole("group", { name: "Show on the map" });
    for (const name of ["People", "Projects", "Events", "Topics", "Places and orgs"])
      expect(within(filters).getByRole("button", { name })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "What to show" })).toBeNull();
    const list = within(map).getByRole("list", { name: /Items on the map/ });
    expect(within(list).getByRole("button", { name: /Sam Lee/ })).toBeTruthy();
    // The owner is not a node.
    expect(within(list).queryByText(/^You$/)).toBeNull();
    expect(within(map).getByText("Mentioned together")).toBeTruthy();
  });

  it("opens a node's existing detail from the list", async () => {
    const { navigate, user } = setup(<MemoryScreen view="map" now={STORY_NOW} />);
    const map = await screen.findByTestId("memory-map");
    const list = within(map).getByRole("list", { name: /Items on the map/ });
    await user.click(within(list).getByRole("button", { name: /Sam Lee/ }));
    expect(navigate).toHaveBeenLastCalledWith(`/memory?entity=${PEOPLE_IDS.samLee}`);
  });

  it("searching focuses a node on its neighbourhood, and Show everything clears it", async () => {
    const { user } = setup(<MemoryScreen view="map" now={STORY_NOW} />);
    const box = await screen.findByRole("combobox", { name: "Find on the map" });
    await user.type(box, "sam");
    const hit = await screen.findByRole("option", { name: /Sam Lee/ });
    await user.click(hit);
    const focus = await screen.findByTestId("memory-map-focus");
    expect(focus.textContent).toMatch(/^Sam Lee and /);
    await user.click(within(focus).getByRole("button", { name: "Show everything" }));
    expect(screen.queryByTestId("memory-map-focus")).toBeNull();
  });

  it("says so when nothing matches", async () => {
    const { user } = setup(<MemoryScreen view="map" now={STORY_NOW} />);
    await user.type(await screen.findByRole("combobox", { name: "Find on the map" }), "qqqq");
    expect(await screen.findByText("Nothing on the map matches “qqqq”.")).toBeTruthy();
  });

  it("filters by group", async () => {
    const { user } = setup(<MemoryScreen view="map" now={STORY_NOW} />);
    const map = await screen.findByTestId("memory-map");
    const filters = within(map).getByRole("group", { name: "Show on the map" });
    const people = within(filters).getByRole("button", { name: "People" });
    expect(people.getAttribute("aria-pressed")).toBe("true");
    await user.click(people);
    expect(people.getAttribute("aria-pressed")).toBe("false");
    const list = within(map).getByRole("list", { name: /Items on the map/ });
    expect(within(list).queryByRole("button", { name: /Sam Lee/ })).toBeNull();
  });

  it("has a calm empty state", async () => {
    setup(<MemoryScreen view="map" now={STORY_NOW} />, (w) => {
      w.graph.entities = [];
    });
    expect(await screen.findByText(/^Nothing to map yet/)).toBeTruthy();
    expect(screen.queryByTestId("memory-map")).toBeNull();
  });

  it("explains a sparse map", async () => {
    setup(<MemoryScreen view="map" now={STORY_NOW} />, (w) => {
      w.graph.edges = [];
      w.graph.interactions = [];
    });
    expect(await screen.findByTestId("memory-map-sparse")).toBeTruthy();
  });

  it("opens an entity page instead of the map when an entity is given", async () => {
    setup(<MemoryScreen view="map" entity={PEOPLE_IDS.samLee} now={STORY_NOW} />);
    expect(await screen.findByTestId("memory-entity")).toBeTruthy();
    expect(screen.queryByTestId("memory-map")).toBeNull();
  });
});

describe("a refetch of the map", () => {
  it("is recognised as the same map, and kept by identity", () => {
    expect(sameMap(MAP, structuredClone(MAP))).toBe(true);
    const moved = structuredClone(MAP);
    (moved.nodes[0] as N).weight = 0.9;
    expect(sameMap(MAP, moved)).toBe(false);
    expect(sameMap(MAP, { ...MAP, edges: MAP.edges.slice(1) })).toBe(false);
  });

  it("measures how much of the map is still there", () => {
    const a = buildMapModel(MAP);
    expect(modelOverlap(a, buildMapModel(structuredClone(MAP)))).toBe(1);
    expect(modelOverlap(a, focusModel(a, "sam"))).toBeLessThan(0.8);
    const grown = buildMapModel({ ...MAP, nodes: [...MAP.nodes, node("new", "person")] });
    expect(modelOverlap(a, grown)).toBeGreaterThanOrEqual(0.8);
    expect(
      modelOverlap(a, buildMapModel({ nodes: [], edges: [], total: 0, truncated: false })),
    ).toBe(0);
  });

  it("keeps the layout positions of the nodes it already had", () => {
    const first = new ForceLayout({ radii: [6, 6, 6], links: [{ a: 0, b: 1, weight: 1 }] });
    first.run(10_000);
    const next = new ForceLayout({ radii: [6, 6, 6, 6], links: [{ a: 0, b: 1, weight: 1 }] });
    for (let i = 0; i < 3; i++) {
      next.x[i] = first.x[i] ?? 0;
      next.y[i] = first.y[i] ?? 0;
    }
    next.alpha = 0.25;
    next.run(10_000);
    // The old nodes stay near where they were: the spiral start would put them far elsewhere.
    expect(
      Math.hypot((next.x[0] ?? 0) - (first.x[0] ?? 0), (next.y[0] ?? 0) - (first.y[0] ?? 0)),
    ).toBeLessThan(60);
  });
});

describe("memory map refetching", () => {
  afterEach(() => vi.useRealTimers());

  it("follows graph events on a 15 s timer, not on each one", async () => {
    const gateway = new MockGateway({}, { now: () => FIXTURE_NOW });
    const request = vi.spyOn(gateway, "request");
    const store = new GatewayStore(gateway, { now: () => FIXTURE_NOW });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <GatewayProvider client={gateway} store={store}>
        {children}
      </GatewayProvider>
    );
    const calls = () => request.mock.calls.filter(([m]) => m === "memory.graph.map").length;
    const { result } = renderHook(() => useGatewayQuery("memory.graph.map", { limit: 2000 }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(calls()).toBe(1);

    vi.useFakeTimers({ shouldAdvanceTime: true });
    act(() => {
      for (let i = 0; i < 5; i++)
        gateway.emit("memory.entity.updated", { id: "ent_x", kind: "person", changed: ["facts"] });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(14_000);
    });
    expect(calls()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    await waitFor(() => expect(calls()).toBe(2));
  });
});
