import type { ConnectorBundleCard as Card } from "@psyche/protocol";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConnectorBundleCard } from "../src/screens/settings/ConnectorBundleCard.tsx";

/** The card for a shared connector shows everything the file asks for, and says what it cannot do. */

const card = (over: Partial<Card> = {}): Card => ({
  serverId: "notes-sync",
  title: "Notes sync",
  description: "Searches and appends to a notes service.",
  version: "1.2.0",
  createdAt: "2026-11-04T12:00:00.000Z",
  bytes: 1_200,
  bundleHash: `sha256:${"a".repeat(64)}`,
  signer: { status: "new", name: "Ada", keyId: `sha256:${"b".repeat(64)}`, signerChanged: false },
  command: ["node", "server.mjs", "--fast"],
  env: ["NOTES_DIR"],
  secrets: [{ name: "NOTES_TOKEN", purpose: "API access" }],
  network: ["api.notes.example"],
  declaredTools: [
    { name: "search", sideEffect: "read" },
    { name: "append", sideEffect: "write" },
  ],
  files: [{ path: "server.mjs", bytes: 18, executable: false, text: "console.log('hi');\n" }],
  findings: [],
  sandbox: "srt",
  ...over,
});

const renderCard = (c: Card) => render(<ConnectorBundleCard card={c} onCancel={() => undefined} />);

describe("shared connector card", () => {
  it("shows the signer, the command, the network, the env and secret names, the tools and the scripts", () => {
    renderCard(card({ toolCheck: { undeclared: ["delete_all"], missing: ["append"] } }));
    const region = screen.getByTestId("connector-bundle-card");
    expect(within(region).getByText("Shared connector Notes sync")).toBeTruthy();
    expect(within(region).getByTestId("connector-signer").textContent).toContain(
      "Signed by Ada. You have not seen this key before.",
    );
    for (const part of ["node", "server.mjs", "--fast"])
      expect(within(region).getByText(part)).toBeTruthy();
    expect(within(region).getByText("api.notes.example")).toBeTruthy();
    expect(within(region).getByText("NOTES_DIR")).toBeTruthy();
    expect(within(region).getByText("NOTES_TOKEN")).toBeTruthy();
    expect(within(region).getByText(/API access/)).toBeTruthy();
    expect(within(region).getByText("search")).toBeTruthy();
    expect(within(region).getByText("append")).toBeTruthy();
    expect(within(region).getByText(/console\.log/)).toBeTruthy();
    // The first run is in the sandbox, and the probe's findings are compared with the file.
    expect(within(region).getByTestId("connector-sandbox").textContent).toMatch(
      /first run is in the sandbox/,
    );
    expect(within(region).getByText(/did not declare: delete_all/)).toBeTruthy();
    expect(within(region).getByText(/did not list: append/)).toBeTruthy();
    expect(region.textContent).not.toMatch(/api[_-]?key value|secret value is/i);
  });

  it("says plainly when there is no sandbox, and that nothing was started or saved", () => {
    renderCard(card({ sandbox: "none", blocker: "no_sandbox" }));
    const sandbox = screen.getByTestId("connector-sandbox");
    expect(sandbox.textContent).toMatch(/no sandbox/);
    expect(sandbox.textContent).toMatch(/Nothing was started or saved/);
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });

  it("shows an unsigned file, a key that changed, and a rotated key in their own words", () => {
    const { unmount } = renderCard(card({ signer: { status: "unsigned", signerChanged: false } }));
    expect(screen.getByTestId("connector-signer").textContent).toMatch(/not signed/);
    unmount();
    const changed = renderCard(
      card({
        signer: {
          status: "changed",
          name: "Ada",
          keyId: `sha256:${"c".repeat(64)}`,
          signerChanged: true,
        },
      }),
    );
    // A key that changed is a warning the screen reader announces.
    expect(within(screen.getByTestId("connector-signer")).queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("connector-signer").getAttribute("role")).toBe("alert");
    expect(screen.getByTestId("connector-signer").textContent).toMatch(
      /not with the key seen before/,
    );
    changed.unmount();
    renderCard(
      card({
        signer: {
          status: "rotated",
          name: "Ada",
          keyId: `sha256:${"d".repeat(64)}`,
          previousKeyId: `sha256:${"e".repeat(64)}`,
          rotatedFrom: { keyId: `sha256:${"e".repeat(64)}`, state: "trusted" },
          signerChanged: false,
        },
      }),
    );
    expect(screen.getByTestId("connector-signer").textContent).toMatch(
      /same author, new key \(signed by the old key\)/,
    );
    expect(screen.getByTestId("connector-signer").textContent).toMatch(
      /not trusted until you trust it/,
    );
  });

  it("for an update, shows what it asks for beyond the installed version, in red, with the diff", () => {
    renderCard(
      card({
        update: {
          installedVersion: "1.1.0",
          installedBundleHash: `sha256:${"f".repeat(64)}`,
          widened: {
            command: true,
            env: [],
            secrets: ["SECOND_TOKEN"],
            network: ["cdn.example.com"],
            tools: ["delete"],
            payload: false,
          },
          diff: "--- a/command\n+++ b/command\n-node server.mjs\n+node server.mjs --fast\n",
          installedCommand: ["node", "server.mjs"],
          signerChanged: false,
        },
      }),
    );
    const widened = screen.getByTestId("connector-widened");
    expect(within(widened).getByRole("alert").textContent).toMatch(
      /more than the version you have/,
    );
    expect(within(widened).getByText("SECOND_TOKEN")).toBeTruthy();
    expect(within(widened).getByText("cdn.example.com")).toBeTruthy();
    expect(within(widened).getByText("delete")).toBeTruthy();
    expect(
      within(widened).getByText(/Now node server\.mjs --fast\. Before: node server\.mjs/),
    ).toBeTruthy();
    expect(screen.getByText(/\+node server\.mjs --fast/)).toBeTruthy();
  });

  it("shows words the author wrote as data: control characters are removed", () => {
    renderCard(
      card({
        title: "Evil" + String.fromCharCode(0x202e) + " name",
        description: "Hi" + String.fromCharCode(0) + "there",
      }),
    );
    const region = screen.getByTestId("connector-bundle-card");
    expect(region.textContent).not.toContain(String.fromCharCode(0x202e));
    expect(region.textContent).not.toContain(String.fromCharCode(0));
  });
});
