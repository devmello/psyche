import { PsycheError } from "@psyche/protocol";

/** Key definitions for `Input.dispatchKeyEvent` (subset of Puppeteer's USKeyboardLayout). */
interface KeyDef {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

const NAMED: Record<string, KeyDef> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};

const MODIFIERS: Record<string, number> = {
  alt: 1,
  option: 1,
  control: 2,
  ctrl: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  shift: 8,
};

/** Editing commands Chromium runs for common shortcuts regardless of platform. */
const COMMANDS: Record<string, string> = {
  "4+a": "selectAll",
  "2+a": "selectAll",
  "4+c": "copy",
  "2+c": "copy",
  "4+x": "cut",
  "2+x": "cut",
  "4+v": "paste",
  "2+v": "paste",
  "4+z": "undo",
  "2+z": "undo",
};

export interface KeyEventParams {
  type: "keyDown" | "rawKeyDown" | "keyUp";
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  modifiers: number;
  text?: string;
  commands?: string[];
}

/** Parse `Shift+Tab`, `Meta+A`, `Enter`, `a` into the down/up events to dispatch. */
export function keyEvents(chord: string): KeyEventParams[] {
  const parts = chord.split("+").map((p) => p.trim());
  if (parts.length === 0 || parts.some((p) => p === "") || parts.length > 4) {
    throw new PsycheError("invalid_params", `invalid key chord ${JSON.stringify(chord)}`);
  }
  const keyName = parts.at(-1) ?? "";
  let modifiers = 0;
  for (const m of parts.slice(0, -1)) {
    const bit = MODIFIERS[m.toLowerCase()];
    if (bit === undefined) {
      throw new PsycheError("invalid_params", `unknown modifier ${JSON.stringify(m)}`);
    }
    modifiers |= bit;
  }
  let def = NAMED[keyName.toLowerCase()];
  if (def === undefined) {
    if ([...keyName].length !== 1) {
      throw new PsycheError("invalid_params", `unknown key ${JSON.stringify(keyName)}`);
    }
    const ch = keyName;
    const upper = ch.toUpperCase();
    const isLetter = /^[a-z]$/i.test(ch);
    const isDigit = /^\d$/.test(ch);
    def = {
      key: (modifiers & 8) !== 0 && isLetter ? upper : ch,
      code: isLetter ? `Key${upper}` : isDigit ? `Digit${ch}` : "",
      keyCode: isLetter || isDigit ? upper.charCodeAt(0) : 0,
      text: (modifiers & 8) !== 0 && isLetter ? upper : ch,
    };
  }
  const textual = def.text !== undefined && (modifiers & (2 | 4)) === 0;
  const down: KeyEventParams = {
    type: textual ? "keyDown" : "rawKeyDown",
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    modifiers,
  };
  if (textual && def.text !== undefined) down.text = def.text;
  const cmd = COMMANDS[`${modifiers & (2 | 4)}+${def.key.toLowerCase()}`];
  if (cmd !== undefined) down.commands = [cmd];
  const up: KeyEventParams = {
    type: "keyUp",
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    modifiers,
  };
  return [down, up];
}
