import type { RunStep, SearchSourceStatus } from "@psyche/protocol";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FailureBanner } from "../src/agent/timeline/FailureBanner.tsx";
import { activeI18n, createI18n, setActiveI18n } from "../src/i18n/core.ts";
import { stepErrorText } from "../src/i18n/errors.ts";
import { noticeText } from "../src/i18n/notice.ts";
import { FullDiskAccessRow } from "../src/points/HelperPermissionRow.tsx";
import {
  type ConnectorPermission,
  noPromptText,
  PermissionNotice,
  permissionOf,
  settingsPathText,
} from "../src/screens/settings/connect-flow.tsx";
import { sourceStateText } from "../src/screens/settings/SearchSourcesSettings.tsx";

/** macOS integration follow-ups: machine reasons said in the owner's language, with fallbacks. */

const english = activeI18n();
const german = () => setActiveI18n(createI18n({ locale: "de-DE", language: "de" }));
afterEach(() => setActiveI18n(english));

const failedStep = (error: RunStep["error"]): RunStep =>
  ({
    id: "s1",
    kind: "tool",
    status: "failed",
    label: "Mail",
    startedAt: "2026-11-25T10:00:00.000Z",
    attempt: 1,
    ...(error === undefined ? {} : { error }),
  }) as RunStep;

describe("1. run step errors say their machine reason", () => {
  const raw = "Apple Mail: osascript exited -1743";
  it("uses the reason's sentence, in German too, instead of the raw message", () => {
    const error = {
      code: "tool_failed",
      message: raw,
      retryable: true,
      details: { reason: "automation_denied" },
    };
    expect(stepErrorText(error)).toMatch(/Automation|System Settings/);
    expect(stepErrorText(error)).not.toBe(raw);
    german();
    expect(stepErrorText(error)).toMatch(/Automation/);
    expect(stepErrorText(error)).not.toBe(raw);
  });

  it("falls back to the message with no reason, or one with no sentence", () => {
    expect(stepErrorText({ code: "x", message: raw, retryable: true })).toBe(raw);
    expect(
      stepErrorText({ code: "x", message: raw, retryable: true, details: { reason: "nope_x" } }),
    ).toBe(raw);
  });

  it("shows it in the failure banner", () => {
    render(
      <FailureBanner
        step={failedStep({
          code: "tool_failed",
          message: raw,
          retryable: true,
          details: { reason: "needs_helper" },
        })}
      />,
    );
    const banner = screen.getByTestId("failure-banner").textContent ?? "";
    expect(banner).toMatch(/Psyche Helper/);
    expect(banner).not.toContain(raw);
  });

  it("shows the message in the failure banner when there is no reason", () => {
    render(<FailureBanner step={failedStep({ code: "x", message: raw, retryable: true })} />);
    expect(screen.getByTestId("failure-banner").textContent).toContain(raw);
  });
});

describe("2. search source status says its machine reason", () => {
  const base: SearchSourceStatus = {
    id: "messages",
    label: "Messages",
    enabled: true,
    processing: "local",
    agent: false,
    ocr: false,
    state: "error",
    detail: "needs Full Disk Access to read Messages (raw English)",
    items: 0,
    textBytes: 0,
    backfilled: false,
  };
  it("words the reason, and falls back to the detail without one", () => {
    const withReason = sourceStateText({ ...base, reason: "full_disk_access_missing" }).text;
    expect(withReason).toMatch(/Full Disk Access/);
    expect(withReason).not.toContain("raw English");
    expect(sourceStateText(base).text).toContain("raw English");
    // An unknown reason also keeps the detail.
    expect(sourceStateText({ ...base, reason: "never_heard_of_it" }).text).toContain("raw English");
    german();
    expect(sourceStateText({ ...base, reason: "full_disk_access_missing" }).text).toMatch(
      /Festplattenvollzugriff/,
    );
  });
});

