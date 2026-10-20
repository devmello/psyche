// @vitest-environment jsdom
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChecklistItem } from "@psyche/protocol";
import {
  ApprovalCard,
  ChatThread,
  Checklist,
  OnboardingFlow,
  QuestionCard,
  RAIL_ITEMS,
  Rail,
  UiSlotsProvider,
  WrapUpBox,
} from "@psyche/ui";
import { GatewayProvider, GatewayStore } from "@psyche/ui/data";
import { MockGateway } from "@psyche/ui/testing";
import { ThemeProvider } from "@psyche/ui/theme";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import axe from "axe-core";
import { computeAccessibleName } from "dom-accessibility-api";
import { describe, expect, it, vi } from "vitest";
import { PsycheApp } from "../../../apps/web/src/compose/PsycheApp.tsx";
import { SHORTCUTS } from "../../../apps/web/src/shell/keyboard.ts";
import { createFixtureWorld, FIXTURE_NOW, IDS } from "../../../packages/ui/src/fixtures/index.ts";
import { ROOT } from "../src/report.ts";
import { mediaMatches } from "./setup.ts";

/**
 * Accessibility pass of the main flows as the desktop renders them (the kit's screens inside
 * S11's shell; docs/03 cross-cutting criteria, docs/06 §4.11): full keyboard operation,
 * accessible names on cards, reduced motion honored. jsdom + axe-core + user-event; what needs
 * a real screen reader (VoiceOver rotor order, announcement timing) is listed in the scorecard
 * as a manual check.
 */

const NOW = Date.parse(FIXTURE_NOW);
const AXE: axe.RunOptions = {
  rules: {
    // jsdom computes no colors; contrast is gated by the theme generator's WCAG check (S12).
    "color-contrast": { enabled: false },
    region: { enabled: false },
    "landmark-one-main": { enabled: false },
    "page-has-heading-one": { enabled: false },
  },
};

/**
 * Fails on any axe violation that is not in `a11y/baseline.json`, and on any baselined one that
 * no longer happens, so the list only shrinks (docs/a11y-audit.md, "Gates"). Each violation is
 * fingerprinted as `rule|selector`, keyed by the test's name. Run with UPDATE_A11Y_BASELINE=1 to
 * rewrite the file after fixing (or, with a reason in the PR, accepting) a violation.
 */
const BASELINE_FILE = join(ROOT, "tests", "acceptance", "a11y", "baseline.json");
const baseline: Record<string, string[]> = existsSync(BASELINE_FILE)
  ? (JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as Record<string, string[]>)
  : {};
const updating = process.env.UPDATE_A11Y_BASELINE === "1";

async function expectNoAxeViolations(container: Element, options: axe.RunOptions = AXE) {
  const result = await axe.run(container, options);
  const key = expect.getState().currentTestName ?? "unknown";
  const found = result.violations.flatMap((v) =>
    v.nodes.map((n) => `${v.id}|${n.target.join(" ")}`),
  );
  if (updating) {
    if (found.length > 0) baseline[key] = [...new Set(found)].sort();
    else delete baseline[key];
    writeFileSync(BASELINE_FILE, `${JSON.stringify(baseline, null, 2)}\n`);
    return;
  }
  const known = new Set(baseline[key] ?? []);
  const fresh = found.filter((f) => !known.has(f));
  const gone = [...known].filter((k) => !found.includes(k));
  // New violations fail; so do baselined ones that were fixed (remove them from the baseline).
  expect({ new: fresh, fixedButStillBaselined: gone }).toEqual({
    new: [],
    fixedButStillBaselined: [],
  });
}

/** Page-level rules on: for the composed app rendered as a whole window. */
const AXE_PAGE: axe.RunOptions = {
  rules: { "color-contrast": { enabled: false } },
};

function pendingApproval() {
  const world = createFixtureWorld();
  const approval = world.approvals.find((a) => a.status === "pending");
  if (approval === undefined) throw new Error("the fixture world has no pending approval");
  return approval;
}

