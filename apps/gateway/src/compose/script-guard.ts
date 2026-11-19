import { type AppTier, appCap } from "@psyche/permissions";
import { PsycheError } from "@psyche/protocol";

/**
 * The Gateway's copy of the helper's always-refused rules for `apps.applescript` / `apps.jxa`
 * and `apps.open` (apps/mac-helper `ScriptGuard`, `apps.open`; #354). They run in the tool's
 * `describe`, before the broker, so an action that could never run gets no approval card (no
 * approval spam, docs/05 §7; fixed caps are "not overridable", §12). The helper still checks
 * everything itself; these refusals use its reasons.
 *
 * The Gateway cannot resolve an app *name* to a bundle id, so a name it does not know is left to
 * the helper; literal bundle ids and the well-known never-target names are refused here.
 */

const APPLESCRIPT_BANNED = [
  "doshellscript",
  "doscript",
  "runscript",
  "loadscript",
  "storescript",
  "useframework",
  "usescriptingadditions",
  "currentapplication",
  "nstask",
  "nsapplescript",
  "nsworkspace",
  "nsfilemanager",
  "nsurl",
  "«event",
  "«class",
  "«data",
  "delay",
  "displaydialog",
  "displayalert",
  "choosefromlist",
  "choosefile",
  "choosefolder",
  "chooseapplication",
  "keystroke",
  "keycode",
  "pathtome",
  "systemattribute",
  "openlocation",
  "clipboard",
  "mountvolume",
  "dojavascript",
  "openforaccess",
  "closeaccess",
  "seteof",
  "geteof",
  "readfile",
  "readalias",
  "readposixfile",
  "read(",
  "tofile",
  "toalias",
  "toposixfile",
];

const JXA_BANNED = [
  "doshellscript",
  "doscript",
  "runscript",
  "objc",
  "$",
  "eval(",
  "library(",
  "function(",
  "function*",
  "=>",
  "['",
  '["',
  "`",
  "\\u",
  "\\x",
  "fromcharcode",
  "](",
  ".call(",
  ".apply(",
  ".bind(",
  "constructor",
  "prototype",
  "__proto__",
  "require(",
  "import(",
  "currentapplication",
  "includestandardadditions",
  "delay(",
  "displaydialog",
  "displayalert",
  "choosefromlist",
  "choosefile",
  "choosefolder",
  "keystroke",
  "keycode",
  "systemattribute",
  "openlocation",
  "clipboard",
];

/** Apps a script may never drive: they run commands or files, inject input, or edit scripts. */
const NEVER_TARGETS = [
  "com.apple.finder",
  "com.apple.systemevents",
  "com.apple.ScriptEditor2",
  "com.apple.Automator",
  "com.apple.shortcuts",
  "com.apple.shortcuts.events",
  "com.apple.Terminal",
  "com.googlecode.iterm2",
  "com.apple.osascript",
].map((s) => s.toLowerCase());

/** Names the Gateway can map without the helper (the never-targets a script names most). */
const KNOWN_NAMES: Record<string, string> = {
  terminal: "com.apple.terminal",
  iterm: "com.googlecode.iterm2",
  iterm2: "com.googlecode.iterm2",
  finder: "com.apple.finder",
  "system events": "com.apple.systemevents",
  "script editor": "com.apple.scripteditor2",
  automator: "com.apple.automator",
  shortcuts: "com.apple.shortcuts",
  "shortcuts events": "com.apple.shortcuts.events",
};

/** Opening one of these as a document runs it (the helper's `executableExtensions`). */
const EXECUTABLE_EXTENSIONS = new Set([
  "app",
  "command",
  "tool",
  "sh",
  "zsh",
  "bash",
  "scpt",
  "scptd",
  "applescript",
  "workflow",
  "terminal",
  "shortcut",
  "pkg",
  "mpkg",
  "dmg",
  "jar",
  "py",
  "rb",
  "pl",
  // Terminal sessions, internet and file locations (they open a URL or another file), more
  // script and shell types, and installable bundles and profiles.
  "term",
  "webloc",
  "inetloc",
  "fileloc",
  "pyw",
  "pyc",
  "php",
  "csh",
  "tcsh",
  "ksh",
  "fish",
  "prefpane",
  "saver",
  "mobileconfig",
  "action",
]);

function deny(reason: string, message: string, details: Record<string, string> = {}): never {
  throw new PsycheError("policy_denied", message, { details: { reason, ...details } });
}

/** Lowercased, without whitespace, AppleScript line continuations or invisible characters. */
export function normalizedScript(source: string): string {
  return source.toLowerCase().replace(/[\s¬\p{Cf}\p{Cc}]/gu, "");
}

const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9_-]+)+$/;

function resolveKnown(nameOrId: string): string | undefined {
  if (BUNDLE_ID.test(nameOrId)) return nameOrId.toLowerCase();
  return KNOWN_NAMES[
    nameOrId
      .trim()
      .toLowerCase()
      .replace(/\.app$/, "")
  ];
}

/** A non-literal application reference (the helper's `dynamicMarker`). */
const DYNAMIC = Symbol("dynamic");

