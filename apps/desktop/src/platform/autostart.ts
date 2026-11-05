import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * "Open Psyche at login" on Linux (design §2.4): an XDG autostart entry,
 * `~/.config/autostart/psyche.desktop`. Electron's `app.setLoginItemSettings` is macOS and Windows
 * only. Only the desktop window is autostarted: the Gateway starts with the user manager
 * (`WantedBy=default.target`), so it needs no entry.
 * https://specifications.freedesktop.org/autostart/latest/
 */

export const AUTOSTART_FILE = "psyche.desktop";

/** `$XDG_CONFIG_HOME/autostart/psyche.desktop` (default `~/.config/autostart`). */
export function autostartPath(env: NodeJS.ProcessEnv, home: string): string {
  const base =
    env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME !== ""
      ? env.XDG_CONFIG_HOME
      : join(home, ".config");
  return join(base, "autostart", AUTOSTART_FILE);
}

/** One `Exec=` argument, quoted the Desktop Entry way (reserved characters escaped, `%` doubled). */
export function desktopExecArg(arg: string): string {
  const escaped = arg.replace(/%/g, "%%");
  if (!/[\s"'\\><~|&;$*?#()`]/.test(escaped)) return escaped;
  return `"${escaped.replace(/(["`$\\])/g, "\\$1")}"`;
}

export function renderAutostartEntry(exec: readonly string[]): string {
  return `[Desktop Entry]
Type=Application
Name=Psyche
Comment=Open Psyche when you sign in
Exec=${exec.map(desktopExecArg).join(" ")}
Icon=psyche
Terminal=false
X-GNOME-Autostart-enabled=true
`;
}

/** Writes the entry when its content changed; true when it wrote. */
export function enableAutostart(file: string, exec: readonly string[]): boolean {
  const content = renderAutostartEntry(exec);
  if (existsSync(file) && readFileSync(file, "utf8") === content) return false;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, { mode: 0o644 });
  return true;
}

export function disableAutostart(file: string): void {
  rmSync(file, { force: true });
}
