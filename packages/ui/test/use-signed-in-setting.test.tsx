import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserPanel,
  USE_SIGNED_IN_KEY,
  useSignedInOf,
} from "../src/screens/settings/BrowserSection.tsx";

afterEach(cleanup);

describe("Let Psyche use my signed-in sessions", () => {
  it("defaults on and is off only when set to false", () => {
    expect(useSignedInOf({})).toBe(true);
    expect(useSignedInOf({ [USE_SIGNED_IN_KEY]: false })).toBe(false);
  });

  it("shows the switch on and writes false when turned off", async () => {
    const onChange = vi.fn();
    render(<BrowserPanel values={{}} onChange={onChange} persona="Wren" />);
    const sw = screen.getByRole("switch", { name: /Let Psyche use my signed-in sessions/ });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    await userEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(USE_SIGNED_IN_KEY, false);
  });
});
