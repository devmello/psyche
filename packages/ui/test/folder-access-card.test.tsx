import type { ApprovalRequest } from "@psyche/protocol";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApprovalCard } from "../src/blocks/ApprovalCard.tsx";
import { createFixtureWorld, FIXTURE_NOW } from "../src/fixtures/index.ts";
import { UiSlotsProvider } from "../src/slots.tsx";

/**
 * The folder-access card (security §3.5): the folder the Gateway resolved is pre-filled and is
 * exactly what is sent; the picker replaces it; a blocked or missing path needs the picker; taint
 * leaves only Allow once, explained in plain words with the raw ids under Details.
 */

const NOW = Date.parse(FIXTURE_NOW);

function folderApproval(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  const base = createFixtureWorld().approvals.find((a) => a.status === "pending");
  if (!base) throw new Error("no pending approval fixture");
  return {
    ...base,
    kind: "folder_access",
    summary: "Share a folder: ~/Projects/app",
    details: {
      requestedPath: "~/Projects/app",
      reason: "to read the build notes",
      access: "rw",
      folderStatus: "ok",
      resolvedPath: "/Users/me/Projects/app",
    },
    scopesOffered: ["once", "always"],
    deviceOnly: true,
    requiresAuthentication: false,
    taint: false,
    ...over,
  } as ApprovalRequest;
}

function show(
  approval: ApprovalRequest,
  pickFolder?: () => Promise<string | null>,
  onAnswer = vi.fn(),
  persona?: string,
) {
  render(
    <UiSlotsProvider value={pickFolder ? { pickFolder } : {}}>
      <ApprovalCard
        approval={approval}
        canAnswer
        now={NOW}
        armDelayMs={0}
        onAnswer={onAnswer}
        {...(persona ? { persona } : {})}
      />
    </UiSlotsProvider>,
  );
  return onAnswer;
}

const unresolved = (details: Record<string, unknown>) =>
  folderApproval({
    details: { requestedPath: "~/Downloads", reason: "to list it", access: "ro", ...details },
  });

const allow = () => screen.getByRole("button", { name: "Allow with scope" });

describe("folder-access card", () => {
  it("pre-fills the requested folder by name with its full path, and Allow is enabled", async () => {
    const onAnswer = show(folderApproval(), async () => null);
    expect(screen.getByTestId("folder-name").textContent).toBe("Projects/app".split("/")[1]);
    expect(screen.getByTestId("folder-picked").textContent).toBe("/Users/me/Projects/app");
    expect(screen.queryByText(/Choose the folder to share before allowing/)).toBeNull();
    expect(allow().hasAttribute("disabled")).toBe(false);
    await userEvent.click(allow());
    await waitFor(() =>
      expect(onAnswer).toHaveBeenCalledWith("approve", "once", {
        folderPath: "/Users/me/Projects/app",
      }),
    );
  });

  it("shows the reason and access once, and the scope rides on Allow", async () => {
    const onAnswer = show(folderApproval(), async () => null);
    expect(screen.getAllByText("to read the build notes")).toHaveLength(1);
    expect(screen.getByText("Read and write")).toBeTruthy();
    for (const name of ["Allow once", "Always allow"]) {
      expect(screen.getByRole("option", { name })).toBeTruthy();
    }
    expect(screen.getAllByRole("button", { name: "Deny" })).toHaveLength(1);
    expect(screen.queryByRole("radio")).toBeNull();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Allow for" }), "always");
    await userEvent.click(allow());
    await waitFor(() =>
      expect(onAnswer).toHaveBeenCalledWith("approve", "always", {
        folderPath: "/Users/me/Projects/app",
      }),
    );
  });

  it("Choose a different folder… replaces the pre-filled one, and that pick is what is sent", async () => {
    const pick = vi.fn(async () => "/Users/me/Documents/other");
    const onAnswer = show(folderApproval(), pick);
    await userEvent.click(screen.getByRole("button", { name: "Choose a different folder…" }));
    await waitFor(() =>
      expect(screen.getByTestId("folder-picked").textContent).toBe("/Users/me/Documents/other"),
    );
    expect(screen.getByTestId("folder-name").textContent).toBe("other");
    await userEvent.click(allow());
    await waitFor(() =>
      expect(onAnswer).toHaveBeenCalledWith("approve", "once", {
        folderPath: "/Users/me/Documents/other",
      }),
    );
  });

  it("a blocked root disables Allow, says why and offers the picker", async () => {
    const pick = vi.fn(async () => "/Users/me/Documents");
    const onAnswer = show(unresolved({ folderStatus: "blocked", resolvedPath: "/Users/me" }), pick);
    expect(screen.getByTestId("folder-blocked").textContent).toMatch(/\/Users\/me can't be shared/);
    expect(allow().hasAttribute("disabled")).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    await waitFor(() => expect(allow().hasAttribute("disabled")).toBe(false));
    await userEvent.click(allow());
    await waitFor(() =>
      expect(onAnswer).toHaveBeenCalledWith("approve", "once", {
        folderPath: "/Users/me/Documents",
      }),
    );
  });

  it("a missing path falls back to requiring the picker", async () => {
    show(unresolved({ folderStatus: "missing" }), async () => "/Users/me/Downloads");
    expect(screen.getByTestId("folder-missing").textContent).toMatch(/couldn't find a folder/);
    expect(allow().hasAttribute("disabled")).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    await waitFor(() => expect(allow().hasAttribute("disabled")).toBe(false));
  });

  it("a card without a resolution (older Gateway) still requires the picker", () => {
    show(
      folderApproval({ details: { requestedPath: "~/x", reason: "r", access: "ro" } }),
      async () => null,
    );
    expect(allow().hasAttribute("disabled")).toBe(true);
  });

  it("a tainted request offers only Allow once, in plain words, with raw ids under Details", async () => {
    show(
      folderApproval({
        taint: true,
        scopesOffered: ["once"],
        taintSources: [
          { sourceKind: "transcript" },
          { sourceKind: "screen", origin: "https://canvas.ucsc.edu/" },
          {
            sourceKind: "mcp__apple-reminders-mvp8e06m2__reminders_create",
            origin: "apple-reminders-mvp8e06m2",
          },
        ],
        details: {
          requestedPath: "~/Projects/app",
          reason: "to read the build notes",
          access: "ro",
          folderStatus: "ok",
          resolvedPath: "/Users/me/Projects/app",
          taintSources: [
            "transcript:?",
            "screen:https://canvas.ucsc.edu/",
            "mcp__apple-reminders-mvp8e06m2__reminders_create:apple-reminders-mvp8e06m2",
          ],
        },
      }),
      async () => null,
      vi.fn(),
      "Psyche",
    );
    expect(screen.queryByRole("combobox", { name: "Allow for" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Always allow" })).toBeNull();
    expect(screen.getByTestId("taint-note").textContent).toBe(
      "Earlier in this chat Psyche read a transcript and canvas.ucsc.edu and used Reminders, so only Allow once is offered.",
    );
    // No raw ids in the card until Details is opened.
    expect(screen.queryByText(/mvp8e06m2/)).toBeNull();
    expect(screen.queryByText("Taint sources")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "More about this approval" }));
    await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Details" }));
    expect(screen.getByTestId("approval-ids").textContent).toMatch(/mvp8e06m2/);
    expect(screen.getByTestId("approval-ids").textContent).toMatch(/Taint sources/);
  });

  it("Deny needs no folder", async () => {
    const onAnswer = show(unresolved({ folderStatus: "missing" }), async () => null);
    await userEvent.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("deny", undefined, undefined));
  });
});
