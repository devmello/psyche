import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  checkSearxngUrl,
  WebSearchSettingsGroup,
} from "../src/screens/settings/WebSearchSettings.tsx";

describe("Settings → Model & providers → Web search (#557)", () => {
  it("shows the provider in effect and where the Brave key comes from", () => {
    render(
      <WebSearchSettingsGroup
        values={{
          "search.web.provider": "searxng",
          "search.web.status": {
            preference: "searxng",
            active: "duckduckgo",
            brave: null,
            searxngUrl: null,
            note: "No SearXNG URL is set.",
          },
        }}
        onChange={() => {}}
      />,
    );
    expect(screen.getByText("Web search")).toBeTruthy();
    expect(screen.getByText("DuckDuckGo (no key, rate-limited)")).toBeTruthy();
    expect(screen.getByText("Not set (PSYCHE_SEARCH_BRAVE_KEY)")).toBeTruthy();
    expect(screen.getByText("No SearXNG URL is set.")).toBeTruthy();
    expect((screen.getByLabelText("Web search provider") as HTMLSelectElement).value).toBe(
      "searxng",
    );
  });

  it("saves the provider choice and a valid SearXNG URL, and refuses a bad one", async () => {
    const onChange = vi.fn();
    render(<WebSearchSettingsGroup values={{}} onChange={onChange} />);
    expect(screen.getByText("Not reported yet")).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText("Web search provider"), "off");
    expect(onChange).toHaveBeenCalledWith("search.web.provider", "off");
    const url = screen.getByLabelText("SearXNG URL");
    await userEvent.type(url, "ftp://nope{Enter}");
    expect(screen.getByRole("alert").textContent).toContain("http(s) URL");
    await userEvent.clear(url);
    await userEvent.type(url, "http://127.0.0.1:8888{Enter}");
    expect(onChange).toHaveBeenCalledWith("search.web.searxngUrl", "http://127.0.0.1:8888/");
  });

  it("validates SearXNG URLs", () => {
    expect(checkSearxngUrl("")).toEqual({ ok: true, value: null });
    expect(checkSearxngUrl("https://search.example.org")).toEqual({
      ok: true,
      value: "https://search.example.org/",
    });
    expect(checkSearxngUrl("https://u:p@search.example.org").ok).toBe(false);
    expect(checkSearxngUrl("javascript:alert(1)").ok).toBe(false);
  });
});
