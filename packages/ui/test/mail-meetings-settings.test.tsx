import { MAIL_MEETING_SETTING_DEFAULTS as D } from "@psyche/protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { MAIL_DEFAULTS, mailSettings } from "../src/screens/onboarding/MailStep.tsx";
import { OnboardingFlow } from "../src/screens/onboarding/OnboardingFlow.tsx";
import {
  MailMeetingsPanel,
  MailMeetingsSection,
} from "../src/screens/settings/MailMeetingsSection.tsx";
import { matchSections, sectionForKey } from "../src/screens/settings/SettingsScreen.tsx";
import { settingLabel } from "../src/screens/settings/setting-labels.ts";
import { StoryWorld } from "../src/stories/harness.tsx";

/** Settings → Mail & meetings and the onboarding mail step (mail-and-meetings-2026 §7.3, §7.5). */

const accounts = [{ id: "conn_gmail", label: "Gmail" }];
const base = { values: {}, accounts, localModels: [], onChange: () => {} };

describe("Settings → Mail & meetings", () => {
  it("is a section under General that settings search and keys find", () => {
    expect(matchSections("mail").has("mail")).toBe(true);
    expect(sectionForKey("meetings.prep.enabled")).toBe("mail");
    expect(sectionForKey("workflows.paused")).toBe("mail");
    expect(settingLabel("mail.accounts.conn_gmail")).toBe(
      "Use conn_gmail in digest and follow-ups",
    );
  });

  it("shows pause and read-only first, then one group per workflow", () => {
    render(<MailMeetingsPanel {...base} />);
    const groups = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(groups).toEqual([
      "Everything at once",
      "Accounts",
      "Inbox digest",
      "Follow-ups",
      "Writing style",
      "Scheduling",
      "Meeting prep",
      "Meeting notes",
      "Checking for new mail",
    ]);
  });

  it("starts every workflow off and the style learning off", () => {
    render(<MailMeetingsPanel {...base} />);
    for (const name of [
      "Inbox digest",
      "Track replies you’re waiting on",
      "Learn from sent mail",
      "Meeting prep",
      "Meeting notes from recordings",
    ]) {
      expect(screen.getByRole("switch", { name }).getAttribute("aria-checked")).toBe("false");
    }
    // Summarizing with a cloud model needs the owner's explicit yes (§3 rule 7).
    expect(
      screen
        .getByRole("switch", { name: "Summarize with a cloud model" })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("writes a switch as a Gateway setting and sets the rest aside while paused", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<MailMeetingsPanel {...base} onChange={onChange} />);
    await user.click(screen.getByRole("switch", { name: "Inbox digest" }));
    expect(onChange).toHaveBeenCalledWith("mail.digest.enabled", true);
    await user.click(screen.getByRole("switch", { name: "Pause all mail and meeting workflows" }));
    expect(onChange).toHaveBeenCalledWith("workflows.paused", true);
    rerender(<MailMeetingsPanel {...base} values={{ "workflows.paused": true }} />);
    expect(screen.getByRole("switch", { name: "Inbox digest" }).hasAttribute("data-disabled")).toBe(
      true,
    );
    expect(
      screen
        .getByRole("switch", { name: "Pause all mail and meeting workflows" })
        .hasAttribute("data-disabled"),
    ).toBe(false);
  });

  it("shows the Gateway's defaults for keys that are unset", () => {
    render(<MailMeetingsPanel {...base} />);
    const value = (name: string) =>
      (screen.getByRole("combobox", { name }) as HTMLSelectElement).value;
    expect(value("Prepare ahead of the meeting")).toBe(String(D["meetings.prep.leadMin"]));
    expect(value("Tell me before it starts")).toBe(String(D["meetings.prep.notifyMin"]));
    expect(value("While you’re active")).toBe(String(D["mail.poll.activeMin"]));
    expect(value("Otherwise")).toBe(String(D["mail.poll.idleMin"]));
    expect(value("Wait before it shows up")).toBe(String(D["mail.followups.waitDays"]));
    expect(value("Most preps a day")).toBe(String(D["meetings.prep.dailyCap"]));
  });

  it("hands View, Edit and Reset of the voice profile to the composer", async () => {
    const onAsk = vi.fn();
    const user = userEvent.setup();
    render(<MailMeetingsPanel {...base} onAsk={onAsk} />);
    await user.click(screen.getByRole("button", { name: "Reset" }));
    expect(onAsk).toHaveBeenCalledWith(expect.stringContaining("mail/VOICE.md"));
  });

  it("offers local models only, and says when there are none", () => {
    const { rerender } = render(<MailMeetingsPanel {...base} />);
    expect(screen.getByText("No local model is set up.")).toBeTruthy();
    rerender(<MailMeetingsPanel {...base} localModels={["ollama/qwen3-8b"]} />);
    const select = screen.getByRole("combobox", { name: "Draft with a local model" });
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Use the primary model", "ollama/qwen3-8b"]);
  });

  it("is wired to the Gateway's settings", async () => {
    let gateway: MockGateway | undefined;
    const user = userEvent.setup();
    render(
      <StoryWorld onGateway={(g) => (gateway = g)}>
        <MailMeetingsSection />
      </StoryWorld>,
    );
    await user.click(await screen.findByRole("switch", { name: "Inbox digest" }));
    await waitFor(() =>
      expect(gateway?.calls).toContainEqual(
        expect.objectContaining({
          method: "settings.set",
          params: expect.objectContaining({ key: "mail.digest.enabled", value: true }),
        }),
      ),
    );
  });
});

describe("the onboarding mail step", () => {
  const connected = [{ type: "apple:mail", label: "Apple Mail", mode: "read" as const }];

  it("is left out until a mail account is connected", () => {
    render(
      <StoryWorld>
        <OnboardingFlow onComplete={vi.fn()} defaultStep="connectors" onConnect={() => true} />
      </StoryWorld>,
    );
    const dots = screen.getByRole("navigation", { name: "Onboarding progress" });
    expect(within(dots).queryByText("Mail and meetings")).toBeNull();
  });

  it("offers each workflow with its own switch, style learning off, and reports the choices", async () => {
    const onComplete = vi.fn();
    const user = userEvent.setup();
    render(
      <StoryWorld>
        <OnboardingFlow
          onComplete={onComplete}
          defaultStep="mail"
          initial={{ connectors: connected }}
          onConnect={() => true}
          macPermissions={false}
        />
      </StoryWorld>,
    );
    expect(screen.getByRole("heading", { level: 1, name: /Mail and meetings/ })).toBeTruthy();
    expect(
      screen
        .getByRole("switch", { name: "Morning inbox digest at 7:30" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    const voice = screen.getByRole("switch", { name: "Learn my writing style from sent mail" });
    expect(voice.getAttribute("aria-checked")).toBe("false");
    await user.click(screen.getByRole("switch", { name: "Track replies you’re waiting on" }));
    await user.click(screen.getByRole("button", { name: /Next/ }));
    // Sandbox, Model, Where, Memory, First wins, Habits, Done
    await user.click(await screen.findByRole("button", { name: /Next/ }));
    await user.click(await screen.findByRole("button", { name: /Next/ }));
    await user.click(await screen.findByRole("button", { name: /Next/ }));
    await user.click(await screen.findByRole("button", { name: /Next/ }));
    await user.click(await screen.findByRole("button", { name: /Next/ }));
    await user.click(await screen.findByRole("button", { name: /Next/ }));
    await user.click(await screen.findByRole("button", { name: /Open chat|Open/ }));
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ mail: { ...MAIL_DEFAULTS, followups: false } }),
    );
  });

  it("turns the choices into Gateway settings", () => {
    expect(mailSettings(MAIL_DEFAULTS)).toEqual({
      "mail.digest.enabled": true,
      "mail.digest.time": "07:30",
      "meetings.prep.enabled": true,
      "mail.followups.enabled": true,
      "mail.voice.enabled": false,
      "meetings.notes.enabled": true,
    });
    expect(mailSettings({ ...MAIL_DEFAULTS, digest: false })["mail.digest.enabled"]).toBe(false);
  });
});
