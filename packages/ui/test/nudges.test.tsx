import type { FeedPost, NudgeItem } from "@psyche/protocol";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import type { FixtureWorld } from "../src/fixtures/index.ts";
import { KeepInTouchSection } from "../src/home/sections.tsx";
import { draftPrompt, NudgeActions } from "../src/nudges/NudgeActions.tsx";
import { RelationshipNudgesSettings } from "../src/nudges/NudgeSettings.tsx";
import { ConnectedEntityCard } from "../src/people/ConnectedEntityCard.tsx";
import { FeedPostCard } from "../src/screens/feed/FeedPostCard.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

afterEach(cleanup);

const nudge = (over: Partial<NudgeItem> = {}): NudgeItem => ({
  id: "nd_priya",
  kind: "unanswered",
  entityId: "ent_priya",
  name: "Priya Rao",
  text: "You haven't replied to Priya Rao's message from 9 days ago.",
  daysAgo: 9,
  channel: "messages",
  date: null,
  overdue: false,
  ...over,
});

const post = (nudgeId = "nd_priya"): FeedPost => ({
  id: "post_nudge",
  title: "Reply to Priya Rao?",
  bodyMd: "You haven't replied to Priya Rao's message from 9 days ago.",
  citations: [],
  cluster: null,
  score: 1,
  reasons: ["relationship nudge"],
  exploration: false,
  briefingId: null,
  feedback: null,
  createdAt: "2026-10-28T09:00:00.000Z",
  kind: "suggestion",
  refs: { nudgeId },
});

let gateway: MockGateway;
const world =
  (items: NudgeItem[], muted: string[] = []) =>
  (w: FixtureWorld) => {
    w.review = { items: [], quarantine: [], runs: [], nudges: { items, muted } };
  };
const acted = () => gateway.world.review?.nudges?.acted ?? [];

describe("draftPrompt", () => {
  it("asks for a draft and never to send, for every kind", () => {
    const texts = [
      draftPrompt(nudge()),
      draftPrompt(nudge({ kind: "drift", daysAgo: 42, channel: null })),
      draftPrompt(nudge({ kind: "birthday", date: "2026-11-05", daysAgo: null, channel: null })),
      draftPrompt(nudge({ kind: "promise", text: "You promised Priya Rao: “send the deck”." })),
    ];
    for (const t of texts) {
      expect(t).toContain("Priya Rao");
      expect(t).toMatch(/Do not send anything/);
    }
    expect(texts[0]).toContain("9 days ago");
    expect(texts[2]).toContain("2026-11-05");
    expect(texts[3]).toContain("send the deck");
  });

  it("names an email for mail", () => {
    expect(draftPrompt(nudge({ channel: "mail" }))).toContain("email");
  });
});

