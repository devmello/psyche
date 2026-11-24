import type { MethodResult } from "@psyche/protocol";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalFriction } from "../src/agent/ApprovalFriction.tsx";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

afterEach(cleanup);

type Friction = MethodResult<"audit.friction">;

const EMPTY: Friction = {
  from: null,
  to: null,
  decisions: 0,
  asks: 0,
  askRate: 0,
  asksPerAskingRun: 0,
  answerRate: 0,
  approveRate: 0,
  p50AnswerMs: null,
  p90AnswerMs: null,
  allowedByGrant: 0,
  grantsCreated: {},
  topAskRules: [],
  answerRejections: {},
  classifier: {},
  byKind: [],
  byMode: {},
};

const BUSY: Friction = {
  ...EMPTY,
  from: "2026-11-17T00:00:00.000Z",
  to: "2026-11-24T00:00:00.000Z",
  decisions: 12,
  asks: 3,
  askRate: 0.25,
  asksPerAskingRun: 1.5,
  answerRate: 0.8,
  approveRate: 0.75,
  p50AnswerMs: 42_000,
  p90AnswerMs: 180_000,
  allowedByGrant: 5,
  grantsCreated: { mail_send: 2 },
  topAskRules: [{ rule: "mode:balanced/write", count: 2 }],
  answerRejections: { stale: 1 },
  byKind: [
    {
      kind: "mail.send",
      decisions: 4,
      asks: 3,
      allows: 1,
      denies: 0,
      approved: 2,
      declined: 1,
      expired: 1,
      invalidated: 0,
      p50AnswerMs: 42_000,
      p90AnswerMs: 180_000,
    },
  ],
  byMode: { balanced: { decisions: 12, asks: 3 } },
};

let gateway: MockGateway;

function show(friction?: Friction) {
  return render(
    <StoryWorld
      edit={(w) => {
        if (friction) w.auditFriction = friction;
      }}
      onGateway={(g) => (gateway = g)}
    >
      <ApprovalFriction now={STORY_NOW} />
    </StoryWorld>,
  );
}

describe("approval friction card", () => {
  it("says how often Psyche asked, how fast and how you answered, in plain words", async () => {
    show(BUSY);
    expect(
      await screen.findByText(/Asked about 3 actions out of 12 actions checked \(25%\)/),
    ).toBeTruthy();
    expect(screen.getByText(/Runs that asked at least once averaged 1\.5 asks each/)).toBeTruthy();
    expect(
      screen.getByText(/Of the asks that ended, 80% were answered before they expired/),
    ).toBeTruthy();
    expect(screen.getByText(/Of the asks that ended, 75% were approved/)).toBeTruthy();
    expect(screen.getByText(/Answering took a median of 42 s/)).toBeTruthy();
    expect(screen.getByText(/1 ask expired unanswered/)).toBeTruthy();
    expect(screen.getByText(/1 answer was rejected as invalid/)).toBeTruthy();
    expect(
      screen.getByText(/5 actions went through on a standing grant with no card/),
    ).toBeTruthy();
    expect(screen.getByText(/2 standing grants were created/)).toBeTruthy();
  });

  it("names the rule family in plain words and lists the kinds that asked", async () => {
    show(BUSY);
    expect(await screen.findByText("Your mode setting: 2")).toBeTruthy();
    expect(screen.getByText("mail.send: asked 3, approved 2, declined 1, expired 1")).toBeTruthy();
    expect(screen.getByText("balanced: asked 3 of 12")).toBeTruthy();
  });

  it("shows the window it covers", async () => {
    show(BUSY);
    expect(await screen.findByText(/Since /)).toBeTruthy();
  });

  it("says the window had no actions when nothing was checked", async () => {
    show(EMPTY);
    expect(await screen.findByText(/Psyche checked no actions in this window/)).toBeTruthy();
    expect(screen.queryByText(/Asked about/)).toBeNull();
  });

  it("says no answer time when no ask was answered", async () => {
    show({ ...BUSY, asks: 0, askRate: 0, p50AnswerMs: null, p90AnswerMs: null, byKind: [] });
    expect(await screen.findByText(/No asks were answered in this window/)).toBeTruthy();
  });

  it("shows the error with a retry, and retries", async () => {
    show(BUSY);
    await screen.findByText(/Asked about/);
    gateway.failNext("audit.friction", "unavailable", "the Gateway is down");
    fireEvent.click(screen.getByText("Last 30 days"));
    expect(await screen.findByText(/Could not load approval friction/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByText(/Could not load/)).toBeNull());
  });

  it("re-asks for the 30-day window when the owner picks it", async () => {
    show(BUSY);
    await screen.findByText(/Asked about/);
    const since = (c: { params: unknown }) => (c.params as { since: string }).since;
    const before = gateway.calls.filter((c) => c.method === "audit.friction");
    fireEvent.click(screen.getByText("Last 30 days"));
    await waitFor(() =>
      expect(gateway.calls.filter((c) => c.method === "audit.friction").length).toBeGreaterThan(
        before.length,
      ),
    );
    const sinces = gateway.calls.filter((c) => c.method === "audit.friction").map(since);
    const daysBack = (s: string) => (STORY_NOW - Date.parse(s)) / 86_400_000;
    expect(Math.round(daysBack(sinces[0] ?? ""))).toBe(7);
    expect(Math.round(daysBack(sinces.at(-1) ?? ""))).toBe(30);
  });
});
