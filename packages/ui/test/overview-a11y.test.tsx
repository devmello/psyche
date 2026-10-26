import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Sparkline } from "../src/components/sparkline.tsx";
import { insightsFixtures } from "../src/fixtures/index.ts";
import { I18nProvider } from "../src/i18n/I18nProvider.tsx";
import { OverviewScreen } from "../src/overview/OverviewScreen.tsx";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

/**
 * Overview accessibility (agent-overview-2026 §5.7) beyond axe (test/stories.test.tsx): the
 * heading outline, the keyboard order of the page, the live region for period changes, tiles
 * that announce their number and delta, and a data table behind every chart figure.
 */

afterEach(cleanup);

const SIX_WEEKS_AGO = new Date(STORY_NOW - 42 * 86_400_000).toISOString();

function page() {
  return render(
    <StoryWorld
      edit={(world) => {
        Object.assign(world, { insights: insightsFixtures("typical") });
      }}
    >
      <OverviewScreen
        period="30d"
        onPeriodChange={() => {}}
        data={{ firstActivityAt: SIX_WEEKS_AGO }}
        now={STORY_NOW}
      />
    </StoryWorld>,
  );
}

async function loaded() {
  await screen.findByTestId("overview-activity-facts", {}, { timeout: 3000 });
  await screen.findByTestId("overview-tile-tasks", {}, { timeout: 3000 });
}

describe("Overview accessibility", () => {
  it("has one h1, an h2 for the page body and the sections as h3s, never skipping a level", async () => {
    const { container } = page();
    await loaded();
    const levels = [...container.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((h) =>
      Number(h.tagName.slice(1)),
    );
    expect(levels.filter((l) => l === 1)).toHaveLength(1);
    expect(levels[0]).toBe(1);
    expect(levels.filter((l) => l === 2)).toHaveLength(1);
    for (let i = 1; i < levels.length; i++) {
      expect((levels[i] as number) - (levels[i - 1] as number)).toBeLessThanOrEqual(1);
    }
    for (const id of ["now", "activity", "growth", "upcoming", "recent"]) {
      const section = container.querySelector(`#${id}`) as HTMLElement;
      expect(within(section).getAllByRole("heading", { level: 3 }).length).toBeGreaterThan(0);
    }
  });

  it("tabs from the period control to the tiles to the sections", async () => {
    const { container } = page();
    await loaded();
    const tabbable = [
      ...container.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [role="radio"], [tabindex="0"]',
      ),
    ].filter((el) => el.closest("[aria-hidden='true'], .invisible") === null);
    const index = (el: Element) =>
      tabbable.findIndex((t) => t === el || t.contains(el) || el.contains(t));
    const period = screen.getAllByRole("radio")[0] as HTMLElement;
    const tile = screen.getByTestId("overview-tile-tasks");
    const activity = container.querySelector("#activity") as HTMLElement;
    const upcoming = container.querySelector("#upcoming") as HTMLElement;
    const recent = container.querySelector("#recent") as HTMLElement;
    expect(index(period)).toBeGreaterThanOrEqual(0);
    expect(index(period)).toBeLessThan(index(tile));
    const inActivity = tabbable.findIndex((el) => activity.contains(el));
    expect(index(tile)).toBeLessThan(inActivity);
    expect(inActivity).toBeLessThan(tabbable.findIndex((el) => upcoming.contains(el)));
    expect(tabbable.findIndex((el) => upcoming.contains(el))).toBeLessThan(
      tabbable.findIndex((el) => recent.contains(el)),
    );
  });

  it("announces a period change once, politely, through the range line", async () => {
    page();
    await loaded();
    const range = screen.getByTestId("overview-range");
    expect(range.getAttribute("aria-live")).toBe("polite");
  });

  it("names every tile with its number and its delta", async () => {
    page();
    await loaded();
    for (const id of ["tasks", "automations", "approvals"]) {
      const link = within(screen.getByTestId(`overview-tile-${id}`)).getAllByRole(
        "link",
      )[0] as HTMLElement;
      const name = link.getAttribute("aria-label") ?? "";
      expect(name).toMatch(/\d/);
      expect(name).toMatch(/than last|same as|more|fewer|—/i);
    }
  });

  it("gives each chart figure a caption and a data table", async () => {
    const { container } = page();
    await loaded();
    const activity = container.querySelector("#activity") as HTMLElement;
    await waitFor(() => expect(activity.querySelectorAll("figure").length).toBeGreaterThan(0));
    for (const figure of activity.querySelectorAll("figure")) {
      expect(figure.querySelector("figcaption")).not.toBeNull();
      expect(figure.querySelector("table")).not.toBeNull();
    }
    expect(container.querySelectorAll("figure table").length).toBeGreaterThan(0);
  });

  it("mirrors a sparkline in right-to-left locales (newest on the left)", () => {
    const values = [0, 2, 5, 9];
    const xs = (locale: string) => {
      const { container, unmount } = render(
        <I18nProvider locale={locale}>
          <Sparkline values={values} />
        </I18nProvider>,
      );
      const d = container.querySelector("path")?.getAttribute("d") ?? "";
      unmount();
      return [...d.matchAll(/[ML]([\d.]+),/g)].map((m) => Number(m[1]));
    };
    const ltr = xs("en-US");
    const rtl = xs("ar");
    expect(ltr[0]).toBeLessThan(ltr[3] as number);
    expect(rtl[0]).toBeGreaterThan(rtl[3] as number);
  });

  it("shows a visible focus ring on every interactive control in the page", async () => {
    const { container } = page();
    await loaded();
    const controls = container.querySelectorAll<HTMLElement>(
      'a[href], button, input:not([aria-hidden="true"]), [role="radio"]',
    );
    const bare = [...controls].filter((el) => {
      const own = `${el.className} ${el.closest("[class*='focus-within']")?.className ?? ""}`;
      return !/focus-visible:|focus:|has-\[:focus|focus-within/.test(own);
    });
    expect(
      bare.map((el) => `${el.tagName} ${el.getAttribute("aria-label") ?? el.textContent}`),
    ).toEqual([]);
  });
});
