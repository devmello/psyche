import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canvasFixtures } from "../src/fixtures/canvas.ts";
import { insightsFixtures } from "../src/fixtures/index.ts";
import {
  BuiltForYou,
  inPeriod,
  SPECIALIST_LIMIT,
  Specialists,
} from "../src/overview/BuiltSpecialists.tsx";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

afterEach(cleanup);

type World = { artifacts: unknown[]; artifactHistory?: unknown; insights?: unknown };
const typical = (world: object) => {
  const fx = canvasFixtures();
  const w = world as World;
  w.artifacts.push(...fx.artifacts);
  w.artifactHistory = fx.artifactHistory;
  w.insights = insightsFixtures("typical");
};

describe("inPeriod", () => {
  it("counts the rolling window and takes everything for all time", () => {
    const day = 86_400_000;
    const iso = (d: number) => new Date(STORY_NOW - d * day).toISOString();
    expect(inPeriod(iso(3), "7d", STORY_NOW)).toBe(true);
    expect(inPeriod(iso(9), "7d", STORY_NOW)).toBe(false);
    expect(inPeriod(iso(9), "30d", STORY_NOW)).toBe(true);
    expect(inPeriod(iso(400), "all", STORY_NOW)).toBe(true);
  });
});

describe("Built for you", () => {
  it("lists artifacts as tiles with a real chart thumbnail and the insights count", async () => {
    const onOpenArtifact = vi.fn();
    render(
      <StoryWorld edit={typical}>
        <BuiltForYou period="30d" now={STORY_NOW} onOpenArtifact={onOpenArtifact} />
      </StoryWorld>,
    );
    const tiles = await screen.findAllByTestId("artifact-tile");
    expect(tiles.length).toBeGreaterThan(1);
    expect(tiles.length).toBeLessThanOrEqual(8);
    const chart = tiles.find((t) => t.getAttribute("data-type") === "chart");
    expect(chart).toBeDefined();
    await waitFor(() => expect(chart?.querySelector("svg")).not.toBeNull());
    fireEvent.click(tiles[0] as HTMLElement);
    expect(onOpenArtifact).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(within(screen.getByTestId("overview-built")).getByText(/artifacts?$/)).toBeTruthy(),
    );
  });

  it("opens Library → Artifacts from See all", async () => {
    const navigate = vi.fn();
    render(
      <StoryWorld edit={typical} slots={{ navigate }}>
        <BuiltForYou period="30d" now={STORY_NOW} />
      </StoryWorld>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "See all" }));
    expect(navigate).toHaveBeenCalledWith("/library/artifacts");
  });

  it("falls back to the host's openArtifact", async () => {
    const openArtifact = vi.fn();
    render(
      <StoryWorld edit={typical} slots={{ openArtifact }}>
        <BuiltForYou period="30d" now={STORY_NOW} />
      </StoryWorld>,
    );
    fireEvent.click((await screen.findAllByTestId("artifact-tile"))[0] as HTMLElement);
    expect(openArtifact).toHaveBeenCalledTimes(1);
  });
});

describe("Specialists", () => {
  it("shows at most the three newest finished results", async () => {
    render(
      <StoryWorld edit={typical}>
        <Specialists period="all" now={STORY_NOW} />
      </StoryWorld>,
    );
    const rows = await screen.findAllByTestId("specialist-row");
    expect(rows.length).toBeLessThanOrEqual(SPECIALIST_LIMIT);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("is not drawn when no role is enabled", async () => {
    render(
      <StoryWorld
        edit={(w) => {
          typical(w);
          (w as { specialistRoles?: unknown[] }).specialistRoles = [];
        }}
      >
        <Specialists period="all" now={STORY_NOW} />
      </StoryWorld>,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("overview-specialists")).toBeNull();
  });
});