describe("approval card (docs/06 §3.3, §4.11)", () => {
  it("has no axe violations and names the card by its heading", async () => {
    const approval = pendingApproval();
    const { container } = render(
      <ApprovalCard approval={approval} canAnswer now={NOW} armDelayMs={0} onAnswer={() => {}} />,
    );
    await expectNoAxeViolations(container);
    // The card is a fieldset named by its heading, which is the broker's summary of the action.
    expect(screen.getByRole("group", { name: approval.summary })).toBeTruthy();
    expect(screen.getByRole("heading", { name: approval.summary })).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "Decision" })).toBeTruthy();
    for (const name of ["Deny", "Allow with scope"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
  });

  it("is fully keyboard operable: focus lands on the heading, Return alone never approves, ⌘Return approves the chosen scope, ⌘D denies", async () => {
    const onAnswer = vi.fn();
    const approval = pendingApproval();
    render(
      <ApprovalCard
        approval={approval}
        canAnswer
        now={NOW}
        armDelayMs={0}
        autoFocus
        onAnswer={onAnswer}
      />,
    );
    const user = userEvent.setup();
    const heading = screen.getByRole("heading", { name: approval.summary });
    expect(document.activeElement).toBe(heading);
    await user.keyboard("{Enter}");
    expect(onAnswer).not.toHaveBeenCalled();
    // Tab reaches the scope radios (after the details disclosure); arrows move the selection.
    const radios = screen.getAllByRole("radio");
    let reached = false;
    for (let i = 0; i < 8 && !reached; i += 1) {
      await user.tab();
      reached = radios.some((r) => r === document.activeElement);
    }
    expect(reached, "a scope radio is reachable by Tab from the heading").toBe(true);
    const once = screen.getByRole("radio", { name: /Allow once/ });
    once.focus();
    await user.keyboard("{ArrowDown}{ArrowUp}");
    await user.click(once);
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("approve", "once"));
    onAnswer.mockClear();
    await user.keyboard("{Meta>}d{/Meta}");
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("deny", undefined));
  });

  it("exposes the shortcuts on the buttons for assistive tech", () => {
    render(
      <ApprovalCard
        approval={pendingApproval()}
        canAnswer
        now={NOW}
        armDelayMs={0}
        onAnswer={() => {}}
      />,
    );
    // The card accepts Ctrl as well as ⌘, and says so (docs/a11y-audit.md C5).
    expect(screen.getByRole("button", { name: "Deny" }).getAttribute("aria-keyshortcuts")).toBe(
      "Meta+D Control+D",
    );
    expect(
      screen.getByRole("button", { name: "Allow with scope" }).getAttribute("aria-keyshortcuts"),
    ).toBe("Meta+Enter Control+Enter");
    // The shortcut is shown, and described on both buttons.
    expect(screen.getByRole("button", { name: "Deny" }).getAttribute("aria-describedby")).toBeTruthy();
  });
});

describe("question card", () => {
  const request = () => {
    const r = createFixtureWorld().inputRequests[0];
    if (r === undefined) throw new Error("no fixture input request");
    return r;
  };

  it("has no axe violations; every question is a labelled group", async () => {
    const { container } = render(<QuestionCard request={request()} persona="Wren" />);
    await expectNoAxeViolations(container);
    for (const q of request().questions) {
      // The fieldset's name is its legend: the header, then the question. Single-choice
      // questions are a radiogroup named by the question; multi-select ones are checkboxes.
      expect(screen.getByRole("group", { name: new RegExp(q.question) })).toBeTruthy();
      if (q.multiSelect) expect(screen.getAllByRole("checkbox").length).toBeGreaterThan(1);
      else expect(screen.getByRole("radiogroup", { name: q.question })).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: "Answer" }).getAttribute("aria-keyshortcuts")).toBe(
      "Meta+Enter",
    );
  });

  it("answers with the keyboard alone", async () => {
    const onAnswer = vi.fn();
    render(<QuestionCard request={request()} persona="Wren" onAnswer={onAnswer} />);
    const user = userEvent.setup();
    const first = screen.getAllByRole("radio")[0] as HTMLElement;
    first.focus();
    await user.keyboard("{ArrowDown}");
    const checkbox = screen.getAllByRole("checkbox")[0] as HTMLElement;
    checkbox.focus();
    await user.keyboard(" ");
    const answer = screen.getByRole("button", { name: "Answer" });
    answer.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(1));
    const answers = onAnswer.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(answers)).toEqual(["Slot", "Notify"]);
  });
});

