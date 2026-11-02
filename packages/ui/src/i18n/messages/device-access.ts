/** Files on this Mac and Terminal cards, preset prerequisites and launch-failure next steps. */
export const deviceAccess = {
  "settings.deviceAccess.files.title": "Files on this Mac",
  "settings.deviceAccess.files.hint":
    "The folders {persona} may read, and edit where you allow it. You share them in Permissions → File access.",
  "settings.deviceAccess.files.more": "{count, plural, one {and 1 more} other {and # more}}",
  "settings.deviceAccess.open": "Open File access",
  "settings.deviceAccess.terminal.title": "Terminal",
  "settings.deviceAccess.terminal.hint":
    "{persona} can run terminal commands on this Mac when Run commands on this Mac is on in Permissions → File access.",
  "settings.deviceAccess.terminal.where":
    "Commands run on your Mac, in the folders you shared, and can write only to a folder you shared read and write.",
  "settings.deviceAccess.terminal.asks":
    "Each command asks first, unless you choose to always allow that exact command.",
  "settings.deviceAccess.terminal.sandbox":
    "Commands run in the sandbox. One approved run goes without it only if you type UNSANDBOXED on its card.",
  "settings.deviceAccess.terminal.on": "Running commands is on",
  "settings.deviceAccess.terminal.off": "Running commands is off",
  "settings.deviceAccess.terminal.folders":
    "{count, plural, =0 {No folders shared yet: commands have nowhere to run.} one {1 folder shared.} other {# folders shared.}}",
  "settings.mcp.needs.title": "What this needs on your Mac",
  "settings.mcp.needs.srt": "Sandbox (srt)",
  "settings.mcp.needs.srt.fix": "Keeps the server away from Psyche's private data.",
  "settings.mcp.needs.node": "Node.js tools (npm)",
  "settings.mcp.needs.node.fix":
    "Runs on Psyche's own Node; needs npm on this Mac. Install Node.js from nodejs.org, or run brew install node.",
  "settings.mcp.needs.uv": "uv (uvx)",
  "settings.mcp.needs.uv.fix":
    "A Python server. Install uv with brew install uv or from docs.astral.sh/uv.",
  "settings.mcp.needs.network": "Network",
  "settings.mcp.needs.network.fix": "Reaches the server's own address.",
  "settings.mcp.needs.networkHosts": "Reaches only {hosts} to download and run the server.",
  "settings.mcp.needs.missing": "Missing",
  "settings.mcp.needs.ready": "Ready",
  "settings.mcp.needs.checked": "Checked on Check server",
  "settings.mcp.fail.no_srt":
    "The sandbox is not installed. Set it up below, then check the server again.",
  "settings.mcp.fail.node_missing":
    "Install Node.js (nodejs.org, or brew install node) so npm is on this Mac, then check again.",
  "settings.mcp.fail.uv_missing":
    "Install uv (brew install uv, or docs.astral.sh/uv), then check the server again.",
  "settings.mcp.fail.command_not_found":
    "The server's command is not installed here. Check the command, or install the tool it names.",
  "settings.mcp.fail.network_blocked":
    "The server could not download or reach what it needs. Check your connection, and that its hosts are allowed.",
  "settings.mcp.fail.timeout":
    "It took too long. The first run downloads the package; check your connection and try again.",
  "settings.mcp.fail.exited":
    "The server stopped right after it started. Its last output is below.",
  "settings.mcp.fail.failed": "Check the server's output below, then try again.",
  "settings.mcp.fail.exitCode": "Exit code {code}.",
  "settings.mcp.fail.output": "Server output",
} as const;
