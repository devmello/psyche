/**
 * A headless Linux Host (linux-helper-only design track B): psyched runs under the owner's
 * `systemd --user` manager (it sets `XDG_RUNTIME_DIR`) with no graphical session in its
 * environment (no `DISPLAY`, no `WAYLAND_DISPLAY`). Then no desktop window can serve the browser
 * bridge and polkit can't ask for the password, so the agent browser runs on the helper's private
 * screen and payments need a passkey (B3). A run with an empty environment (tests, a bare
 * `env -i`) is not one: nothing about it says a user session exists.
 */
export function headlessLinuxHost(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (platform !== "linux") return false;
  return set(env.XDG_RUNTIME_DIR) && !set(env.DISPLAY) && !set(env.WAYLAND_DISPLAY);
}

const set = (v: string | undefined): boolean => v !== undefined && v.trim() !== "";
