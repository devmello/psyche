import type { Runner } from "../main/supervisor-base.ts";

/**
 * Whether a tray can be shown (design §10.3). Electron's `Tray` uses StatusNotifierItem. KDE and
 * Ubuntu (with the AppIndicator extension) have a watcher on the session bus; stock GNOME (Fedora)
 * does not. Without one, closing the last window quits the desktop process (the Gateway keeps
 * running) instead of leaving an invisible process in memory.
 */
export const STATUS_NOTIFIER_WATCHERS = [
  "org.kde.StatusNotifierWatcher",
  "org.freedesktop.StatusNotifierWatcher",
] as const;

async function nameHasOwner(run: Runner, name: string): Promise<boolean | undefined> {
  // busctl ships with systemd; gdbus with GLib. Either answers on the session bus.
  const busctl = await run("busctl", [
    "--user",
    "call",
    "org.freedesktop.DBus",
    "/org/freedesktop/DBus",
    "org.freedesktop.DBus",
    "NameHasOwner",
    "s",
    name,
  ]);
  if (busctl.code === 0) return /\btrue\b/.test(busctl.stdout);
  const gdbus = await run("gdbus", [
    "call",
    "--session",
    "--dest",
    "org.freedesktop.DBus",
    "--object-path",
    "/org/freedesktop/DBus",
    "--method",
    "org.freedesktop.DBus.NameHasOwner",
    name,
  ]);
  if (gdbus.code === 0) return /\btrue\b/.test(gdbus.stdout);
  return undefined;
}

/** True when a StatusNotifierWatcher owns its name on the session bus. False when none does or the bus cannot be asked. */
export async function statusNotifierAvailable(run: Runner): Promise<boolean> {
  for (const name of STATUS_NOTIFIER_WATCHERS) {
    if ((await nameHasOwner(run, name)) === true) return true;
  }
  return false;
}
