import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { FIXTURE_NOW, GREEDY_SKILL_FOLDER, SKILL_FOLDER } from "../src/fixtures/index.ts";
import { SKILL_BUNDLE_FILE, WIDER_BUNDLE_FILE } from "../src/fixtures/skills.ts";
import { SettingsScreen } from "../src/screens/settings/SettingsScreen.tsx";
import { asksFor, skillSourceOf } from "../src/screens/settings/SkillsSection.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

/** Settings → Skills (feature T2): list, install from a folder through the trust card, remove. */

function setup(): () => MockGateway {
  let gw: MockGateway | null = null;
  render(
    <StoryWorld onGateway={(g) => (gw = g)}>
      <SettingsScreen now={Date.parse(FIXTURE_NOW)} defaultSection="skills" />
    </StoryWorld>,
  );
  return () => {
    if (gw === null) throw new Error("gateway not ready");
    return gw;
  };
}

const methods = (g: MockGateway) => g.calls.map((c) => c.method);

/** "Allow once" is the Allow button's default scope; both buttons wait for arming. */
async function answer(card: HTMLElement, choice: "Allow once" | "Deny") {
  const button = within(card).getByRole("button", {
    name: choice === "Deny" ? "Deny" : "Allow with scope",
  });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  await userEvent.click(button);
}

