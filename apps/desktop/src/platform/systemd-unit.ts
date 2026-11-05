/**
 * The systemd unit renderer lives in the CLI (`apps/cli/src/systemd-unit.ts`) because psyched's
 * bundle and the server image drop `apps/desktop`, and the CLI inside them renders the same unit.
 * The desktop re-exports it so both write byte-identical units.
 */
export * from "../../../cli/src/systemd-unit.ts";
