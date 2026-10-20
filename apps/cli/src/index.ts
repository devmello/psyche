// Public API of @psyche/cli (apps/cli/README.md). The `psyche` binary is src/main.ts.
export { type AuditReport, auditRules, type Finding, type Severity } from "./audit.ts";
export { commandHelp, GLOBAL_OPTIONS, rootHelp, run } from "./cli.ts";
export { GatewayClient, probeGateway } from "./client.ts";
export type { CommandResult, CommandSpec } from "./command.ts";
export { COMMANDS } from "./commands/index.ts";
export { Ctx, type Deps, defaultDeps } from "./context.ts";
export { type Check, doctorChecks } from "./doctor.ts";
export { CliError, EXIT } from "./errors.ts";
export { loadOrCreateIdentity } from "./identity.ts";
export type { Snapshot } from "./snapshot.ts";
export {
  LAUNCH_AGENT_LABEL,
  renderLaunchAgentPlist,
  renderSystemdUnit,
  SYSTEMD_UNIT,
} from "./supervisor.ts";
export { CLI_VERSION } from "./version.ts";
