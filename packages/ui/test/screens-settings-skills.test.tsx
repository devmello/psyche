import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { FIXTURE_NOW, GREEDY_SKILL_FOLDER, SKILL_FOLDER } from "../src/fixtures/index.ts";
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

/** "Allow once" picks the choice and confirms; "Deny" uses the Deny button. Both wait for arming. */
async function answer(card: HTMLElement, choice: "Allow once" | "Deny") {
  if (choice === "Allow once")
    await userEvent.click(await within(card).findByText("Allow once", { exact: true }));
  const button = within(card).getByRole("button", {
    name: choice === "Deny" ? "Deny" : "Allow with scope",
  });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  await userEvent.click(button);
}

describe("Settings → Skills", () => {
  it("lists installed and bundled skills with status and what each asks for", async () => {
    setup();
    expect(await screen.findByRole("heading", { level: 2, name: "Skills" })).toBeTruthy();
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
    await userEvent.click(await screen.findByRole("button", { name: "Remove receipt-filer" }));
    expect(await screen.findByText("Removed “receipt-filer”.")).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("skill-receipt-filer")).toBeNull());
    expect(gateway().calls.find((c) => c.method === "skills.remove")?.params).toEqual({
      name: "receipt-filer",
    });
    await userEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("Every installed skill is up to date.")).toBeTruthy();
  });

  it("helpers: archive sources and the asks-for line", () => {
    expect(skillSourceOf(" /tmp/x.skill ")).toEqual({ kind: "zip", path: "/tmp/x.skill" });
    expect(skillSourceOf("/tmp/x")).toEqual({ kind: "path", path: "/tmp/x" });
    expect(asksFor({ tools: [], permissions: [], prompts: [] })).toBe(
      "Nothing beyond its instructions.",
    );
  });
});
