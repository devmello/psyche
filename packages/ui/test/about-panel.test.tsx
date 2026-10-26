import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AboutPanel } from "../src/screens/settings/AboutSection.tsx";
import type { AboutInfo } from "../src/screens/settings/types.ts";

const web: AboutInfo = {
  appVersion: "0.3.0-alpha.0",
  gatewayVersion: "0.3.0-alpha.0",
  protocolVersion: 1,
  platform: "MacIntel",
  home: "",
};
const info: AboutInfo = {
  ...web,
  platform: "macOS 27.0.1 · Apple silicon",
  home: "/Users/owner/.psyche",
  runtime: "Electron 39.2.0 · Chrome 142.0.7444.59",
};

describe("About (#610)", () => {
  it("shows the runtime and the data folder with Reveal in Finder", async () => {
    const onRevealHome = vi.fn();
    render(<AboutPanel info={info} onRevealHome={onRevealHome} />);
    expect(screen.getByText("macOS 27.0.1 · Apple silicon")).toBeTruthy();
    expect(screen.getByText("Electron 39.2.0 · Chrome 142.0.7444.59")).toBeTruthy();
    expect(screen.getByText("/Users/owner/.psyche")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Reveal in Finder" }));
    expect(onRevealHome).toHaveBeenCalledOnce();
  });

  it("leaves out a data folder the host doesn't know (the web)", () => {
    render(<AboutPanel info={web} />);
    expect(screen.queryByText("Data folder")).toBeNull();
    expect(screen.queryByText("Runtime")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reveal in Finder" })).toBeNull();
  });
});
