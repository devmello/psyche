export { sha256, strictCanonicalJSON } from "./canonical.ts";
export { diffTools, type ToolChange, toolsListHash } from "./hash.ts";
export {
  APP_MIME,
  type InputRequester,
  type McpAppResource,
  type McpCallContent,
  type McpHostEvent,
  type McpHostOptions,
  type McpInputRequest,
  type McpInputResponse,
  type McpServerDetails,
  PsycheMcpHost,
  type PsycheMcpServerConfig,
} from "./host.ts";
export { inspectTool, MAX_DESCRIPTION_CHARS, type ToolWarning } from "./inspect.ts";
export {
  defaultDenyRead,
  directLauncher,
  type McpSandboxPolicy,
  type PreparedLaunch,
  type SrtLauncherOptions,
  type StdioLauncher,
  type StdioLaunchSpec,
  srtLauncher,
  srtSettings,
} from "./launcher.ts";
export { type LoopbackReceiver, startLoopbackReceiver } from "./loopback.ts";
export {
  isValidServerId,
  MAX_TOOL_NAME_LENGTH,
  mcpToolName,
  parseMcpToolName,
  SERVER_ID_PATTERN,
  sanitizeToolName,
} from "./naming.ts";
export {
  blockRegistration,
  clientMetadataDocument,
  type McpOAuthOptions,
  type McpTokenStore,
  MemoryTokenStore,
  PsycheOAuthProvider,
} from "./oauth.ts";
export { provenanceFor, requiresUserInteraction, sideEffectFor } from "./policy.ts";
export { describeMcpCall, type McpRegistration, registerMcpServerTools } from "./registry.ts";
export {
  assertNoPlaceholders,
  mcpCredentialTarget,
  resolveEnv,
  type SecretInjection,
  validateEnv,
} from "./secrets.ts";

import { type McpHostOptions, PsycheMcpHost } from "./host.ts";

/** The `McpHost` implementation (architecture §4.9). */
export function createMcpHost(options: McpHostOptions = {}): PsycheMcpHost {
  return new PsycheMcpHost(options);
}