describe("3. the connect flow's path and 'no prompt' reason are localized", () => {
  const perm = (over: Partial<ConnectorPermission> = {}): ConnectorPermission => ({
    settingsPath: "System Settings → Privacy & Security → Automation → Psyche (Helper) → Notizen",
    kind: "automation",
    app: "notes",
    reasonCode: null,
    state: "denied",
    requested: true,
    reason: 'macOS answered "denied"',
    ...over,
  });

  it("builds the System Settings path from the grant, in German", () => {
    german();
    expect(settingsPathText(perm())).toBe(
      "Systemeinstellungen → Datenschutz & Sicherheit → Automation → Psyche (Helper) → Notizen",
    );
    expect(settingsPathText(perm({ kind: "calendars", app: "calendar" }))).toMatch(
      /Systemeinstellungen → Datenschutz & Sicherheit → .+ → Psyche \(Helper\)/,
    );
  });

  it("keeps the Gateway's text when it sent no kind, or a kind it cannot word", () => {
    german();
    expect(settingsPathText(perm({ kind: null, app: null }))).toBe(perm().settingsPath);
    expect(settingsPathText(perm({ kind: "none", app: "mail", settingsPath: "Outlook › X" }))).toBe(
      "Outlook › X",
    );
  });

  it("says the 'no prompt' reason from its code, else wraps the helper's text", () => {
    expect(noPromptText(perm({ reasonCode: "prompt_refused_by_macos" }))).toMatch(
      /didn't show the permission prompt/,
    );
    expect(noPromptText(perm())).toBe('macOS did not show a prompt: macOS answered "denied"');
    // Nothing was asked: nothing to say.
    expect(
      noPromptText(perm({ requested: false, reasonCode: "prompt_refused_by_macos" })),
    ).toBeNull();
    german();
    expect(noPromptText(perm({ reasonCode: "prompt_refused_by_macos" }))).toMatch(
      /Berechtigungsabfrage/,
    );
  });

  it("reads the new fields from the connector's config, and shows them in the notice", () => {
    german();
    const p = permissionOf({
      config: {
        permission: {
          kind: "automation",
          app: "mail",
          state: "denied",
          settingsPath: "English path",
          requested: true,
          reason: "English reason",
          reasonCode: "automation_denied",
        },
      },
    } as never);
    expect(p).toMatchObject({ kind: "automation", app: "mail", reasonCode: "automation_denied" });
    render(<PermissionNotice name="Mail" permission={p as ConnectorPermission} />);
    const text = document.body.textContent ?? "";
    expect(text).toContain("Systemeinstellungen");
    expect(text).not.toContain("English path");
    expect(text).not.toContain("English reason");
  });
});

describe("4. Full Disk Access row", () => {
  it("opens the pane from the row", async () => {
    const onOpen = vi.fn();
    render(<FullDiskAccessRow persona="Wren" onOpen={onOpen} />);
    expect(screen.getByTestId("full-disk-access-row").textContent).toMatch(
      /Full Disk Access.*Wren.*Messages/,
    );
    await userEvent.click(screen.getByRole("button", { name: /Full Disk Access/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe("5. the syncFailing notice says its reason", () => {
  const notice = (reason: string) => ({
    title: "Mail isn't syncing",
    body: `Mail failed to sync several times in a row (${reason}).`,
    message: {
      titleKey: "notice.connector.syncFailing.title",
      bodyKey: "notice.connector.syncFailing.body",
      params: { connectorId: "c1", name: "Mail", reason },
    },
  });
  it("replaces a bare code with its sentence, in German too", () => {
    const en = createI18n({ locale: "en-US", language: "en" });
    const out = noticeText(notice("unavailable"), en);
    expect(out.body).not.toContain("(unavailable)");
    expect(out.body).toContain("Psyche can't do that right now.");
    const de = noticeText(
      notice("automation_denied"),
      createI18n({ locale: "de-DE", language: "de" }),
    );
    expect(de.body).toContain("Automation");
    expect(de.body).not.toContain("automation_denied");
  });
  it("leaves a reason that is not a known code as it came", () => {
    const en = createI18n({ locale: "en-US", language: "en" });
    expect(noticeText(notice("IMAP said no"), en).body).toContain("(IMAP said no)");
    expect(noticeText(notice("made_up_code"), en).body).toContain("(made_up_code)");
  });
});
