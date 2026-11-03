import type { EntitySummary, LifeFactHit } from "@psyche/protocol";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { LifeAnswerCard, type LifeAnswerState } from "../src/screens/search/LifeAnswerCard.tsx";
import {
  factsDisagree,
  groundedClaims,
  looksLikeQuestion,
  newestFirst,
} from "../src/screens/search/life-answer.ts";
import { SearchScreen } from "../src/screens/search/SearchScreen.tsx";
import { UiSlotsProvider } from "../src/slots.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

afterEach(cleanup);

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
const fact = (
  id: string,
  value: string,
  over: Partial<LifeFactHit> = {},
  who: [string, string] = ["e1", "Sam Lee"],
): LifeFactHit => ({
  factId: id,
  entity: entity(...who),
  attribute: "employer",
  value,
  provenance: "untrusted",
  review: "accepted",
  quote: `I work at ${value}`,
  source: "mail",
  observedAt: "2026-09-30T10:00:00.000Z",
  learnedAt: "2026-10-02T10:00:00.000Z",
  ...over,
});

describe("what reads like a question", () => {
  it("takes a question mark or a leading question word, and never a bare name or a short query", () => {
    for (const q of [
      "where does Sam work?",
      "when did priya say the contract would be ready",
      "what did I promise Priya",
      "does sam still live in lisbon",
      "is sam at initech?",
    ])
      expect(looksLikeQuestion(q), q).toBe(true);
    for (const q of [
      "sam",
      "sam lee",
      "initech",
      "how to",
      "contract ready",
      "a?",
      "  ",
      "sam works at initech",
    ])
      expect(looksLikeQuestion(q), q).toBe(false);
    expect(looksLikeQuestion(`what ${"x".repeat(600)}`)).toBe(false);
  });
});

describe("reading an answer back into claims", () => {
  const facts = [fact("f1", "Initech"), fact("f2", "Globex", { entity: entity("e2", "Pat Doe") })];

  it("pairs each claim with the facts after it, and joins a run of markers", () => {
    const claims = groundedClaims("Sam works at Initech [1]. Pat is at Globex [2][1].", facts);
    expect(claims.map((c) => c.text)).toEqual(["Sam works at Initech.", "Pat is at Globex."]);
    expect(claims[1]?.facts.map((f) => f.factId)).toEqual(["f2", "f1"]);
  });

  it("drops text with no citation and markers that name no fact: no citation, no claim", () => {
    expect(groundedClaims("Sam works at Initech.", facts)).toEqual([]);
    expect(groundedClaims("Sam works at Initech [7].", facts)).toEqual([]);
    expect(groundedClaims(null, facts)).toEqual([]);
    expect(groundedClaims("Sam works at Initech [1].", [])).toEqual([]);
    const mixed = groundedClaims("Sam works at Initech [1]. He is also tall.", facts);
    expect(mixed.map((c) => c.text)).toEqual(["Sam works at Initech."]);
  });

  it("orders facts newest first by when Psyche learned them, and spots disagreeing values", () => {
    const older = fact("a", "Initech", { learnedAt: "2026-01-01T00:00:00.000Z" });
    const newer = fact("b", "Globex", { learnedAt: "2026-06-01T00:00:00.000Z" });
    expect(newestFirst([older, newer]).map((f) => f.factId)).toEqual(["b", "a"]);
    expect(factsDisagree([older, newer])).toBe(true);
    expect(factsDisagree([older, fact("c", " initech ")])).toBe(false);
    expect(factsDisagree([older, fact("d", "Globex", { entity: entity("e2", "Pat") })])).toBe(
      false,
    );
  });
});

function card(
  state: Partial<LifeAnswerState> & Pick<LifeAnswerState, "phase">,
  extra: {
    onOpenEntity?: (e: EntitySummary) => void;
    prefillComposer?: (text: string) => void;
  } = {},
) {
  return render(
    <UiSlotsProvider
      value={extra.prefillComposer ? { prefillComposer: extra.prefillComposer } : {}}
    >
      <LifeAnswerCard
        state={{ onAsk: () => undefined, ...state }}
        {...(extra.onOpenEntity ? { onOpenEntity: extra.onOpenEntity } : {})}
      />
    </UiSlotsProvider>,
  );
}