/** Apps a script addresses, as in the helper's `ScriptGuard.addressedApps`. */
export function addressedApps(
  source: string,
  language: "applescript" | "jxa",
): (string | typeof DYNAMIC)[] {
  const out: (string | typeof DYNAMIC)[] = [];
  if (language === "applescript") {
    for (const re of [
      /\b(?:application|app)\s+id\s+"([^"]+)"/gi,
      /\b(?:application|app)\s+"([^"]+)"/gi,
    ]) {
      for (const m of source.matchAll(re)) if (m[1] !== undefined) out.push(m[1]);
    }
    if (/\b(?:application|app)\b(?!\s+(?:id\s+)?")/i.test(source)) out.push(DYNAMIC);
  } else {
    for (const m of source.matchAll(
      /(?<![A-Za-z0-9_$])Application\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    )) {
      if (m[1] !== undefined) out.push(m[1]);
    }
    if (/(?<![A-Za-z0-9_$])Application(?!\s*\(\s*['"][^'"]+['"]\s*\))/.test(source)) {
      out.push(DYNAMIC);
    }
  }
  return out;
}

/** Throws `policy_denied` (helper reasons) when the helper would always refuse this script. */
export function assertScriptAllowed(
  target: string,
  source: string,
  language: "applescript" | "jxa",
  /**
   * The cap the Mac helper reported for an app id (`apps.resolve`'s `fixedCap`: the id lists
   * lowered by the app's Info.plist), when known: a shell-like app no list names is capped too.
   */
  helperCap?: (bundleId: string) => AppTier | undefined,
): void {
  const n = normalizedScript(source);
  const banned = (language === "applescript" ? APPLESCRIPT_BANNED : JXA_BANNED).find((t) =>
    n.includes(t),
  );
  if (banned !== undefined) {
    deny("shell_escape", `Scripts may not use ${banned}; shell commands run in the sandbox`);
  }
  if (target.toLowerCase().includes("system events")) {
    deny("system_events", "Scripts may not drive System Events; use computer.* so tiers apply");
  }
  const targetId = resolveKnown(target) ?? target.toLowerCase();
  const cap = appCap(targetId);
  if (NEVER_TARGETS.includes(targetId) || cap.cap !== "interact") {
    deny("script_target_capped", cap.reason || `Scripts may not control ${target}`, { target });
  }
  const reported = helperCap?.(targetId);
  if (reported !== undefined && reported !== "interact") {
    deny(
      "script_target_capped",
      `${target} is a terminal, shell or developer tool (from its Info.plist): scripts may not control it`,
      { target },
    );
  }
  for (const addressed of addressedApps(source, language)) {
    if (addressed === DYNAMIC) {
      deny("script_dynamic_target", "Scripts must name their app literally");
      continue;
    }
    const id = resolveKnown(addressed);
    // A name the Gateway cannot resolve is the helper's to check.
    if (id !== undefined && id !== targetId) {
      deny("script_target_mismatch", `The script addresses ${addressed}, not ${target}`, {
        addressed,
        target,
      });
    }
  }
}

/** Throws `policy_denied` when `apps.open` would run a document instead of opening it. */
export function assertOpenAllowed(app: string, url: string | undefined): void {
  const cap = appCap(app);
  if (cap.cap === "off") deny("tier_off", cap.reason || `${app} is off`);
  if (url === undefined || !/^file:/i.test(url)) return;
  // The URL parser folds `X.app/.`, `X.app/%2e` and `X.app/Contents/..` into `X.app/`: judge the
  // segments as written, so a bundle never passes as a nameless document.
  const segments = rawFileSegments(url);
  const last = segments.at(-1);
  if (last === undefined || last === "") {
    deny("executable_document", "Psyche opens files, not folders or bundles, as documents");
  }
  if (
    segments.some(
      (s) => s === "." || s === ".." || s.includes("/") || s.includes("\\") || s.includes("\0"),
    )
  ) {
    deny("invalid_url", "file URLs may not contain . or .. segments");
  }
  let path: string;
  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch {
    deny("invalid_url", "not a valid file URL");
  }
  // And the name as the URL parser reads it (`\` is `/` in a file URL): never empty or `.`.
  const name = path.split(/[\\/]/).at(-1) ?? "";
  if (name === "" || name === "." || name === "..") {
    deny("executable_document", "Psyche opens files, not folders or bundles, as documents");
  }
  // Bidi controls and other invisible characters disguise a file's real extension.
  if (/\p{Cf}/u.test(name)) {
    deny("executable_document", "File names with hidden characters are not opened");
  }
  const ext = name.includes(".") ? (name.split(".").at(-1) ?? "").toLowerCase() : "";
  if (cap.cap === "click" || EXECUTABLE_EXTENSIONS.has(ext)) {
    deny("executable_document", "Psyche does not open scripts or apps as documents");
  }
}

/**
 * The path segments of a `file:` URL as written (percent-decoded, before any `.` or `..` is
 * folded away), without the query or fragment. Throws `invalid_url` for an undecodable segment.
 */
export function rawFileSegments(url: string): string[] {
  const rest = url.replace(/^file:/i, "");
  // `file:///p`, `file://localhost/p` and `file:/p` name the same path; the URL parser reads `\`
  // as `/` in a file URL, so both separate segments here.
  const afterHost = /^[\\/]{2}/.test(rest) ? rest.slice(2).replace(/^[^/\\]*/, "") : rest;
  const path = afterHost.split(/[?#]/, 1)[0] ?? "";
  return path
    .split(/[\\/]/)
    .slice(1)
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return deny("invalid_url", "not a valid file URL");
      }
    });
}
