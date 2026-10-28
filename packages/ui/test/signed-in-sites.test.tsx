import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SignedInSitesGroup } from "../src/screens/settings/BrowserSection.tsx";

afterEach(cleanup);

/** Settings → Browser → Signed-in sites: what "Stay signed in" kept, with Sign out / forget. */
describe("Settings → Browser signed-in sites", () => {
  it("lists the sites with their SSO hosts and forgets one", async () => {
    let sites = [
      {
        origin: "https://canvas.ucsc.edu",
        hosts: ["canvas.ucsc.edu", "login.ucsc.edu"],
        addedAt: "2026-10-28T00:00:00Z",
      },
      { origin: "https://github.com", hosts: ["github.com"], addedAt: "2026-10-28T00:00:00Z" },
    ];
    const forget = vi.fn(async (origin: string) => {
      sites = sites.filter((s) => s.origin !== origin);
    });
    render(<SignedInSitesGroup api={{ list: async () => sites, forget }} />);
    await screen.findByText("canvas.ucsc.edu");
    expect(screen.getByText(/login\.ucsc\.edu/)).toBeTruthy();
    const buttons = screen.getAllByRole("button", { name: "Sign out / forget" });
    expect(buttons).toHaveLength(2);
    await userEvent.click(buttons[0] as HTMLElement);
    expect(forget).toHaveBeenCalledWith("https://canvas.ucsc.edu");
    await waitFor(() => expect(screen.queryByText("canvas.ucsc.edu")).toBeNull());
    expect(screen.getByText("github.com")).toBeTruthy();
  });

  it("says so when nothing is kept signed in", async () => {
    render(<SignedInSitesGroup api={{ list: async () => [], forget: async () => {} }} />);
    expect(await screen.findByTestId("signed-in-empty")).toBeTruthy();
  });

  it("shows a failed sign-out without hiding the site", async () => {
    const api = {
      list: async () => [{ origin: "https://github.com", hosts: ["github.com"], addedAt: "x" }],
      forget: async () => {
        throw new Error("profile busy");
      },
    };
    render(<SignedInSitesGroup api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: "Sign out / forget" }));
    expect(await screen.findByText(/couldn't sign out of https:\/\/github\.com/i)).toBeTruthy();
    expect(screen.getByText("github.com")).toBeTruthy();
  });
});
