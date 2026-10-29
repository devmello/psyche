// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProfileChip } from "../../src/shell/components/BrowserPane.tsx";

afterEach(cleanup);

describe("browser pane profile chip", () => {
  it("says the tab is signed in as the owner when it runs in the profile", () => {
    render(<ProfileChip profile="logged-in" />);
    expect(screen.getByTestId("browser-profile").textContent).toBe("Signed in as you");
  });
  it("says the tab is logged out in a clean partition", () => {
    render(<ProfileChip profile="clean" />);
    expect(screen.getByTestId("browser-profile").textContent).toBe("Logged out");
  });
});
