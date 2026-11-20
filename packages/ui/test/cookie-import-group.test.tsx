import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CookieImportApi,
  CookieImportGroup,
  type CookieImportScan,
  filterSites,
  type ImportedSignIn,
  selectAllExceptSensitive,
} from "../src/screens/settings/CookieImportGroup.tsx";

afterEach(cleanup);

const SCAN: CookieImportScan = {
  scanId: "0123456789abcdef0123456789abcdef",
  browser: "chrome",
  sites: [
    { domain: "chase.com", hosts: ["chase.com"], cookies: 3, sensitive: "bank" },
    { domain: "evil-google.com", hosts: ["evil-google.com"], cookies: 1, sensitive: null },
    { domain: "github.com", hosts: ["github.com"], cookies: 2, sensitive: null },
    {
      domain: "google.com",
      hosts: ["accounts.google.com", "mail.google.com"],
      cookies: 4,
      sensitive: "email",
    },
  ],
  expired: 2,
  skipped: 1,
};

function api(over: Partial<CookieImportApi> = {}): CookieImportApi & {
  imported: ReturnType<typeof vi.fn>;
} {
  let imported: ImportedSignIn[] = [];
  const base: CookieImportApi = {
    sources: async () => [
      {
        browser: "chrome",
        supported: true,
        installed: true,
        profiles: [
          { id: "Default", name: "Personal" },
          { id: "Profile 1", name: "Work" },
        ],
      },
      { browser: "brave", supported: true, installed: false, profiles: [] },
      {
        browser: "firefox",
        supported: true,
        installed: true,
        profiles: [{ id: "Profiles/a", name: "default" }],
      },
      {
        browser: "safari",
        supported: false,
        reason: "full_disk_access",
        installed: true,
        profiles: [],
      },
    ],
    scan: vi.fn(async () => SCAN),
    import: vi.fn(async (_id: string, domains: string[]) => {
      imported = domains.map((domain) => ({
        domain,
        browser: "chrome" as const,
        cookies: 2,
        importedAt: "2026-11-20T10:00:00Z",
      }));
      return { sites: domains.map((domain) => ({ domain, cookies: 2 })), failed: 0 };
    }),
    discard: vi.fn(async () => {}),
    imported: async () => imported,
    remove: vi.fn(async (domain: string) => {
      imported = imported.filter((s) => s.domain !== domain);
    }),
  };
  return { ...base, ...over } as CookieImportApi & { imported: ReturnType<typeof vi.fn> };
}

async function readChrome(a: CookieImportApi) {
  render(<CookieImportGroup api={a} />);
  const select = await screen.findByLabelText("Import sign-ins from…");
  await waitFor(() =>
    expect(within(select).getByRole("option", { name: "Google Chrome" })).toBeTruthy(),
  );
  await userEvent.selectOptions(select, "chrome");
  await userEvent.selectOptions(screen.getByLabelText("Profile"), "Profile 1");
  await userEvent.click(screen.getByRole("button", { name: "Read sign-ins" }));
  await screen.findByTestId("cookie-import-pick");
}

