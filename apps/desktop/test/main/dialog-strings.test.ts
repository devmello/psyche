import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getLocale: () => "de" } }));

import { loadMainWords, mainWords } from "../../src/main/main-i18n.ts";

/**
 * A native dialog or notification shows words the owner reads, so they come from `desktop.dialog.*`
 * in every language. The guard reads the argument list of each call that shows one
 * (`showMessageBox`, `showOpenDialog`, `new Notification`) in main.ts and fails on a quoted English
 * string left in it. The argument list is matched by its own parentheses, so an IPC error string
 * next to a dialog is not mistaken for one.
 */
const DIALOG_CALL =
  /dialog\.showMessageBox(?:Sync)?\(|dialog\.showOpenDialog\(|new Notification\(/g;
/** Quoted text that starts with a capital letter: an English word or sentence, not a key or a code. */
const ENGLISH_LITERAL = /"([A-Z][^"\n]*)"/g;
/** The product name is the app's title, not translated. */
const BRAND = new Set(["Psyche"]);

/** Each dialog call's argument text, with the line the call starts on. */
function dialogCalls(source: string): { line: number; args: string }[] {
  const calls: { line: number; args: string }[] = [];
  for (const m of source.matchAll(DIALOG_CALL)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    let depth = 0;
    let quote: string | undefined;
    let i = open;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (quote !== undefined) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = undefined;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "(") depth++;
      else if (ch === ")" && --depth === 0) break;
    }
    calls.push({
      line: source.slice(0, m.index ?? 0).split("\n").length,
      args: source.slice(open, i + 1),
    });
  }
  return calls;
}

/** The English literals inside the dialog calls, as `line: "text"`. */
function englishDialogLiterals(source: string): string[] {
  const found: string[] = [];
  for (const call of dialogCalls(source)) {
    for (const m of call.args.matchAll(ENGLISH_LITERAL)) {
      const text = m[1] ?? "";
      if (!BRAND.has(text)) found.push(`${call.line}: "${text}"`);
    }
  }
  return found;
}

describe("the guard that keeps dialog strings in the catalogue", () => {
  it("flags an English literal inside a dialog call (positive control)", () => {
    const sample = [
      "await dialog.showMessageBox({",
      '  type: "warning",',
      '  message: "Uninstall Psyche?",',
      "});",
      'throw new PsycheError("forbidden", "Not a dialog");',
    ].join("\n");
    expect(englishDialogLiterals(sample)).toEqual(['1: "Uninstall Psyche?"']);
  });

  it("finds the dialog calls in main.ts and leaves none with an English literal", () => {
    const source = readFileSync(join(__dirname, "..", "..", "src", "main.ts"), "utf8");
    // The scan has to see real calls, or an empty result proves nothing.
    expect(dialogCalls(source).length).toBeGreaterThanOrEqual(8);
    expect(englishDialogLiterals(source)).toEqual([]);
  });
});

describe("dialog words follow the system language", () => {
  it("are English until a language is loaded", () => {
    expect(mainWords()("desktop.dialog.notificationsOn")).toBe("Notifications are on.");
  });

  it("read the system language once it is loaded (the tray's locale)", async () => {
    const words = await loadMainWords("de");
    expect(words("desktop.dialog.notificationsOn")).toBe("Mitteilungen sind aktiviert.");
    expect(mainWords()("desktop.dialog.cancel")).toBe("Abbrechen");
  });

  it("fill the host words from the OS", async () => {
    const words = await loadMainWords("de");
    expect(words("desktop.dialog.stopTitle", { os: "macos" })).toBe(
      "Psyche auf diesem Mac beenden?",
    );
    expect(words("desktop.dialog.stopTitle", { os: "linux" })).toBe(
      "Psyche auf diesem Computer beenden?",
    );
  });
});