describe("the answer card", () => {
  it("shows the answer with a citation chip that opens the fact, when Psyche learned it, and its source", () => {
    const onOpenEntity = vi.fn();
    const onDone = vi.fn();
    card(
      {
        phase: "done",
        auto: true,
        onDone,
        result: {
          answer: "Sam works at Initech [1].",
          facts: [fact("f1", "Initech")],
          reason: null,
        },
      },
      { onOpenEntity },
    );
    const answer = screen.getByTestId("life-answer");
    expect(answer.textContent).toContain("Sam works at Initech.");
    expect(answer.textContent).not.toContain("[1]");
    const chip = screen.getByRole("button", { name: "Sam Lee: Works at" });
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("life-answer-facts")).toBeNull();
    fireEvent.click(chip);
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    const detail = screen.getByTestId("life-answer-facts");
    expect(detail.textContent).toContain("Sam Lee · Works at: Initech");
    expect(detail.textContent).toContain("Learned Oct 2");
    expect(detail.textContent).toContain("From Mail");
    expect(detail.textContent).toContain("I work at Initech");
    fireEvent.click(within(detail).getByRole("button", { name: "Open in Memory" }));
    expect(onOpenEntity).toHaveBeenCalledWith(expect.objectContaining({ id: "e1" }));
    expect(onDone).toHaveBeenCalled();
    fireEvent.click(chip);
    expect(screen.queryByTestId("life-answer-facts")).toBeNull();
  });

  it("puts a claim that rests on several facts behind one chip with a count, newest first, noting when they differ", () => {
    const old = fact("f1", "Initech", { learnedAt: "2026-03-01T10:00:00.000Z" });
    const now = fact("f2", "Globex", { learnedAt: "2026-10-01T10:00:00.000Z" });
    card({
      phase: "done",
      result: { answer: "Sam works at Globex now [2][1].", facts: [old, now], reason: null },
    });
    const chips = screen.getAllByTestId("life-answer-source");
    expect(chips).toHaveLength(1);
    expect(chips[0]?.textContent).toBe("2 facts");
    fireEvent.click(chips[0] as HTMLElement);
    expect(screen.getByRole("note").textContent).toBe("These facts differ. Newest first.");
    const rows = screen.getAllByTestId("life-answer-fact").map((r) => r.textContent ?? "");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("Globex");
    expect(rows[0]).toContain("Learned Oct 1");
    expect(rows[1]).toContain("Initech");
    expect(rows[1]).toContain("Learned Mar 1");
  });

  it("gives each claim its own chip", () => {
    card({
      phase: "done",
      result: {
        answer: "Sam works at Initech [1]. Pat works at Globex [2].",
        facts: [fact("f1", "Initech"), fact("f2", "Globex", {}, ["e2", "Pat Doe"])],
        reason: null,
      },
    });
    expect(screen.getAllByTestId("life-answer-source").map((c) => c.textContent)).toEqual([
      "Sam Lee: Works at",
      "Pat Doe: Works at",
    ]);
  });

  it("shows a loading state without an answer", () => {
    card({ phase: "loading", auto: true });
    expect(screen.getByRole("status").textContent).toContain("Looking through");
    expect(screen.queryByTestId("life-answer-source")).toBeNull();
  });

  it.each([
    ["no_facts", "Nothing you have confirmed answers that yet."],
    ["no_answer", "The facts Psyche has do not answer that."],
    ["ungrounded", "Couldn't find a source for that."],
    ["model_failed", "Could not answer just now."],
  ] as const)("says why there is no answer: %s", (reason, text) => {
    card({ phase: "done", result: { answer: null, facts: [], reason } });
    expect(screen.getByTestId("life-answer").textContent).toContain(text);
    expect(screen.queryByTestId("life-answer-source")).toBeNull();
  });

  it("links to the setting when the model is off, and only then", () => {
    const onOpenSettings = vi.fn();
    card({
      phase: "done",
      onOpenSettings,
      result: { answer: null, facts: [], reason: "no_model" },
    });
    expect(screen.getByTestId("life-answer").textContent).toContain("needs a model");
    fireEvent.click(screen.getByRole("button", { name: "Open Everything memory settings" }));
    expect(onOpenSettings).toHaveBeenCalled();
    cleanup();
    card({
      phase: "done",
      onOpenSettings,
      result: { answer: null, facts: [], reason: "no_facts" },
    });
    expect(screen.queryByRole("button", { name: "Open Everything memory settings" })).toBeNull();
  });

  it("never shows an answer that cites nothing, even when the Gateway sent one", () => {
    for (const result of [
      { answer: "Sam works at Initech.", facts: [fact("f1", "Initech")], reason: null },
      { answer: "Sam works at Initech [4].", facts: [fact("f1", "Initech")], reason: null },
      { answer: "Sam works at Initech [1].", facts: [], reason: null },
    ] as const) {
      card({ phase: "done", result });
      const text = screen.getByTestId("life-answer").textContent ?? "";
      expect(text).not.toContain("Sam works at Initech");
      expect(text).toContain("Couldn't find a source for that.");
      expect(screen.queryByTestId("life-answer-source")).toBeNull();
      cleanup();
    }
  });

  it("opens the question as a chat through the prefill slot, never the answer or the facts", () => {
    const prefillComposer = vi.fn();
    const onDone = vi.fn();
    card(
      {
        phase: "done",
        question: "where does Sam work?",
        onDone,
        result: {
          answer: "Sam works at Initech [1].",
          facts: [fact("f1", "Initech")],
          reason: null,
        },
      },
      { prefillComposer },
    );
    fireEvent.click(screen.getByRole("button", { name: "Open as a chat" }));
    expect(prefillComposer).toHaveBeenCalledExactlyOnceWith("where does Sam work?");
    expect(onDone).toHaveBeenCalled();
  });

  it("offers no chat when the host has no composer to fill", () => {
    card({
      phase: "done",
      question: "where does Sam work?",
      result: { answer: null, facts: [], reason: "no_facts" },
    });
    expect(screen.queryByRole("button", { name: "Open as a chat" })).toBeNull();
  });
});