describe("Settings → Browser: import sign-ins", () => {
  it("lists installed browsers, says Safari isn't supported and mentions the Keychain prompt", async () => {
    render(<CookieImportGroup api={api()} />);
    const select = await screen.findByLabelText("Import sign-ins from…");
    await waitFor(() => expect(within(select).getAllByRole("option")).toHaveLength(3));
    expect(within(select).queryByRole("option", { name: "Brave" })).toBeNull();
    expect(within(select).queryByRole("option", { name: "Safari" })).toBeNull();
    expect(screen.getByTestId("cookie-import-unsupported-safari").textContent).toMatch(
      /Full Disk Access/,
    );
    await userEvent.selectOptions(select, "chrome");
    expect(screen.getByText(/macOS asks for your password/)).toBeTruthy();
    await userEvent.selectOptions(select, "firefox");
    expect(screen.queryByText(/macOS asks for your password/)).toBeNull();
  });

  it("reads the chosen profile and ticks nothing", async () => {
    const a = api();
    await readChrome(a);
    expect(a.scan).toHaveBeenCalledWith("chrome", "Profile 1");
    for (const box of screen.getAllByRole("checkbox")) {
      expect(box.getAttribute("aria-checked")).toBe("false");
    }
    expect(screen.getByRole("button", { name: "Import" })).toHaveProperty("disabled", true);
    expect(screen.getByText(/Left out: 2 expired and 1 unreadable/)).toBeTruthy();
  });

  it("warns on sensitive sites and leaves them out of Select all", async () => {
    const a = api();
    await readChrome(a);
    expect(screen.getByTestId("cookie-import-sensitive-chase.com").textContent).toMatch(/^Bank/);
    expect(screen.getByTestId("cookie-import-sensitive-google.com").textContent).toMatch(/^Email/);
    expect(screen.queryByTestId("cookie-import-sensitive-evil-google.com")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Select all except sensitive" }));
    await userEvent.click(screen.getByRole("button", { name: "Import 2 sites" }));
    expect(a.import).toHaveBeenCalledWith(SCAN.scanId, ["evil-google.com", "github.com"]);
    expect((await screen.findByTestId("cookie-import-done")).textContent).toMatch(
      /Imported sign-ins for 2 sites/,
    );
  });

  it("searches by domain and host, and a sensitive site can still be ticked by hand", async () => {
    const a = api();
    await readChrome(a);
    await userEvent.type(screen.getByRole("searchbox", { name: "Search sites" }), "mail.goo");
    const list = screen.getByTestId("cookie-import-sites");
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    await userEvent.click(within(list).getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "Import 1 site" }));
    expect(a.import).toHaveBeenCalledWith(SCAN.scanId, ["google.com"]);
  });

  it("Cancel drops the read list in main", async () => {
    const a = api();
    await readChrome(a);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(a.discard).toHaveBeenCalledWith(SCAN.scanId);
    expect(screen.queryByTestId("cookie-import-pick")).toBeNull();
  });

  it("lists imported sites with Remove imported sign-ins", async () => {
    const a = api();
    await readChrome(a);
    await userEvent.click(screen.getByRole("checkbox", { name: /^github\.com/ }));
    await userEvent.click(screen.getByRole("button", { name: "Import 1 site" }));
    const list = await screen.findByTestId("cookie-import-imported");
    expect(within(list).getByText(/From Google Chrome on 2026-11-20, 2 cookies/)).toBeTruthy();
    await userEvent.click(within(list).getByRole("button", { name: "Remove imported sign-ins" }));
    expect(a.remove).toHaveBeenCalledWith("github.com");
    await waitFor(() => expect(screen.queryByTestId("cookie-import-imported")).toBeNull());
  });

  it("shows a read failure without leaving the picker", async () => {
    const a = api({
      scan: vi.fn(async () => {
        throw new Error("the Keychain did not give Psyche the browser's key");
      }),
    });
    render(<CookieImportGroup api={a} />);
    const select = await screen.findByLabelText("Import sign-ins from…");
    await waitFor(() => expect(within(select).getAllByRole("option")).toHaveLength(3));
    await userEvent.selectOptions(select, "chrome");
    await userEvent.click(screen.getByRole("button", { name: "Read sign-ins" }));
    expect(await screen.findByText(/couldn't read Google Chrome's sign-ins/)).toBeTruthy();
    expect(screen.queryByTestId("cookie-import-pick")).toBeNull();
  });
});

describe("pick helpers", () => {
  it("Select all leaves every sensitive site out", () => {
    expect([...selectAllExceptSensitive(SCAN.sites)].sort()).toEqual([
      "evil-google.com",
      "github.com",
    ]);
  });

  it("search matches domains and hosts", () => {
    expect(filterSites(SCAN.sites, "GOOGLE").map((s) => s.domain)).toEqual([
      "evil-google.com",
      "google.com",
    ]);
    expect(filterSites(SCAN.sites, "accounts.").map((s) => s.domain)).toEqual(["google.com"]);
    expect(filterSites(SCAN.sites, "  ")).toHaveLength(4);
  });
});