describe("Feed nudge card", () => {
  const show = (slots?: Parameters<typeof StoryWorld>[0]["slots"], items = [nudge()]) =>
    render(
      <StoryWorld edit={world(items)} onGateway={(g) => (gateway = g)} slots={slots}>
        <FeedPostCard post={post()} />
      </StoryWorld>,
    );

  it("shows Keep in touch with the four actions", async () => {
    show({ prefillComposer: () => {} });
    expect(await screen.findByRole("button", { name: "Draft a reply" })).toBeTruthy();
    expect(screen.getByText("Keep in touch")).toBeTruthy();
    for (const name of ["Snooze", "Done", "Not this person"])
      expect(screen.getByRole("button", { name })).toBeTruthy();
  });

  it("Draft a reply fills the chat and sends nothing", async () => {
    const prefill = vi.fn();
    show({ prefillComposer: prefill });
    await userEvent.click(await screen.findByRole("button", { name: "Draft a reply" }));
    expect(prefill).toHaveBeenCalledTimes(1);
    expect(prefill.mock.calls[0]?.[0]).toMatch(/reply to Priya Rao.*Do not send anything/s);
    expect(acted()).toEqual([]);
  });

  it("Snooze offers a week or a month", async () => {
    show({ prefillComposer: () => {} });
    await userEvent.click(await screen.findByRole("button", { name: "Snooze" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "For a month" }));
    await waitFor(() => expect(acted()).toEqual(["nd_priya:snooze_month"]));
    expect((await screen.findByRole("status")).textContent).toBe("Snoozed for a month.");
  });

  it("Done and Not this person act and say what happened", async () => {
    show({ prefillComposer: () => {} });
    await userEvent.click(await screen.findByRole("button", { name: "Done" }));
    await waitFor(() => expect(acted()).toEqual(["nd_priya:done"]));
    expect((await screen.findByRole("status")).textContent).toBe("Marked done.");
    cleanup();
    show({ prefillComposer: () => {} });
    await userEvent.click(await screen.findByRole("button", { name: "Not this person" }));
    await waitFor(() => expect(acted()).toEqual(["nd_priya:mute_person"]));
    expect((await screen.findByRole("status")).textContent).toMatch(/No more nudges for Priya Rao/);
  });

  it("has no draft button where no chat can be reached, and marks an overdue promise amber", async () => {
    show(undefined, [nudge({ kind: "promise", overdue: true })]);
    await screen.findByRole("button", { name: "Snooze" });
    expect(screen.queryByRole("button", { name: /Draft/ })).toBeNull();
    expect(screen.getByTestId("nudge-overdue").className).toContain("text-amber-11");
  });

  it("a nudge that has gone away reads as handled, with no buttons", async () => {
    show({ prefillComposer: () => {} }, []);
    expect(await screen.findByText("Nothing left to do here.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
  });
});

describe("NudgeActions errors", () => {
  it("shows a failed action and keeps the buttons", async () => {
    const onAct = vi.fn().mockRejectedValue(new Error("offline"));
    render(
      <StoryWorld>
        <NudgeActions item={nudge()} onAct={onAct} />
      </StoryWorld>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/did not save/);
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
  });
});

describe("person page row", () => {
  const edit =
    (items: (id: string) => NudgeItem[], muted = false) =>
    (w: FixtureWorld) => {
      const p = w.graph.entities.find((e) => e.kind === "person" && !e.isOwner);
      if (p === undefined) throw new Error("fixture person missing");
      w.review = {
        items: [],
        quarantine: [],
        runs: [],
        nudges: { items: items(p.id), muted: muted ? [p.id] : [] },
      };
      personId = p.id;
    };
  let personId = "";
  const show = (e: (w: FixtureWorld) => void) =>
    render(
      <StoryWorld edit={e} onGateway={(g) => (gateway = g)} slots={{ prefillComposer: () => {} }}>
        <Card />
      </StoryWorld>,
    );
  const Card = () => <ConnectedEntityCard id={personId} />;

  it("shows the current nudge under Keep in touch", async () => {
    show(
      edit((id) => [nudge({ entityId: id, text: "You usually talk every 2 weeks; it's been 6." })]),
    );
    const row = await screen.findByTestId("nudge-person-row");
    expect(within(row).getByText(/it's been 6/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Keep in touch" })).toBeTruthy();
  });

  it("is absent when there is nothing to follow up, or the feature is off", async () => {
    show(edit(() => []));
    await screen.findByText(/Facts/);
    expect(screen.queryByTestId("nudge-person-row")).toBeNull();
    cleanup();
    show((w) => {
      edit(() => [])(w);
      if (w.review) delete w.review.nudges;
    });
    await screen.findByText(/Facts/);
    expect(screen.queryByRole("heading", { name: "Keep in touch" })).toBeNull();
  });

  it("a muted person shows a way to turn nudges back on", async () => {
    show(edit((id) => [nudge({ entityId: id })], true));
    const row = await screen.findByTestId("nudge-person-muted");
    await userEvent.click(within(row).getByRole("button", { name: "Turn nudges back on" }));
    await waitFor(() => expect(gateway.world.review?.nudges?.muted).toEqual([]));
  });
});

describe("Settings → People → Relationship nudges", () => {
  const settings = (over: Partial<Parameters<typeof RelationshipNudgesSettings>[0]> = {}) => {
    const onChange = vi.fn();
    render(
      <StoryWorld>
        <RelationshipNudgesSettings
          enabled={false}
          sensitivity="normal"
          onChange={onChange}
          now={() => "2026-11-02T10:00:00.000Z"}
          {...over}
        />
      </StoryWorld>,
    );
    return onChange;
  };

  it("is off until the owner has read what it does and said yes", async () => {
    const onChange = settings();
    await userEvent.click(screen.getByRole("switch", { name: /Remind me to keep in touch/ }));
    expect(onChange).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/dates only, not what was said/)).toBeTruthy();
    expect(within(dialog).getByText(/People you excluded never show up/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Turn on" }));
    expect(onChange).toHaveBeenCalledWith("nudges.consentedAt", "2026-11-02T10:00:00.000Z");
    expect(onChange).toHaveBeenCalledWith("nudges.enabled", true);
  });

  it("Not now changes nothing", async () => {
    const onChange = settings();
    await userEvent.click(screen.getByRole("switch", { name: /Remind me to keep in touch/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("turning it off needs no question, and sensitivity writes at once", async () => {
    const onChange = settings({ enabled: true });
    await userEvent.click(screen.getByRole("switch", { name: /Remind me to keep in touch/ }));
    expect(onChange).toHaveBeenCalledWith("nudges.enabled", false);
    await userEvent.click(screen.getByRole("radio", { name: "Eager" }));
    expect(onChange).toHaveBeenCalledWith("nudges.sensitivity", "high");
  });

  it("points to the quiet hours in Notifications", () => {
    settings();
    expect(screen.getByText(/quiet hours set in Settings → General → Notifications/)).toBeTruthy();
  });
});

describe("conversation starters", () => {
  const starters = [
    {
      text: "Ask how the new job at Initech is going",
      evidence: "Employer: Initech · their own words, accepted by you · Oct 12",
    },
    { text: "You promised: “send the deck”", evidence: "Your promise · Oct 28" },
  ];

  it("shows each starter with the fact it comes from, on the Feed card", async () => {
    render(
      <StoryWorld
        edit={world([nudge({ starters })])}
        onGateway={(g) => (gateway = g)}
        slots={{ prefillComposer: () => {} }}
      >
        <FeedPostCard post={post()} />
      </StoryWorld>,
    );
    const box = await screen.findByTestId("nudge-starters");
    expect(within(box).getByText("Things to bring up")).toBeTruthy();
    expect(within(box).getByText("Ask how the new job at Initech is going")).toBeTruthy();
    const evidence = within(box)
      .getAllByTestId("nudge-evidence")
      .map((e) => e.textContent);
    expect(evidence).toEqual([
      "Employer: Initech · their own words, accepted by you · Oct 12",
      "Your promise · Oct 28",
    ]);
  });

  it("shows nothing, not a generic line, when Psyche knows too little", async () => {
    render(
      <StoryWorld
        edit={world([nudge({ starters: [] }), nudge({ id: "nd_b", entityId: "ent_b" })])}
        slots={{ prefillComposer: () => {} }}
      >
        <FeedPostCard post={post()} />
      </StoryWorld>,
    );
    await screen.findByRole("button", { name: "Draft a reply" });
    expect(screen.queryByTestId("nudge-starters")).toBeNull();
  });

  it("Draft a reply carries the starters and their sources as context, and sends nothing", async () => {
    const prefill = vi.fn();
    render(
      <StoryWorld edit={world([nudge({ starters })])} slots={{ prefillComposer: prefill }}>
        <FeedPostCard post={post()} />
      </StoryWorld>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Draft a reply" }));
    const text = prefill.mock.calls[0]?.[0] as string;
    expect(text).toMatch(/Do not send anything/);
    expect(text).toContain("use only these and do not invent anything else");
    expect(text).toContain(
      "- Ask how the new job at Initech is going (Employer: Initech · their own words, accepted by you · Oct 12)",
    );
    expect(text).toContain("- You promised: “send the deck” (Your promise · Oct 28)");
  });

  it("Home's Keep in touch shows them as well", async () => {
    render(
      <StoryWorld edit={world([nudge({ starters })])} slots={{ prefillComposer: () => {} }}>
        <KeepInTouchSection onNavigate={() => {}} />
      </StoryWorld>,
    );
    const box = await screen.findByTestId("nudge-starters");
    expect(within(box).getByText("You promised: “send the deck”")).toBeTruthy();
  });

  it("draftPrompt has no context block without starters", () => {
    expect(draftPrompt(nudge())).not.toContain("Things I could bring up");
    expect(draftPrompt(nudge({ starters: [] }))).not.toContain("Things I could bring up");
  });

  it("the person page row shows them too", async () => {
    let personId = "";
    render(
      <StoryWorld
        edit={(w) => {
          const p = w.graph.entities.find((e) => e.kind === "person" && !e.isOwner);
          if (p === undefined) throw new Error("fixture person missing");
          personId = p.id;
          w.review = {
            items: [],
            quarantine: [],
            runs: [],
            nudges: { items: [nudge({ entityId: p.id, starters })], muted: [] },
          };
        }}
        slots={{ prefillComposer: () => {} }}
      >
        <PersonCardLater id={() => personId} />
      </StoryWorld>,
    );
    const row = await screen.findByTestId("nudge-person-row");
    expect(within(row).getByText("Ask how the new job at Initech is going")).toBeTruthy();
  });

  it("Settings has a phrasing switch that is off by default and needs nudges on", async () => {
    const onChange = vi.fn();
    render(
      <StoryWorld>
        <RelationshipNudgesSettings enabled sensitivity="normal" onChange={onChange} />
      </StoryWorld>,
    );
    const sw = screen.getByRole("switch", { name: /Reword suggestions with my model/ });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    await userEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith("nudges.phrasing", true);
  });
});

function PersonCardLater({ id }: { id: () => string }) {
  return <ConnectedEntityCard id={id()} />;
}
