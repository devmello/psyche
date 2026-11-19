/**
 * Package runners (`npx`, `uvx`…) fetch and resolve their package each time they start. A server
 * started through one with a version range or a tag (`pkg`, `pkg@latest`, `pkg@^1`) can come back
 * as a newly published version on any restart, so the host never stops such a server for being
 * idle and never restarts it by itself: it then re-resolves only when the owner (re)adds it or the
 * Gateway restarts, as before idle stops existed. Pinned to an exact version (`pkg@1.2.3`,
 * `pkg==1.2.3`), a restart runs the same release.
 */

type Family = "node" | "python";

interface Runner {
  family: Family;
  /** Tokens after the runner's own name(s). */
  rest: string[];
}

/** Options naming the package to fetch (their value is checked), per family. */
const PACKAGE_FLAGS: Record<Family, Set<string>> = {
  node: new Set(["--package", "-p"]),
  python: new Set(["--from", "--with", "--spec"]),
};

/** Options whose value is not a package, so it is skipped rather than read as one. */
const VALUE_FLAGS: Record<Family, Set<string>> = {
  node: new Set(["--registry", "--cache", "--userconfig", "--prefix", "--workspace", "-w"]),
  python: new Set([
    "-p",
    "--python",
    "--python-preference",
    "-i",
    "--index",
    "--index-url",
    "--default-index",
    "--extra-index-url",
    "--find-links",
    "-f",
    "--index-strategy",
    "--keyring-provider",
    "--allow-insecure-host",
    "-c",
    "--constraints",
    "--overrides",
    "--build-constraints",
    "--env-file",
    "--directory",
    "--project",
    "--config-file",
    "--cache-dir",
    "--resolution",
    "--prerelease",
    "--exclude-newer",
    "--link-mode",
    "--color",
    "-P",
    "--upgrade-package",
    "--reinstall-package",
    "--refresh-package",
    "--pip-args",
    "--backend",
  ]),
};

/** Options that make the runner resolve something this check cannot see: never pinned. */
const OPAQUE_FLAGS = new Set([
  "-c",
  "--call",
  "--shell-mode",
  "--with-editable",
  "--with-requirements",
]);

/** `name@1.2.3` (scoped names too), with an optional prerelease or build part. No ranges, no tags. */
const NODE_PINNED =
  /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*@\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?(?:\+[0-9a-z.-]+)?$/i;
/** An exact PEP 440 version: `1.2`, `1.2.3rc1`, `2!1.0.post1.dev2`, `1.0+local`. No wildcards. */
const PY_VERSION = String.raw`(?:\d+!)?\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?(?:\+[a-z0-9.]+)?`;
const PY_PINNED = new RegExp(
  String.raw`^[a-z0-9][a-z0-9._-]*(?:\[[a-z0-9._,-]+\])?(?:===?|@)${PY_VERSION}$`,
  "i",
);

const baseName = (token: string) =>
  (token.split(/[\\/]/).pop() ?? token).toLowerCase().replace(/\.(?:cmd|exe|bat|ps1)$/, "");

/** The runner starting at `tokens[i]`, if one does. */
function runnerAt(tokens: string[], i: number): Runner | undefined {
  const name = baseName(tokens[i] ?? "");
  const next = tokens[i + 1];
  if (name === "npx" || name === "pnpx" || name === "bunx")
    return { family: "node", rest: tokens.slice(i + 1) };
  if (name === "uvx") return { family: "python", rest: tokens.slice(i + 1) };
  if ((name === "pnpm" || name === "yarn") && next === "dlx")
    return { family: "node", rest: tokens.slice(i + 2) };
  if (name === "bun" && next === "x") return { family: "node", rest: tokens.slice(i + 2) };
  if (name === "npm" && (next === "exec" || next === "x"))
    return { family: "node", rest: tokens.slice(i + 2) };
  if (name === "pipx" && next === "run") return { family: "python", rest: tokens.slice(i + 2) };
  if (name === "uv" && next === "tool" && tokens[i + 2] === "run")
    return { family: "python", rest: tokens.slice(i + 3) };
  return undefined;
}

/** Whether every package this runner invocation fetches is pinned to an exact version. */
function pinned({ family, rest }: Runner): boolean {
  const packages: string[] = [];
  let named = false;
  let positional: string | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i] as string;
    if (token === "--") {
      positional = rest[i + 1];
      break;
    }
    if (!token.startsWith("-")) {
      positional = token;
      break;
    }
    const eq = token.indexOf("=");
    const flag = eq === -1 ? token : token.slice(0, eq);
    if (OPAQUE_FLAGS.has(flag) && !VALUE_FLAGS[family].has(flag)) return false;
    const takesValue = PACKAGE_FLAGS[family].has(flag) || VALUE_FLAGS[family].has(flag);
    const value = eq === -1 ? (takesValue ? rest[++i] : undefined) : token.slice(eq + 1);
    if (PACKAGE_FLAGS[family].has(flag)) {
      if (value === undefined) return false;
      // `--with a,b` installs both.
      packages.push(...(flag === "--with" ? value.split(",") : [value]));
      // `--with` adds packages; the others name the package, and the positional is then a command.
      if (flag !== "--with") named = true;
    }
  }
  if (!named) {
    if (positional === undefined) return false;
    packages.push(positional);
  }
  const exact = family === "node" ? NODE_PINNED : PY_PINNED;
  return packages.length > 0 && packages.every((p) => exact.test(p));
}

/**
 * True when the command runs a package runner that may fetch a different release on its next
 * start. Every argument is also split on spaces, so `sh -c "npx -y pkg"` and `env X=1 uvx pkg`
 * count; a word that only looks like a runner errs towards true (the server just keeps running).
 */
export function reResolvesOnLaunch(command: readonly string[]): boolean {
  const tokens = command.flatMap((a) => a.split(/\s+/).filter((t) => t !== ""));
  for (let i = 0; i < tokens.length; i += 1) {
    const runner = runnerAt(tokens, i);
    if (runner !== undefined && !pinned(runner)) return true;
  }
  return false;
}
