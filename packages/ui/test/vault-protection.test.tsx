import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  VaultProtectionPanel,
  vaultSlotLabel,
} from "../src/screens/settings/CredentialsSection.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

describe("Settings → Credentials: vault protection", () => {
  it("names a key-file vault and offers Move to Keychain only as unavailable", () => {
    render(
      <StoryWorld>
        <VaultProtectionPanel slots={["key_file", "recovery"]} />
      </StoryWorld>,
    );
    expect(screen.getByTestId("vault-protection").textContent).toContain(
      "Vault protected by: a key file on this Mac",
    );
    expect(
      (screen.getByRole("button", { name: "Move to Keychain" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("labels the Keychain slot", () => {
    expect(vaultSlotLabel(["keychain", "recovery"])).toBe("the Keychain (Touch ID)");
  });
});