describe("checklist and wrap-up", () => {
  const items: ChecklistItem[] = [
    { text: "Read the inbox", status: "completed" },
    { text: "Draft replies", status: "in_progress" },
    { text: "Send Maya's reply", status: "pending" },
  ];

  it("labels the checklist with its progress and the wrap-up actions as buttons", async () => {
    const onAction = vi.fn();
    const { container } = render(
      <>
        <Checklist items={items} pinned />
        <WrapUpBox
          block={{
            type: "wrap_up",
            recap: "Three replies drafted; Maya's is sent.",
            ask: "Send Lena's reply too?",
            actions: [{ label: "Send it" }, { label: "Not now", message: "Leave it in Drafts" }],
          }}
          onAction={onAction}
        />
      </>,
    );
    await expectNoAxeViolations(container);
    expect(screen.getByRole("list", { name: "Checklist, 1 of 3 done" })).toBeTruthy();
    const box = screen.getByRole("article", { name: "Wrap-up" });
    const user = userEvent.setup();
    const notNow = within(box).getByRole("button", { name: "Not now" });
    notNow.focus();
    await user.keyboard("{Enter}");
    expect(onAction).toHaveBeenCalledWith("Leave it in Drafts");
  });
});

describe("chat screen (thread, approval dock, composer)", () => {
  function renderThread() {
    const gateway = new MockGateway(createFixtureWorld(), { now: () => FIXTURE_NOW });
    const store = new GatewayStore(gateway, { now: () => FIXTURE_NOW });
    return render(
      <GatewayProvider client={gateway} store={store}>
        <UiSlotsProvider value={{ persona: { name: "Wren", creature: "moth" } }}>
          <ChatThread threadId={IDS.threads.dentist} now={NOW} />
        </UiSlotsProvider>
      </GatewayProvider>,
    );
  }

  it("renders the conversation log, the dock and a labelled composer without axe violations", async () => {
    const { container } = renderThread();
    expect(await screen.findByRole("log", { name: "Conversation" })).toBeTruthy();
    await waitFor(() => expect(screen.getAllByRole("article").length).toBeGreaterThan(3));
    expect(await screen.findAllByText("Approval needed")).not.toHaveLength(0);
    expect(screen.getByRole("textbox", { name: "Message Wren" })).toBeTruthy();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    await expectNoAxeViolations(container);
  });

  it("reaches the approval dock and the composer with Tab alone", async () => {
    renderThread();
    await screen.findByRole("log", { name: "Conversation" });
    await screen.findAllByText("Approval needed");
    // The dock's open card is answerable once the store has this surface's answer token.
    await screen.findAllByRole("button", { name: "Deny" });
    const user = userEvent.setup();
    // The composer autofocuses; start from the top of the document instead.
    (document.activeElement as HTMLElement | null)?.blur();
    const seen = new Set<Element>();
    for (let i = 0; i < 80; i += 1) {
      await user.tab();
      const el = document.activeElement;
      if (el === null || el === document.body || seen.has(el)) break;
      seen.add(el);
    }
    const names = [...seen].map((el) => computeAccessibleName(el).slice(0, 40));
    const order = names.join(" | ");
    // Every element in the Tab order has an accessible name (docs/06 §4.11).
    expect(
      names.filter((n) => n === ""),
      order,
    ).toEqual([]);
    expect(
      names.some((n) => /Deny|Allow/.test(n)),
      order,
    ).toBe(true);
    expect(names, order).toContain("Message Wren");
    expect(
      names.some((n) => n === "Send" || /Stop the run/.test(n)),
      order,
    ).toBe(true);
  });
});

describe("onboarding", () => {
  it("has no axe violations, a progress nav with the current step, and advances with the keyboard", async () => {
    const onStepChange = vi.fn();
    const { container } = render(
      <OnboardingFlow onComplete={() => {}} onStepChange={onStepChange} />,
    );
    await expectNoAxeViolations(container);
    const nav = screen.getByRole("navigation", { name: "Onboarding progress" });
    expect(nav.querySelector("[aria-current='step']")).not.toBeNull();
    const user = userEvent.setup();
    const name = screen.getAllByRole("textbox")[0] as HTMLElement;
    name.focus();
    await user.keyboard("Wren");
    const next = screen
      .getAllByRole("button")
      .find((b) => /Next|Continue/.test(b.textContent ?? ""));
    expect(next).toBeDefined();
    (next as HTMLElement).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(onStepChange).toHaveBeenCalled());
  });
});

describe("rail", () => {
  it("is a labelled navigation whose items carry their badge count in the name", async () => {
    const { container } = render(<Rail active="chat" badges={{ feed: 2 }} onNavigate={() => {}} />);
    await expectNoAxeViolations(container);
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(nav).toBeTruthy();
    const feed = RAIL_ITEMS.find((i) => i.id === "feed");
    if (feed !== undefined)
      expect(within(nav).getByRole("button", { name: `${feed.label}, 2 new` })).toBeTruthy();
  });
});

