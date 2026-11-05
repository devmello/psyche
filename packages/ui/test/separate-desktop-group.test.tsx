import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isLinuxUi,
  SEPARATE_DESKTOP_KEYS,
  SeparateDesktopGroup,
  separateDesktopOf,
} from "../src/screens/settings/SeparateDesktopGroup.tsx";

afterEach(() => {
  delete document.documentElement.dataset.platform;
});

describe("separateDesktopOf", () => {
  it("reads the Gateway's state and treats anything else as not running", () => {
    expect(separateDesktopOf({})).toMatchObject({ phase: "off", shares: [], internet: false });
    expect(separateDesktopOf({ [SEPARATE_DESKTOP_KEYS.state]: "junk" }).phase).toBe("off");
    expect(separateDesktopOf({ [SEPARATE_DESKTOP_KEYS.state]: { phase: "exploding" } }).phase).toBe(
      "off",
    );
    const v = separateDesktopOf({
      [SEPARATE_DESKTOP_KEYS.state]: {
        phase: "running",
        engine: "podman",
        rootless: false,
        shares: [{ name: "docs", readWrite: true }, { name: "ro", readWrite: false }, 7],
        internet: true,
      },
    });
    expect(v).toMatchObject({
      phase: "running",
      engine: "podman",
      rootless: false,
      internet: true,
    });
    expect(v.shares).toEqual(["docs (rw)", "ro"]);
  });
});

describe("isLinuxUi", () => {
  it("is true only on a Linux shell", () => {
    expect(isLinuxUi()).toBe(false);
    document.documentElement.dataset.platform = "macos";
    expect(isLinuxUi()).toBe(false);
    document.documentElement.dataset.platform = "linux";
    expect(isLinuxUi()).toBe(true);
  });
});

describe("SeparateDesktopGroup", () => {
  it("shows the state, warns about a rootful engine, and writes only the memory and reset keys", () => {
    const onChange = vi.fn();
    render(
      <SeparateDesktopGroup
        values={{
          [SEPARATE_DESKTOP_KEYS.state]: { phase: "running", engine: "docker", rootless: false },
        }}
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId("separate-desktop-state").textContent).toMatch(/docker/);
    expect(screen.getByText(/runs as root/)).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "4g" } });
    expect(onChange).toHaveBeenCalledWith(SEPARATE_DESKTOP_KEYS.memory, "4g");
    fireEvent.click(screen.getByRole("button", { name: /Reset separate desktop/ }));
    expect(onChange).toHaveBeenCalledWith(SEPARATE_DESKTOP_KEYS.reset, expect.any(Number));
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
