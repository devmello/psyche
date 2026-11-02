import type { EntitySummary, LifeFactHit } from "@psyche/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type LifeAnswerState,
  SearchSurface,
  surfaceGroups,
} from "../src/screens/search/SearchSurface.tsx";

const entity = (id: string, name: string): EntitySummary => ({
  id,
  kind: "person",
  name,
  subtitle: null,
  summary: null,
  status: "active",
  lastInteractionAt: null,
  openLoops: 0,
  pinned: false,
  isOwner: false,
});
const fact = (id: string, review: LifeFactHit["review"]): LifeFactHit => ({
  factId: id,
  entity: entity("e1", "Sam Lee"),
  attribute: "employer",
  value: "Initech",
  provenance: "untrusted",
  review,
  quote: "I just joined Initech",
  source: "mail",
  observedAt: null,
});

describe("Life group in the search surface", () => {
  it("comes after people and projects and before the index's hits, one row per fact", () => {
    const groups = surfaceGroups(
      [],
      [],
      "initech",
      [entity("e1", "Sam Lee")],
      [fact("f1", "accepted"), fact("f2", "pending")],
    );
    expect(groups.map((g) => g.id)).toEqual(["people", "life"]);
    expect(groups[1]?.items.map((i) => i.key)).toEqual(["fact:f1", "fact:f2"]);
  });

  it("is absent when there are no facts, so nothing changes for people who never turned it on", () => {
    expect(surfaceGroups([], [], "sam", [entity("e1", "Sam Lee")]).map((g) => g.id)).toEqual([
      "people",
    ]);
    expect(surfaceGroups([], [], "sam", [], []).map((g) => g.id)).toEqual([]);
  });
});

afterEach(cleanup);

describe("Answer from memory", () => {
  const show = (lifeAnswer: LifeAnswerState) =>
    render(
      <SearchSurface
        variant="page"
        query="where does sam work"
        onQueryChange={() => undefined}
        hits={[]}
        lifeFacts={[fact("f1", "accepted")]}
        lifeAnswer={lifeAnswer}
      />,
    );

  it("asks only when the owner clicks, then shows the answer with one chip per cited fact", () => {
    const onAsk = vi.fn();
    const { rerender } = show({ phase: "idle", onAsk });
    expect(onAsk).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Answer from my memory" }));
    expect(onAsk).toHaveBeenCalledTimes(1);
    rerender(
      <SearchSurface
        variant="page"
        query="where does sam work"
        onQueryChange={() => undefined}
        hits={[]}
        lifeFacts={[fact("f1", "accepted")]}
        lifeAnswer={{
          phase: "done",
          onAsk,
          result: {
            answer: "Sam works at Initech [1].",
            facts: [fact("f1", "accepted")],
            reason: null,
          },
        }}
      />,
    );
    expect(screen.getByTestId("life-answer").textContent).toContain("Sam works at Initech.");
    expect(screen.getAllByTestId("life-answer-source")).toHaveLength(1);
  });

  it("says why there is no answer, and offers settings when there is no model", () => {
    const onOpenSettings = vi.fn();
    show({
      phase: "done",
      onAsk: () => undefined,
      onOpenSettings,
      result: { answer: null, facts: [], reason: "no_model" },
    });
    expect(screen.getByTestId("life-answer").textContent).toContain("needs a model");
    fireEvent.click(screen.getByRole("button", { name: "Open Everything memory settings" }));
    expect(onOpenSettings).toHaveBeenCalled();
  });
});
