import type { CommandSpec } from "../command.ts";
import { automationsCommands } from "./automations.ts";
import { backupCommands } from "./backup.ts";
import { completionCommands, setCompletionTable } from "./completion.ts";
import { configCommands } from "./config.ts";
import { devicesCommands } from "./devices.ts";
import { diagnosticsCommands } from "./diagnostics.ts";
import { exportCommands } from "./export.ts";
import { onboardCommands } from "./onboard.ts";
import { serviceCommands } from "./service.ts";
import { skillsCommands } from "./skills.ts";
import { vaultCommands } from "./vault.ts";
import { versionCommands } from "./version.ts";

/** Every `psyche` command, in help order. */
export const COMMANDS: readonly CommandSpec[] = [
  ...onboardCommands,
  ...serviceCommands,
  ...diagnosticsCommands,
  ...devicesCommands,
  ...skillsCommands,
  ...automationsCommands,
  ...vaultCommands,
  ...backupCommands,
  ...exportCommands,
  ...configCommands,
  ...versionCommands,
  ...completionCommands,
];

setCompletionTable(COMMANDS);
