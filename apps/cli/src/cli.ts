import { parseArgs } from "node:util";
import type { CommandSpec, OptionSpec, OptionValues } from "./command.ts";
import { COMMANDS } from "./commands/index.ts";
import { Ctx, type Deps, defaultDeps, type GlobalOptions } from "./context.ts";
import { CliError, EXIT, exitCodeOf, toReport } from "./errors.ts";

export const GLOBAL_OPTIONS: Record<string, OptionSpec> = {
  json: { type: "boolean", description: "Machine-readable JSON output" },
  url: {
    type: "string",
    description: "Gateway URL (default http://127.0.0.1:7979, env PSYCHE_URL)",
  },
  home: {
    type: "string",
    description: "Psyche data directory (default ~/.psyche, env PSYCHE_HOME)",
  },
  insecure: { type: "boolean", description: "Allow plain http to a non-loopback Gateway" },
  timeout: { type: "string", description: "Gateway timeout in seconds (default 15)" },
  help: { type: "boolean", short: "h", description: "Show help" },
};

interface Resolved {
  command: CommandSpec | undefined;
  /** Path words consumed (a group like `pairing` when no subcommand matched). */
  path: string[];
  rest: string[];
}

function resolve(argv: readonly string[], commands: readonly CommandSpec[]): Resolved {
  const path: string[] = [];
  const rest: string[] = [];
  let i = 0;
  let matching = true;
  for (; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--") {
      rest.push(...argv.slice(i));
      break;
    }
    if (a.startsWith("-")) {
      rest.push(a);
      const name = a.replace(/^--?/, "").split("=")[0] ?? "";
      const spec =
        GLOBAL_OPTIONS[name] ?? Object.values(GLOBAL_OPTIONS).find((o) => o.short === name);
      if (spec?.type === "string" && !a.includes("=") && i + 1 < argv.length) {
        rest.push(argv[++i] as string);
      }
      continue;
    }
    const candidate = [...path, a];
    if (matching && commands.some((c) => startsWith(c.path, candidate))) {
      path.push(a);
    } else {
      matching = false;
      rest.push(a);
    }
  }
  const command = commands.find((c) => c.path.length === path.length && startsWith(c.path, path));
  return { command, path, rest };
}

function startsWith(full: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= full.length && prefix.every((p, i) => full[i] === p);
}

function toParseOptions(specs: Record<string, OptionSpec>) {
  const out: Record<string, { type: "string" | "boolean"; short?: string; multiple?: boolean }> =
    {};
  for (const [name, s] of Object.entries(specs)) {
    out[name] = {
      type: s.type,
      ...(s.short ? { short: s.short } : {}),
      ...(s.multiple ? { multiple: true } : {}),
    };
  }
  return out;
}

export function commandHelp(c: CommandSpec): string {
  const args = (c.args ?? [])
    .map((a) =>
      a.required
        ? `<${a.name}${a.variadic ? "..." : ""}>`
        : `[${a.name}${a.variadic ? "..." : ""}]`,
    )
    .join(" ");
  const lines = [
    `Usage: psyche ${c.path.join(" ")}${args ? ` ${args}` : ""} [options]`,
    "",
    c.summary,
  ];
  if (c.description) lines.push("", c.description);
  if (c.args?.length) {
    lines.push("", "Arguments:");
    for (const a of c.args) lines.push(`  ${a.name.padEnd(20)} ${a.description}`);
  }
  const opts = { ...(c.options ?? {}), ...GLOBAL_OPTIONS };
  lines.push("", "Options:");
  for (const [name, o] of Object.entries(opts)) {
    const flag = `${o.short ? `-${o.short}, ` : ""}--${name}${o.type === "string" ? " <value>" : ""}`;
    lines.push(`  ${flag.padEnd(24)} ${o.description}`);
  }
  return lines.join("\n");
}

