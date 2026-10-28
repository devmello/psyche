import { APP_SETTINGS_SECTIONS } from "@psyche/protocol";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppLinkBlockView, appRouteLabel } from "../src/blocks/AppLink.tsx";
import { SETTINGS_SECTIONS } from "../src/screens/settings/SettingsScreen.tsx";
import { UiSlotsProvider } from "../src/slots.tsx";

describe("app_link block", () => {
  it("offers a button labelled from the route and navigates only on click", () => {
    const navigate = vi.fn();
    render(
      <UiSlotsProvider value={{ navigate }}>
        <AppLinkBlockView block={{ type: "app_link", route: "/settings/daily" }} />
      </UiSlotsProvider>,
    );
    const button = screen.getByTestId("app-link");
    expect(button.textContent).toContain("Open Settings: Daily");
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(navigate).toHaveBeenCalledWith("/settings/daily");
  });

  it("draws nothing for a route the app does not know", () => {
    render(
      <UiSlotsProvider value={{ navigate: vi.fn() }}>
        <AppLinkBlockView block={{ type: "app_link", route: "https://evil.test" }} />
      </UiSlotsProvider>,
    );
    expect(screen.queryByTestId("app-link")).toBeNull();
  });

  it("has a label for every Settings section, and the allowlist equals the Settings list", () => {
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toEqual([...APP_SETTINGS_SECTIONS]);
    for (const id of APP_SETTINGS_SECTIONS)
      expect(appRouteLabel(`/settings/${id}`)).toContain(": ");
    expect(appRouteLabel("/library/artifacts")).toBe("Artifacts");
    expect(appRouteLabel("/can-do")).toBe("What can you do?");
    expect(appRouteLabel("/feed")).toBe("Feed");
  });
});
