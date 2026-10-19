import type { CommandSpec } from "../command.ts";
import { CliError } from "../errors.ts";

/** Shell completion scripts generated from the command table (bash, zsh, fish). */

let table: readonly CommandSpec[] = [];
export function setCompletionTable(commands: readonly CommandSpec[]): void {
  table = commands;
}

const GLOBAL = ["--json", "--url", "--home", "--insecure", "--timeout", "--help"];

function tree(commands: readonly CommandSpec[]): Map<string, Set<string>> {
  const t = new Map<string, Set<string>>();
  for (const c of commands) {
    for (let i = 0; i < c.path.length; i++) {
      const key = c.path.slice(0, i).join(" ");
      if (!t.has(key)) t.set(key, new Set());
      t.get(key)?.add(c.path[i] as string);
    }
  }
  return t;
}

function flags(c: CommandSpec): string[] {
  return [...Object.keys(c.options ?? {}).map((o) => `--${o}`), ...GLOBAL];
}

export function bashCompletion(commands: readonly CommandSpec[]): string {
  const t = tree(commands);
  const cases = [...t.entries()].map(([k, v]) => `    "${k}") words="${[...v].join(" ")}" ;;`);
  const flagCases = commands.map(
    (c) => `    "${c.path.join(" ")}") words="${flags(c).join(" ")}" ;;`,
  );
  return `# bash completion for psyche. Install: psyche completion bash > ~/.local/share/bash-completion/completions/psyche
_psyche() {
  local cur path="" words="" i
  cur="\${COMP_WORDS[COMP_CWORD]}"
  for ((i=1; i<COMP_CWORD; i++)); do
    case "\${COMP_WORDS[i]}" in -*) ;; *) path="\${path:+$path }\${COMP_WORDS[i]}" ;; esac
  done
  if [[ "$cur" == -* ]]; then
    case "$path" in
${flagCases.join("\n")}
    *) words="${GLOBAL.join(" ")}" ;;
    esac
  else
    case "$path" in
${cases.join("\n")}
    esac
  fi
  COMPREPLY=( $(compgen -W "$words" -- "$cur") )
}
complete -F _psyche psyche
`;
}

export function zshCompletion(commands: readonly CommandSpec[]): string {
  return `#compdef psyche
# zsh completion for psyche. Install: psyche completion zsh > "\${fpath[1]}/_psyche"
autoload -U +X bashcompinit && bashcompinit
${bashCompletion(commands)}`;
}

export function fishCompletion(commands: readonly CommandSpec[]): string {
  const lines = [
    "# fish completion for psyche. Install: psyche completion fish > ~/.config/fish/completions/psyche.fish",
    "complete -c psyche -f",
  ];
  const t = tree(commands);
  for (const [prefix, words] of t) {
    const cond = prefix
      ? `__fish_seen_subcommand_from ${prefix.split(" ").at(-1)}`
      : "__fish_use_subcommand";
    for (const w of words) {
      const c = commands.find((x) => x.path.join(" ") === (prefix ? `${prefix} ${w}` : w));
      lines.push(
        `complete -c psyche -n '${cond}' -a ${w}${c ? ` -d '${c.summary.replace(/'/g, "")}'` : ""}`,
      );
    }
  }
  for (const c of commands) {
    for (const [name, o] of Object.entries(c.options ?? {})) {
      lines.push(
        `complete -c psyche -n '__fish_seen_subcommand_from ${c.path.at(-1)}' -l ${name}${o.type === "string" ? " -r" : ""}${o.choices ? ` -a '${o.choices.join(" ")}'` : ""} -d '${o.description.replace(/'/g, "")}'`,
      );
    }
  }
  for (const g of GLOBAL) lines.push(`complete -c psyche -l ${g.slice(2)}`);
  return `${lines.join("\n")}\n`;
}

export const completionCommands: CommandSpec[] = [
  {
    path: ["completion"],
    summary: "Print a shell completion script (bash, zsh or fish)",
    args: [{ name: "shell", description: "bash | zsh | fish", required: true }],
    async run(_ctx, { args }) {
      const shell = args[0];
      const script =
        shell === "bash"
          ? bashCompletion(table)
          : shell === "zsh"
            ? zshCompletion(table)
            : shell === "fish"
              ? fishCompletion(table)
              : undefined;
      if (!script) throw new CliError("usage", "shell must be bash, zsh or fish");
      return { data: { shell, script }, human: script };
    },
  },
];
