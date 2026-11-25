import type { Connector } from "@psyche/protocol";
import { PsycheError } from "@psyche/protocol";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activeI18n, createI18n, setActiveI18n } from "../src/i18n/core.ts";
import { codeSentence, describeError } from "../src/i18n/errors.ts";
import { HelperPermissionRow } from "../src/points/HelperPermissionRow.tsx";
import { failureReason } from "../src/screens/settings/ConnectorDetail.tsx";
import { connectorsToRecheck } from "../src/screens/settings/ConnectorsSection.tsx";

/** The macOS integration clean-up: what the owner is told when a grant is missing or stale. */

const english = activeI18n();
afterEach(() => setActiveI18n(english));

describe("Psyche Helper permission row: lost grants and restart to apply", () => {
  it("says a grant was lost after an update and offers a restart", async () => {
    const onRestart = vi.fn();
    render(
      <HelperPermissionRow
        permission="screenRecording"
        state="not_determined"
        persona="Wren"
        onAllow={() => undefined}
        notice="lost"
        onRestart={onRestart}
      />,
    );
    expect(screen.getByRole("status").textContent).toMatch(/usually after an update/);
    await userEvent.click(screen.getByRole("button", { name: /^Restart Psyche Helper to apply/ }));
    expect(onRestart).toHaveBeenCalledTimes(1);
    // Allow stays: it opens the pane where the owner turns the switch off and on.
    expect(screen.getByRole("button", { name: /^Allow Psyche Helper for/ })).toBeTruthy();
  });

  it("says a new Screen Recording grant needs a restart", () => {
    render(
      <HelperPermissionRow
        permission="screenRecording"
        state="not_determined"
        persona="Wren"
        notice="restart"
        onRestart={() => undefined}
      />,
    );
    expect(screen.getByRole("status").textContent).toMatch(/once Psyche Helper restarts/);
  });

  it("shows no notice once granted, or while the helper is offline", () => {
    const { rerender } = render(
      <HelperPermissionRow
        permission="accessibility"
        state="granted"
        persona="Wren"
        notice="lost"
        onRestart={() => undefined}
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("button", { name: /Restart/ })).toBeNull();
    rerender(
      <HelperPermissionRow
        permission="accessibility"
        state="not_determined"
        persona="Wren"
        offline
        notice="lost"
        onRestart={() => undefined}
      />,
    );
    expect(screen.queryByRole("button", { name: /Restart/ })).toBeNull();
  });
});

const connector = (over: Partial<Connector> & { config?: Record<string, unknown> }) =>
  ({
    id: "c1",
    type: "apple-mail",
    label: "Apple Mail",
    status: "needs_auth",
    scopeMode: "read",
    config: {},
    ...over,
  }) as unknown as Connector;

describe("connectors re-checked when the owner comes back from System Settings", () => {
  it("re-checks only a waiting connector whose grant macOS denied", () => {
    const denied = connector({ id: "a", config: { permission: { state: "denied" } } });
    const notAsked = connector({ id: "b", config: { permission: { state: "not_determined" } } });
    const connected = connector({
      id: "c",
      status: "connected",
      config: { permission: { state: "denied" } },
    });
    const noGrant = connector({ id: "d" });
    expect(connectorsToRecheck([denied, notAsked, connected, noGrant]).map((c) => c.id)).toEqual([
      "a",
    ]);
  });
});

describe("connector and helper errors in the owner's language", () => {
  it("says a sync failure's bare code in words", () => {
    const failing = connector({ status: "error", lastSync: { error: "unavailable" } } as never);
    expect(failureReason(failing)).toBe("Psyche can't do that right now.");
    // Text the catalogue has nothing for is shown as it came.
    const odd = connector({ status: "error", lastSync: { error: "IMAP said no" } } as never);
    expect(failureReason(odd)).toBe("IMAP said no");
    expect(codeSentence("no_such_code_here")).toBeNull();
  });

  it("names the macOS grant to fix for each helper refusal, in German too", () => {
    setActiveI18n(createI18n({ locale: "de-DE" }));
    const reasons = [
      ["automation_denied", /Automation/],
      ["full_disk_access_missing", /Festplattenvollzugriff/],
      ["permission_missing", /Datenschutz & Sicherheit/],
      ["prompt_refused_by_macos", /Berechtigungsabfrage/],
      ["needs_helper", /Psyche Helper/],
    ] as const;
    for (const [reason, expected] of reasons) {
      const err = new PsycheError("unavailable", "Apple Mail: Automation was denied", {
        details: { reason },
      });
      expect(describeError(err), reason).toMatch(expected);
    }
    // Control: a reason with no sentence falls back to the code's generic one.
    const other = new PsycheError("unavailable", "x", { details: { reason: "nope" } });
    expect(describeError(other)).not.toMatch(/Psyche Helper/);
  });
});
