import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AboutPanel } from "../src/screens/settings/AboutSection.tsx";
import { SettingsApprovalContext } from "../src/screens/settings/shared.tsx";
import type { AboutInfo, UninstallPort } from "../src/screens/settings/types.ts";

const info: AboutInfo = {
  appVersion: "0.3.0",
  gatewayVersion: "0.3.0",
  protocolVersion: 1,
  platform: "macOS",
  home: "/Users/owner/.psyche",
};

function port(over: Partial<UninstallPort> = {}): UninstallPort {
  return {
    plan: vi.fn(async (deleteData: boolean) => ({
      stops: [],
      trash: [
        { kind: "support", path: "/Users/owner/Library/Application Support/Psyche", label: "x" },
        ...(deleteData ? [{ kind: "data", path: "/Users/owner/.psyche", label: "d" }] : []),
        { kind: "app", path: "/Applications/Psyche.app", label: "Psyche.app" },
      ],
      confirmWord: "DELETE",
    })),
    uninstall: vi.fn(async () => undefined),
    ...over,
  };
}

describe("Uninstall Psyche (About)", () => {
  it("has no uninstall row without a port (web, remote window)", () => {
    render(<AboutPanel info={info} />);
    expect(screen.queryByRole("button", { name: "Uninstall Psyche…" })).toBeNull();
  });

  it("keeps data by default and lists exactly what goes to the Trash", async () => {
    const p = port();
    render(<AboutPanel info={info} uninstall={p} />);
    await userEvent.click(screen.getByRole("button", { name: "Uninstall Psyche…" }));
    expect(await screen.findByText("/Applications/Psyche.app")).toBeTruthy();
    expect(
      within(screen.getByTestId("uninstall-plan")).queryByText("/Users/owner/.psyche"),
    ).toBeNull();
    expect(screen.getByText("Your data folder is not touched.")).toBeTruthy();
    await userEvent.click(screen.getByTestId("uninstall-go"));
    expect(p.uninstall).toHaveBeenCalledExactlyOnceWith({ deleteData: false });
  });

  it("Delete my data lists the data folder and needs the typed word", async () => {
    const p = port();
    render(<AboutPanel info={info} uninstall={p} />);
    await userEvent.click(screen.getByRole("button", { name: "Uninstall Psyche…" }));
    await userEvent.click(await screen.findByLabelText(/Delete my data/));
    expect(
      await within(screen.getByTestId("uninstall-plan")).findByText("/Users/owner/.psyche"),
    ).toBeTruthy();
    const go = screen.getByTestId("uninstall-go") as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("Type DELETE to confirm"), "DELETE");
    expect(go.disabled).toBe(false);
  });

  it("hands an approval_required answer to the settings approval banner and retries with it", async () => {
    const needs = Object.assign(new Error("needs approval"), {
      code: "approval_required",
      details: { approvalId: "apr_1" },
    });
    const uninstall = vi.fn().mockRejectedValueOnce(needs).mockResolvedValue(undefined);
    const request = vi.fn();
    render(
      <SettingsApprovalContext.Provider value={request}>
        <AboutPanel info={info} uninstall={port({ uninstall })} />
      </SettingsApprovalContext.Provider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Uninstall Psyche…" }));
    await userEvent.click(await screen.findByLabelText(/Delete my data/));
    await userEvent.type(await screen.findByLabelText("Type DELETE to confirm"), "DELETE");
    await userEvent.click(screen.getByTestId("uninstall-go"));
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    const pending = request.mock.calls[0]?.[0];
    expect(pending.approvalId).toBe("apr_1");
    await pending.retry("apr_1");
    expect(uninstall).toHaveBeenLastCalledWith({
      deleteData: true,
      confirm: "DELETE",
      approvalId: "apr_1",
    });
  });
});
