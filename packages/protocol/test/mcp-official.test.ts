import { describe, expect, it } from "vitest";
import { mcpTrustFor, officialCommandPackage, officialRemoteHost } from "../src/index.ts";

const stdio = (...command: string[]) => mcpTrustFor({ kind: "stdio", command });
const http = (url: string) => mcpTrustFor({ kind: "http", url });

describe("mcpTrustFor: verified only for an exact official source", () => {
  it("verifies the MCP project's reference servers and vendors' exact packages", () => {
    expect(stdio("npx", "-y", "@modelcontextprotocol/server-filesystem", "/tmp")).toBe("verified");
    expect(stdio("npx", "@modelcontextprotocol/server-memory@2026.8.31")).toBe("verified");
    expect(stdio("npx", "--yes", "@stripe/mcp", "--tools=all")).toBe("verified");
    expect(stdio("npx", "@playwright/mcp@latest")).toBe("verified");
    expect(stdio("uvx", "mcp-server-git", "--repository", "/repo")).toBe("verified");
    expect(stdio("uvx", "mcp-server-fetch==1.2.0")).toBe("verified");
  });

  it("leaves lookalikes, other scopes and other launchers unknown", () => {
    expect(stdio("npx", "-y", "@modelcontextprotocol-evil/server-filesystem")).toBe("unknown");
    expect(stdio("npx", "-y", "modelcontextprotocol/server-filesystem")).toBe("unknown");
    expect(stdio("npx", "-y", "@modelcontextprotocol/inspector")).toBe("unknown");
    expect(stdio("npx", "-y", "@modelcontextprotocol/server-")).toBe("unknown");
    expect(stdio("npx", "-y", "@stripe/mcp-evil")).toBe("unknown");
    expect(stdio("npx", "-y", "stripe-mcp")).toBe("unknown");
    expect(stdio("uvx", "mcp-server-gitt")).toBe("unknown");
    expect(stdio("pipx", "run", "mcp-server-git")).toBe("unknown");
    expect(stdio("node", "server.js")).toBe("unknown");
    expect(stdio("sh", "-c", "npx @stripe/mcp")).toBe("unknown");
  });

  it("does not follow flags or specs that change what runs", () => {
    // A different package is what runs after --package / --from / a git or URL spec.
    expect(stdio("npx", "--package", "evil", "@stripe/mcp")).toBe("unknown");
    expect(stdio("npx", "-y", "-p", "evil", "@stripe/mcp")).toBe("unknown");
    expect(stdio("npx", "-y", "@stripe/mcp@github:evil/repo")).toBe("unknown");
    expect(stdio("npx", "-y", "@stripe/mcp@https://evil.test/x.tgz")).toBe("unknown");
    expect(stdio("uvx", "--from", "evil", "mcp-server-git")).toBe("unknown");
    expect(stdio("uvx", "--index-url", "https://evil.test", "mcp-server-git")).toBe("unknown");
    expect(stdio("npx")).toBe("unknown");
    expect(officialCommandPackage([])).toBeUndefined();
  });

  it("verifies exact vendor endpoints over https only", () => {
    expect(http("https://mcp.linear.app/mcp")).toBe("verified");
    expect(http("https://mcp.notion.com/mcp/")).toBe("verified");
    expect(http("https://api.githubcopilot.com/mcp/")).toBe("verified");
    expect(http("https://gitlab.com/api/v4/mcp")).toBe("verified");
    expect(officialRemoteHost("https://mcp.sentry.dev/mcp")).toBe("mcp.sentry.dev");
  });

  it("leaves other hosts, lookalike hosts, other paths and odd URLs unknown", () => {
    expect(http("http://mcp.linear.app/mcp")).toBe("unknown");
    expect(http("https://mcp.linear.app.evil.test/mcp")).toBe("unknown");
    expect(http("https://evil.test/mcp.linear.app")).toBe("unknown");
    expect(http("https://mcp.linear.app@evil.test/mcp")).toBe("unknown");
    expect(http("https://user:pw@mcp.linear.app/mcp")).toBe("unknown");
    expect(http("https://mcp.linear.app:8443/mcp")).toBe("unknown");
    expect(http("https://sub.mcp.linear.app/mcp")).toBe("unknown");
    // A host shared with user content is matched with its path.
    expect(http("https://gitlab.com/someone/repo")).toBe("unknown");
    expect(http("https://api.githubcopilot.com/other")).toBe("unknown");
    expect(http("not a url")).toBe("unknown");
    // The owner's own Home Assistant is never vendor-verified.
    expect(http("https://home.example.com/api/mcp")).toBe("unknown");
  });
});
