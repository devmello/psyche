import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CANVAS_IDS, MAP_FIXTURE } from "../src/fixtures/canvas.ts";
import { applyOpsLocal } from "../src/lib/artifact-ops.ts";
import { MapPanel } from "../src/map/MapPanel.tsx";
import {
  DEFAULT_STYLE_DARK,
  DEFAULT_STYLE_LIGHT,
  mapSourceOf,
  parseMapContent,
  safeLink,
  validStyleUrl,
  viewBounds,
} from "../src/map/map-model.ts";
import { StoryWorld } from "../src/stories/harness.tsx";

const map = parseMapContent(MAP_FIXTURE);
if (map === null) throw new Error("fixture");
const on = { tiles: true, light: DEFAULT_STYLE_LIGHT, dark: DEFAULT_STYLE_DARK, isDefault: true };

describe("map model", () => {
  it("defaults to free tiles with no key, and follows the settings", () => {
    expect(mapSourceOf({})).toMatchObject({
      tiles: true,
      isDefault: true,
      light: DEFAULT_STYLE_LIGHT,
    });
    const s = mapSourceOf({
      "ui.map.tiles": false,
      "ui.map.styleUrl": "https://tiles.example.org/s.json",
    });
    expect(s).toMatchObject({
      tiles: false,
      isDefault: false,
      dark: "https://tiles.example.org/s.json",
    });
  });

  it("accepts https and local http style URLs only", () => {
    expect(validStyleUrl("https://a.example/s.json")).not.toBeNull();
    expect(validStyleUrl("http://localhost:8080/s.json")).not.toBeNull();
    expect(validStyleUrl("http://evil.example/s.json")).toBeNull();
    expect(validStyleUrl("javascript:alert(1)")).toBeNull();
    expect(mapSourceOf({ "ui.map.styleUrl": "ftp://x" }).isDefault).toBe(true);
  });

  it("drops markers with bad coordinates and unsafe links", () => {
    const m = parseMapContent(
      JSON.stringify({
        markers: [
          { id: "a", lat: 91, lng: 0, label: "x" },
          { id: "b", lat: 1, lng: 2, label: "y" },
        ],
      }),
    );
    expect(m?.markers.map((p) => p.id)).toEqual(["b"]);
    expect(parseMapContent("{")).toBeNull();
    expect(safeLink("javascript:alert(1)")).toBeNull();
    expect(safeLink("https://a.example/")).toBe("https://a.example/");
  });

  it("fits bounds around markers and routes as [w, s, e, n]", () => {
    const [w, s, e, n] = viewBounds(map) ?? [];
    expect(w).toBeCloseTo(-9.216);
    expect(e).toBeCloseTo(-9.13);
    expect(s).toBeCloseTo(38.6916);
    expect(n).toBeCloseTo(38.7223);
    expect(viewBounds({ markers: [] })).toBeNull();
  });

  it("applies marker ops locally", () => {
    const out = applyOpsLocal("map", MAP_FIXTURE, null, [
      { op: "addMarker", marker: { id: "e", lat: 1, lng: 2, label: "New" } },
      { op: "removeMarker", id: "a" },
      { op: "updateMarker", id: "b", set: { label: "Market", note: null } },
    ]);
    const m = JSON.parse(out.content) as {
      markers: { id: string; label: string; note?: string }[];
    };
    expect(m.markers.map((p) => p.id)).toEqual(["b", "c", "d", "e"]);
    expect(m.markers[0]).toMatchObject({ label: "Market" });
    expect(m.markers[0]?.note).toBeUndefined();
  });
});

describe("MapPanel", () => {
  it("shows the list alone when tiles are off, with no map element", async () => {
    render(
      <StoryWorld>
        <MapPanel map={map} variant="inline" source={{ ...on, tiles: false }} />
      </StoryWorld>,
    );
    expect(screen.getByText(/Map tiles are off/)).toBeTruthy();
    expect(screen.queryByTestId("map-view")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Alfama viewpoint/ }));
    expect(screen.getByText("Miradouro de Santa Luzia")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Open link/ }).getAttribute("href")).toBe(
      "https://www.visitlisboa.com/",
    );
  });

  it("falls back to the list when the map cannot start", async () => {
    // jsdom has no WebGL, so MapLibre fails to start and the list takes over.
    render(
      <StoryWorld>
        <MapPanel map={map} variant="full" source={on} />
      </StoryWorld>,
    );
    await waitFor(() => expect(screen.getByText(/map couldn't load/i)).toBeTruthy());
    expect(screen.getAllByRole("button").length).toBe(map.markers.length);
  });

  it("says so when there are no places", () => {
    render(
      <StoryWorld>
        <MapPanel map={{ markers: [] }} variant="inline" source={on} />
      </StoryWorld>,
    );
    expect(screen.getByText("No places to show.")).toBeTruthy();
  });
});

describe("map canvas fixture", () => {
  it("is registered", () => {
    expect(CANVAS_IDS.map).toBe("art_canvas_map");
  });
});

describe("tile proxy URLs", () => {
  it("routes third-party requests through the same-origin proxy and leaves the rest", async () => {
    const { proxiedUrl } = await import("../src/map/map-model.ts");
    const page = "https://psyche.example";
    const out = proxiedUrl("https://tiles.openfreemap.org/planet/1/2/3.pbf?v=1", page);
    expect(out.startsWith(`${page}/maps/o/`)).toBe(true);
    expect(out.endsWith("/planet/1/2/3.pbf?v=1")).toBe(true);
    const seg = out.slice(`${page}/maps/o/`.length).split("/")[0] as string;
    expect(atob(seg.replace(/-/g, "+").replace(/_/g, "/"))).toBe("https://tiles.openfreemap.org");
    expect(proxiedUrl(`${page}/x`, page)).toBe(`${page}/x`);
    expect(proxiedUrl("blob:abc", page)).toBe("blob:abc");
  });
});
