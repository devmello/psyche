import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { PersonaSection } from "../src/screens/settings/PersonaSection.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

/** Settings → Persona saves name, tagline, emoji and creature to IDENTITY.md through the Gateway. */

afterEach(cleanup);

const IDENTITY =
  '---\nname: Wren\ncreature: moth\ntagline: "Quiet wings"\nfavorite_color: teal\n---\nWren is a moth.\n';

let gateway: MockGateway;

function show() {
  render(
    <StoryWorld
      edit={(w) => {
        w.memoryFiles["IDENTITY.md"] = IDENTITY;
      }}
      onGateway={(g) => {
        gateway = g;
      }}
      slots={{ persona: { name: "Wren", creature: "moth" } }}
    >
      <PersonaSection />
    </StoryWorld>,
  );
  return userEvent.setup();
}

describe("Settings → Persona", () => {
  it("saves a new name to IDENTITY.md and shows it at once", async () => {
    const user = show();
    const name = await screen.findByLabelText("Name");
    expect((name as HTMLInputElement).value).toBe("Wren");

    await user.clear(name);
    await user.type(name, "Ada{Enter}");

    await waitFor(() => expect(gateway.world.memoryFiles["IDENTITY.md"]).toContain('name: "Ada"'));
    // The rest of the file is untouched.
    expect(gateway.world.memoryFiles["IDENTITY.md"]).toContain(
      'creature: moth\ntagline: "Quiet wings"\nfavorite_color: teal\n---\nWren is a moth.\n',
    );
    expect(await screen.findAllByText("Ada")).not.toHaveLength(0);
  });

  it("saves the tagline and keeps Show reasoning on the page", async () => {
    const user = show();
    const tagline = await screen.findByLabelText(/Vibe or tagline/);
    await user.clear(tagline);
    await user.type(tagline, "Careful hands{Enter}");

    await waitFor(() =>
      expect(gateway.world.memoryFiles["IDENTITY.md"]).toContain('tagline: "Careful hands"'),
    );
    expect(screen.getByRole("switch", { name: /Show thinking while it works/i })).toBeTruthy();
  });
});