export function rootHelp(commands: readonly CommandSpec[], prefix: readonly string[] = []): string {
  const shown = commands.filter((c) => startsWith(c.path, prefix));
  const width = Math.max(...shown.map((c) => c.path.join(" ").length));
  return [
    `Usage: psyche ${prefix.length ? `${prefix.join(" ")} ` : ""}<command> [options]`,
    "",
    "psyche is a client of the Psyche Gateway's WebSocket API.",
    "",
    "Commands:",
    ...shown.map((c) => `  ${c.path.join(" ").padEnd(width)}  ${c.summary}`),
    "",
    "Global options: --json, --url <url>, --home <dir>, --insecure, --timeout <s>, -h/--help",
    "Exit codes: 0 ok, 1 failure or problems found, 2 usage, 3 not paired, 4 Gateway unreachable",
  ].join("\n");
}

/** Runs one CLI invocation and returns the exit code. Never calls `process.exit`. */
export async function run(
  argv: readonly string[],
  deps: Deps = defaultDeps(),
  commands: readonly CommandSpec[] = COMMANDS,
): Promise<number> {
  const { command, path, rest } = resolve(argv, commands);
  const wantsJson = rest.includes("--json");
  const fail = (err: unknown): number => {
    const report = toReport(err);
    if (wantsJson) deps.io.out(JSON.stringify({ ok: false, error: report }, null, 2));
    else deps.io.err(`psyche: ${report.message}`);
    return exitCodeOf(err);
  };

  if (!command) {
    if (
      path.length === 0 &&
      (rest.length === 0 || rest.includes("--help") || rest.includes("-h"))
    ) {
      deps.io.out(rootHelp(commands));
      return rest.length === 0 ? EXIT.usage : EXIT.ok;
    }
    if (path.length > 0 && rest.every((r) => r.startsWith("-"))) {
      deps.io.out(rootHelp(commands, path));
      return rest.includes("--help") || rest.includes("-h") ? EXIT.ok : EXIT.usage;
    }
    const unknown = [...path, ...rest.filter((r) => !r.startsWith("-"))].join(" ");
    return fail(new CliError("usage", `Unknown command: ${unknown}. Run \`psyche --help\`.`));
  }

  let values: OptionValues;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: rest,
      options: toParseOptions({ ...GLOBAL_OPTIONS, ...(command.options ?? {}) }),
      allowPositionals: true,
      strict: true,
    });
    values = parsed.values as OptionValues;
    positionals = parsed.positionals;
  } catch (err) {
    return fail(new CliError("usage", err instanceof Error ? err.message : String(err)));
  }
  if (values.help === true) {
    deps.io.out(commandHelp(command));
    return EXIT.ok;
  }
  const required = (command.args ?? []).filter((a) => a.required).length;
  const variadic = (command.args ?? []).some((a) => a.variadic);
  if (
    positionals.length < required ||
    (!variadic && positionals.length > (command.args ?? []).length)
  ) {
    return fail(new CliError("usage", `Wrong number of arguments.\n\n${commandHelp(command)}`));
  }
  const timeoutSec = typeof values.timeout === "string" ? Number(values.timeout) : 15;
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
    return fail(new CliError("usage", "--timeout must be a positive number of seconds"));
  }
  const globals: GlobalOptions = {
    json: values.json === true,
    insecure: values.insecure === true,
    timeoutMs: Math.round(timeoutSec * 1000),
    ...(typeof values.url === "string" ? { url: values.url } : {}),
    ...(typeof values.home === "string" ? { home: values.home } : {}),
  };

  let ctx: Ctx | undefined;
  try {
    ctx = new Ctx(deps, globals);
    const result = await command.run(ctx, { args: positionals, opts: values });
    if (globals.json) deps.io.out(JSON.stringify(result.data, null, 2));
    else if (result.human !== undefined) {
      if (result.human) deps.io.out(result.human);
    } else deps.io.out(JSON.stringify(result.data, null, 2));
    return result.exitCode ?? EXIT.ok;
  } catch (err) {
    return fail(err);
  } finally {
    ctx?.close();
  }
}