describe("Settings → Skills", () => {
  it("lists installed and bundled skills with status and what each asks for", async () => {
    setup();
    expect(await screen.findByRole("heading", { level: 3, name: "Skills" })).toBeTruthy();
    const row = await screen.findByTestId("skill-receipt-filer");
    expect(within(row).getByText("Active")).toBeTruthy();
    expect(within(row).getByText("Update available")).toBeTruthy();
    expect(within(row).getByText(/Write files · 2 tools/)).toBeTruthy();
    const blocked = screen.getByTestId("skill-crypto-helper");
    expect(within(blocked).getByText("Blocked")).toBeTruthy();
    expect(within(blocked).queryByRole("switch")).toBeNull();
    const bundled = screen.getByRole("region", { name: "Bundled with Psyche" });
    expect(within(bundled).getByTestId("skill-inbox-triage")).toBeTruthy();
    expect(within(bundled).queryByRole("button", { name: /Remove/ })).toBeNull();
    // An unavailable skill says what is missing and where to fix it (#506).
    const unavailable = within(bundled).getByTestId("skill-calendar-planning");
    expect(
      within(unavailable).getByText(/needs a calendar: connect Google Calendar or Apple Calendar/),
    ).toBeTruthy();
  });

  it("reviews a folder, shows the trust card, and installs once the owner approves", async () => {
    const gateway = setup();
    await userEvent.type(
      await screen.findByLabelText("Skill folder or .zip on the Gateway"),
      `${SKILL_FOLDER}{Enter}`,
    );
    const card = await screen.findByTestId("skill-trust-card");
    expect(within(card).getByRole("heading", { name: /Review “pdf-merge” before installing/ }));
    const asks = within(card).getByRole("region", { name: "What it asks for" });
    expect(within(asks).getByText("Write files")).toBeTruthy();
    // Tool names, the hash and the commit are level 2, in Details (audit decision 8).
    expect(within(asks).getByText("3 tools")).toBeTruthy();
    expect(within(asks).queryByText("list_dir, read_file, write_file")).toBeNull();
    const details = within(card).getByText("Content hash").closest("details") as HTMLElement;
    expect(within(details).getByText("list_dir, read_file, write_file")).toBeTruthy();
    expect(within(details).getByText("Content hash")).toBeTruthy();
    expect(within(asks).getByText("prompts/naming.md")).toBeTruthy();
    expect(within(card).getByTestId("skill-text").textContent).toContain("# Merge PDFs");
    expect(within(card).getByText("The static scan found nothing to flag.")).toBeTruthy();
    expect(methods(gateway())).not.toContain("skills.install");

    // The device-only skill_install card sits under the trust card; it offers "Allow once" only.
    expect(within(card).queryByText("Always allow")).toBeNull();
    await answer(card, "Allow once");

    expect(await screen.findByText("Installed “pdf-merge”.")).toBeTruthy();
    expect(methods(gateway())).toContain("skills.install");
    expect(await screen.findByTestId("skill-pdf-merge")).toBeTruthy();
    expect(screen.queryByTestId("skill-trust-card")).toBeNull();
  });

  it("refuses a skill whose manifest asks for more than the policy allows, with no card", async () => {
    const gateway = setup();
    await userEvent.type(
      await screen.findByLabelText("Skill folder or .zip on the Gateway"),
      `${GREEDY_SKILL_FOLDER}{Enter}`,
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Psyche won't install this skill");
    expect(alert.textContent).toContain("exec_host");
    expect(screen.queryByTestId("skill-trust-card")).toBeNull();
    expect(gateway().world.approvals.some((a) => a.kind === "skill_install")).toBe(false);
  });

  it("denying the card installs nothing", async () => {
    const gateway = setup();
    await userEvent.type(
      await screen.findByLabelText("Skill folder or .zip on the Gateway"),
      `${SKILL_FOLDER}{Enter}`,
    );
    const card = await screen.findByTestId("skill-trust-card");
    await answer(card, "Deny");
    expect(await screen.findByText("Not installed: you denied “pdf-merge”.")).toBeTruthy();
    expect(methods(gateway())).not.toContain("skills.install");
  });

  it("removes an installed skill and checks for updates", async () => {
    const gateway = setup();
    await userEvent.click(await screen.findByRole("button", { name: "More for receipt-filer" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Remove" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Remove receipt-filer?" });
    await userEvent.click(within(confirm).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Removed “receipt-filer”.")).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("skill-receipt-filer")).toBeNull());
    expect(gateway().calls.find((c) => c.method === "skills.remove")?.params).toEqual({
      name: "receipt-filer",
    });
    await userEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("Every installed skill is up to date.")).toBeTruthy();
  });

  it("imports a signed bundle file: the card names the signer, and 'trust this author' is part of the card", async () => {
    const gateway = setup();
    const input = await screen.findByLabelText("Import a file…");
    await userEvent.upload(
      input,
      new File(["{}"], SKILL_BUNDLE_FILE, { type: "application/json" }),
    );
    const card = await screen.findByTestId("skill-trust-card");
    expect(within(card).getByTestId("skill-signer").textContent).toContain(
      "Signed by Ada Lovelace. You have not seen this key before.",
    );
    expect(within(card).getByText(SKILL_BUNDLE_FILE)).toBeTruthy();
    expect(within(card).getByRole("region", { name: "What it asks for" })).toBeTruthy();
    expect(within(card).queryByTestId("skill-widened")).toBeNull();
    expect(gateway().calls.find((c) => c.method === "skills.proposeImport")?.params).toMatchObject({
      name: SKILL_BUNDLE_FILE,
    });
    // Ticking the box stages the review again with trustAuthor, so the approver's card binds it.
    await userEvent.click(
      within(card).getByRole("checkbox", { name: "Trust Ada Lovelace as an author" }),
    );
    await waitFor(() =>
      expect(gateway().calls.filter((c) => c.method === "skills.proposeImport")).toHaveLength(2),
    );
    expect(
      gateway().calls.filter((c) => c.method === "skills.proposeImport")[1]?.params,
    ).toMatchObject({ trustAuthor: true });
    const again = await screen.findByTestId("skill-trust-card");
    await waitFor(() =>
      expect(
        within(again)
          .getByRole("checkbox", { name: "Trust Ada Lovelace as an author" })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
    await answer(again, "Allow once");
    expect(await screen.findByText("Installed “pdf-merge”.")).toBeTruthy();
    // The install call carries no flag of its own: the approved card already says it.
    expect(gateway().calls.find((c) => c.method === "skills.install")?.params).not.toHaveProperty(
      "trustAuthor",
    );
  });

  it("without the box ticked, trustAuthor is not sent", async () => {
    const gateway = setup();
    await userEvent.upload(
      await screen.findByLabelText("Import a file…"),
      new File(["{}"], SKILL_BUNDLE_FILE),
    );
    await answer(await screen.findByTestId("skill-trust-card"), "Allow once");
    expect(await screen.findByText("Installed “pdf-merge”.")).toBeTruthy();
    expect(gateway().calls.find((c) => c.method === "skills.install")?.params).not.toHaveProperty(
      "trustAuthor",
    );
  });

  it("an update with a changed key and wider permissions says so before anything else", async () => {
    setup();
    await userEvent.upload(
      await screen.findByLabelText("Import a file…"),
      new File(["{}"], WIDER_BUNDLE_FILE),
    );
    const card = await screen.findByTestId("skill-trust-card");
    const signer = within(card).getByTestId("skill-signer");
    expect(signer.textContent).toContain("different key than the version you have installed");
    expect(signer.getAttribute("role")).toBe("alert");
    // Text Psyche wrote for the sender is labelled, whoever signed it.
    expect(within(card).getByTestId("skill-origin").textContent).toContain(
      "Written by an assistant",
    );
    const widened = within(card).getByTestId("skill-widened");
    expect(widened.textContent).toContain("Asks for more than the installed version");
    expect(widened.textContent).toContain("email.*");
    expect(widened.textContent).toContain("Send email");
    // Not an author the owner has seen: the trust box is offered, unticked.
    const box = within(card).getByRole("checkbox", { name: "Trust Ada Lovelace as an author" });
    expect(box.getAttribute("aria-checked")).toBe("false");
  });

  it("skills from elsewhere offer no export (the key never signs someone else's work)", async () => {
    const gateway = setup();
    await userEvent.click(await screen.findByRole("button", { name: "More for receipt-filer" }));
    // receipt-filer is a home skill from elsewhere: no export entry.
    expect(screen.queryByRole("menuitem", { name: "Export…" })).toBeNull();
    expect(methods(gateway())).not.toContain("skills.export");
  });

  it("helpers: archive sources and the asks-for line", () => {
    expect(skillSourceOf(" https://example.com/a.psyche-skill ")).toEqual({
      kind: "bundleUrl",
      url: "https://example.com/a.psyche-skill",
    });
    expect(skillSourceOf(" /tmp/x.skill ")).toEqual({ kind: "zip", path: "/tmp/x.skill" });
    expect(skillSourceOf("/tmp/x")).toEqual({ kind: "path", path: "/tmp/x" });
    expect(asksFor({ tools: [], permissions: [], prompts: [] })).toBe(
      "Nothing beyond its instructions.",
    );
  });
});

describe("Settings → Skills: suggestions (T3)", () => {
  it("shows what the agent proposed, with steps and what it removed", async () => {
    setup();
    const card = await screen.findByTestId("skill-draft-export-week-invoices-finance");
    expect(within(card).getByText("Seen 3 times")).toBeTruthy();
    expect(within(card).getByText(/removed 1 personal or secret value/)).toBeTruthy();
    expect(within(card).getByText("write_file")).toBeTruthy();
    const group = screen.getByRole("region", { name: /^Suggested by / });
    expect(within(group).getByText(/Nothing is installed until you review it/)).toBeTruthy();
  });

  it("edits, then reviews through the trust card and installs only after approval", async () => {
    const gateway = setup();
    const card = await screen.findByTestId("skill-draft-export-week-invoices-finance");
    await userEvent.click(within(card).getByRole("button", { name: "Edit" }));
    const box = within(card).getByLabelText("SKILL.md");
    await userEvent.type(box, "{End}Extra note.");
    await userEvent.click(within(card).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(gateway().calls.some((c) => c.method === "skills.drafts.update")).toBe(true),
    );
    await userEvent.click(
      await within(
        await screen.findByTestId("skill-draft-export-week-invoices-finance"),
      ).findByRole("button", { name: "Review and install" }),
    );
    const trust = await screen.findByTestId("skill-trust-card");
    expect(within(trust).getByTestId("skill-text").textContent).toContain("Extra note.");
    expect(methods(gateway())).not.toContain("skills.install");
    await answer(trust, "Allow once");
    expect(await screen.findByText("Installed “export-week-invoices-finance”.")).toBeTruthy();
    expect(methods(gateway())).toContain("skills.install");
  });

  it("dismissing a suggestion removes it and says it won't come back", async () => {
    const gateway = setup();
    await userEvent.click(
      await screen.findByRole("button", { name: "Dismiss export-week-invoices-finance" }),
    );
    expect(await screen.findByText(/won't suggest that routine again/)).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByTestId("skill-draft-export-week-invoices-finance")).toBeNull(),
    );
    expect(gateway().world.skillDrafts[0]?.status).toBe("dismissed");
  });
});
