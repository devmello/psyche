/**
 * The document rule for a routine write (the automation digest's "Approve all routine ones",
 * #1333). Shared by the broker, which classes a card routine only for these paths, and by the
 * file tools, which never keep an exec bit on a file of this kind, so a routine write never
 * leaves something runnable.
 */
/**
 * Documents and pictures: what a write of may be bulk-approved. An allowlist, not a list of what
 * runs code: anything not named here (scripts, configs, dotfiles, binaries, unknown types) is
 * sensitive, so a new kind of file that runs later never slips in. JSON and YAML are left out on
 * purpose: too many tools read them as configuration with commands in it (review #1333 R3-1).
 */
const ROUTINE_EXTENSIONS: ReadonlySet<string> = new Set([
  "md",
  "markdown",
  "txt",
  "rst",
  "csv",
  "tsv",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "pdf",
  "docx",
  "xlsx",
  "pptx",
  "rtf",
  "log",
]);

/**
 * The only leaf names that may start with a dot. `.gitattributes` is not one: it can point files
 * at filter, diff and merge drivers the owner's git config already defines.
 */
const INERT_DOTFILES: ReadonlySet<string> = new Set([".gitignore", ".editorconfig"]);

/**
 * Folders whose files are installed code, executables, app or tool state, or what an agent reads
 * as instructions (skills, prompts, `.github` instructions).
 */
const NEVER_SEGMENTS: ReadonlySet<string> = new Set([
  "node_modules",
  "venv",
  "site-packages",
  "dist-packages",
  "bin",
  "sbin",
  "library",
  ".local",
  ".config",
  ".github",
  "workflows",
  "hooks",
  "githooks",
  "skills",
  "prompts",
  // pip reads `-r requirements/base.txt` or `-r reqs/base.txt` as readily as `requirements.txt`.
  "requirements",
  "constraints",
  "reqs",
]);

/** macOS bundles: a folder that is an app, plugin or kernel extension. */
const BUNDLE_SEGMENT = /\.(?:app|bundle|framework|plugin|kext)$/;

/**
 * Names that run things, configure an installer, or steer an agent, although their type is a
 * document: build files, pip requirement and constraint files, agent instruction files.
 */
const NEVER_NAMES =
  /^(?:dockerfile|containerfile|makefile|gnumakefile|justfile|rakefile|procfile|vagrantfile|claude|agent|agents|gemini|conventions|skill|copilot-instructions)(?:\.|$)/;
/** pip takes any file through `-r`: `dev-requirements.txt`, `test_constraints.txt`, `*.pip`. */
const PIP_FILES = /(?:requirements|constraints).*\.txt$|\.pip$|^pip\.conf$/;

const NON_ASCII = /[^\x20-\x7e]/;

/**
 * True when a write to `path` may be bulk-approved: every segment is plain ASCII (after NFKC and
 * lower-casing, so `ſetup.py` reads as `setup.py` and is still refused), no segment is hidden
 * (`.x`) except two inert leaf names, no segment is installed code, tool state, agent
 * instructions or a bundle, and the file is a document or picture type that nothing runs.
 * Everything else is false.
 */
export function routineWritePath(path: string): boolean {
  if (typeof path !== "string" || path === "") return false;
  const folded = path.normalize("NFKC").toLowerCase();
  if (NON_ASCII.test(path) || NON_ASCII.test(folded)) return false;
  const parts = folded.split(/[\\/]+/).filter((p) => p !== "");
  const name = parts.at(-1);
  if (name === undefined) return false;
  for (const [i, seg] of parts.entries()) {
    if (seg.startsWith(".") && !(i === parts.length - 1 && INERT_DOTFILES.has(seg))) return false;
    if (NEVER_SEGMENTS.has(seg) || BUNDLE_SEGMENT.test(seg)) return false;
  }
  if (INERT_DOTFILES.has(name)) return true;
  if (NEVER_NAMES.test(name) || PIP_FILES.test(name)) return false;
  // `x.config.md`, `config.txt`: a tool's config, whatever its type.
  if (/\.config\./.test(name) || name.startsWith("config.")) return false;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return ROUTINE_EXTENSIONS.has(name.slice(dot + 1));
}