describe("reduced motion (docs/06 §4.5)", () => {
  it("follows prefers-reduced-motion when the setting is `system` and the explicit setting otherwise", () => {
    const target = document.createElement("div");
    mediaMatches.add("(prefers-reduced-motion: reduce)");
    const { rerender } = render(
      <ThemeProvider settings={{ reduceMotion: "system" }} target={target} />,
    );
    expect(target.dataset.reduceMotion).toBe("true");
    rerender(<ThemeProvider settings={{ reduceMotion: false }} target={target} />);
    expect(target.dataset.reduceMotion).toBe("false");
    mediaMatches.clear();
    rerender(<ThemeProvider settings={{ reduceMotion: true }} target={target} />);
    expect(target.dataset.reduceMotion).toBe("true");
  });

  it("the kit and shell stylesheets zero animations under the media query and the root attribute", () => {
    const kit = readFileSync(join(ROOT, "packages/ui/src/styles/index.css"), "utf8");
    const shell = readFileSync(join(ROOT, "apps/web/src/shell/shell.css"), "utf8");
    expect(kit).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(kit).toMatch(
      /\[data-reduce-motion="true"\][^{]*\{[^}]*animation-duration: 0ms !important/,
    );
    expect(shell).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[^}]*\{[^}]*animation: none !important/,
    );
  });
});

describe("shell keyboard map (docs/06 §4.11, E10)", () => {
  it("covers every main-flow action with a chord and lists it in the shortcut sheet", () => {
    const actions = new Set(SHORTCUTS.map((s) => s.action));
    for (const a of [
      "palette",
      "approve",
      "deny",
      "stop",
      "agentActivity",
      "agentApprovals",
      "closePane",
      "shortcutList",
      "toggleThreadList",
      "cycleThreads",
    ]) {
      expect(actions.has(a as never), a).toBe(true);
    }
    for (const s of SHORTCUTS) {
      expect(s.label.length, s.action).toBeGreaterThan(0);
      expect(s.chord.key.length, s.action).toBeGreaterThan(0);
    }
    // No two app-scope shortcuts share a chord.
    const chords = SHORTCUTS.filter((s) => s.scope === "app").map(
      (s) =>
        `${s.chord.mod ? "mod+" : ""}${s.chord.shift ? "shift+" : ""}${s.chord.alt ? "alt+" : ""}${s.chord.ctrl ? "ctrl+" : ""}${s.chord.key.toLowerCase()}`,
    );
    expect(new Set(chords).size).toBe(chords.length);
  });
});

describe("the composed app as a window (landmarks, docs/a11y-audit.md A3)", () => {
  it("has one main landmark, a skip link and no page-level violations beyond the baseline", async () => {
    const MAIN = {
      id: "01JBXY6Q8Z0000000000000001",
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
      createdAt: "2026-10-19T10:00:00.000Z",
      updatedAt: "2026-10-19T10:00:00.000Z",
      lastMessageAt: null,
    };
    const activity = { running: 0, awaitingInput: 0, awaitingApproval: 0 };
    const handlers: Record<string, () => unknown> = {
      "settings.get": () => ({
        settings: { "ui.onboarding.completedAt": "2026-10-19T09:00:00.000Z" },
        stateVersion: 1,
      }),
      "threads.list": () => ({ threads: [{ thread: MAIN, activity }], nextCursor: null }),
      "threads.get": () => ({ thread: MAIN, activity }),
      "chat.history": () => ({ messages: [], nextCursor: null }),
      "chat.queue.list": () => ({ items: [] }),
      "events.subscribe": () => ({ ok: true }),
      "memory.read": () => ({ content: '---\nname: "Wren"\n---\n', etag: "e1" }),
    };
    const status = { phase: "paired", health: "ok", attempt: 0 } as const;
    window.innerWidth = 1440;
    window.history.replaceState(null, "", "/chat");
    const { container } = render(
      <PsycheApp
        platform={{
          kind: "web",
          gateway: {
            getStatus: async () => status,
            onStatus: () => () => {},
            call: async (method: string) => {
              const h = handlers[method];
              if (h) return h();
              if (method.endsWith(".list")) return { [method.split(".")[0] ?? "items"]: [] };
              return {};
            },
            onEvent: () => () => {},
            onResync: () => () => {},
          },
          storage: { get: () => null, set: () => {} },
          notify: { show: () => {} },
        }}
      />,
    );
    await screen.findByRole("textbox", { name: "Message Wren" });
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Skip to content" })).toBeTruthy();
    await expectNoAxeViolations(container, AXE_PAGE);
  });
});