describe("asking from the Search page", () => {
  const life = [fact("f1", "Initech")];
  const world = (
    onGateway?: (g: MockGateway) => void,
    slots: { navigate?: (r: string) => void; prefillComposer?: (t: string) => void } = {},
  ) =>
    render(
      <StoryWorld
        edit={(w) => {
          w.review = { items: [], quarantine: [], runs: [], life };
        }}
        {...(onGateway ? { onGateway } : {})}
        slots={slots}
      >
        <SearchScreen initialQuery="" debounceMs={0} />
      </StoryWorld>,
    );
  const type = (value: string) =>
    fireEvent.change(screen.getByRole("combobox"), { target: { value } });

  it("answers a question on its own, while the normal results stay put", async () => {
    let gateway: MockGateway | undefined;
    const navigate = vi.fn();
    world(
      (g) => {
        gateway = g;
      },
      { navigate },
    );
    type("where does Sam work?");
    expect(await screen.findByRole("button", { name: "Sam Lee: Works at" })).toBeTruthy();
    expect(screen.getByTestId("life-answer").textContent).toContain("Initech");
    expect(gateway?.calls.filter((c) => c.method === "memory.life.answer")).toHaveLength(1);
    // The Life group of the normal results is not blocked by, or replaced with, the answer.
    expect(await screen.findAllByTestId("search-option")).not.toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Sam Lee: Works at" }));
    fireEvent.click(
      within(screen.getByTestId("life-answer-facts")).getByRole("button", {
        name: "Open in Memory",
      }),
    );
    expect(navigate).toHaveBeenCalledWith("/memory?entity=e1");
  });

  it("asks only by button for a query that is not a question", async () => {
    let gateway: MockGateway | undefined;
    world((g) => {
      gateway = g;
    });
    type("sam initech");
    const ask = await screen.findByRole("button", { name: "Answer from my memory" });
    await new Promise((r) => setTimeout(r, 1000));
    expect(gateway?.calls.some((c) => c.method === "memory.life.answer")).toBe(false);
    fireEvent.click(ask);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Sam Lee: Works at" })).toBeTruthy(),
    );
  });

  it("does not send a half-typed question: it waits for the typing to stop", async () => {
    let gateway: MockGateway | undefined;
    world((g) => {
      gateway = g;
    });
    type("where does");
    type("where does sam");
    type("where does sam work");
    await screen.findByText("Looking through what Psyche has learned…");
    expect(gateway?.calls.some((c) => c.method === "memory.life.answer")).toBe(false);
    await waitFor(
      () => expect(gateway?.calls.filter((c) => c.method === "memory.life.answer")).toHaveLength(1),
      { timeout: 3000 },
    );
  });

  it("says so when nothing confirmed matches, with no chip", async () => {
    render(
      <StoryWorld
        edit={(w) => {
          w.review = {
            items: [],
            quarantine: [],
            runs: [],
            life: [fact("f9", "Initech", { review: "pending" })],
          };
        }}
      >
        <SearchScreen initialQuery="" debounceMs={0} />
      </StoryWorld>,
    );
    type("where does Sam work?");
    expect(await screen.findByText("Nothing you have confirmed answers that yet.")).toBeTruthy();
    expect(screen.queryByTestId("life-answer-source")).toBeNull();
  });
});
