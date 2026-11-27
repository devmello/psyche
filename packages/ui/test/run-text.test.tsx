import type { RunStep } from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { stepLabel as timelineLabel } from "../src/agent/timeline/model.ts";
import { stepLabel as chatLabel } from "../src/chat/steps/model.ts";
import { activeI18n, createI18n, setActiveI18n } from "../src/i18n/core.ts";
import { feedBodyText, runStepText, systemNoteText } from "../src/i18n/run-text.ts";

const before = activeI18n();
afterEach(() => setActiveI18n(before));
const german = () => setActiveI18n(createI18n({ locale: "de-DE" }));

const step = (over: Partial<RunStep>): RunStep => ({
  id: "stp_1",
  runId: "run_1",
  seq: 1,
  kind: "text",
  status: "running",
  label: "Writing a reply",
  doneLabel: "Wrote a reply",
  startedAt: "2026-11-25T10:00:00.000Z",
  endedAt: null,
  attempt: 1,
  ...over,
});

describe("Gateway-authored run text, worded by the UI", () => {
  it("words a keyed step in the owner's language, in both tenses and in both step views", () => {
    german();
    const open = step({ labelKey: "reply" });
    const closed = step({ labelKey: "reply", status: "ok", endedAt: "2026-11-25T10:00:01.000Z" });
    expect(runStepText(open, false)).toBe("Schreibt eine Antwort");
    expect(chatLabel(open)).toBe("Schreibt eine Antwort");
    expect(chatLabel(closed)).toBe("Antwort geschrieben");
    expect(timelineLabel(closed)).toBe("Antwort geschrieben");
    expect(timelineLabel(open)).toBe("Schreibt eine Antwort");
  });

  it("shows the stored text of an older row that has no key (control)", () => {
    german();
    const old = step({ label: "Writing a reply" });
    expect(chatLabel(old)).toBe("Writing a reply");
    expect(timelineLabel(old)).toBe("Writing a reply");
    expect(runStepText(step({ status: "ok", endedAt: "x" }), true)).toBe("Wrote a reply");
  });

  it("words the restart note only for the key it knows", () => {
    german();
    expect(
      systemNoteText({
        md: "The Gateway restarted during this turn, so it was stopped.",
        noteKey: "gateway_restart",
      }),
    ).toContain("Psyche");
    expect(systemNoteText({ md: "x", noteKey: "gateway_restart" })).not.toBe("x");
    // Controls: no key, or a key from a newer Gateway, shows the stored text.
    expect(systemNoteText({ md: "stored" })).toBe("stored");
    expect(systemNoteText({ md: "stored", noteKey: "from_the_future" })).toBe("stored");
  });

  it("words the generic run line of the Feed, and leaves a real summary alone", () => {
    german();
    expect(feedBodyText("The run finished.")).toBe("Der Lauf ist beendet.");
    expect(feedBodyText("The run did not finish.")).toBe("Der Lauf wurde nicht beendet.");
    expect(feedBodyText("Tuesday: a quiet cup.")).toBe("Tuesday: a quiet cup.");
  });
});
