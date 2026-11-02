import { PsycheError } from "@psyche/protocol";
import { describe, expect, it, vi } from "vitest";
import { mcpAppHandler } from "../src/compose/mcp-app.ts";

const resource = {
  serverId: "echo",
  uri: "ui://echo/chart.html",
  mimeType: "text/html;profile=mcp-app",
  html: "<div id=chart></div>",
  csp: { connectDomains: ["https://api.evil.example"] },
  permissions: { camera: {} },
  toolsListHash: "x",
  provenance: "untrusted",
} as never;

function setup(over: { running?: boolean; withheld?: boolean } = {}) {
  const read = vi.fn(async (_s: string, uri: string) => {
    if (uri !== "ui://echo/chart.html") throw new PsycheError("forbidden", "not declared");
    return resource;
  });
  const h = mcpAppHandler({
    running: (id) => id === "echo" && over.running !== false,
    withheld: () => over.withheld === true,
    host: {
      appResources: (id) =>
        id === "echo" ? [{ tool: "show_chart", resourceUri: "ui://echo/chart.html" }] : [],
      readAppResource: read as never,
    },
  });
  const run = (tool: string) =>
    (h.run as (c: unknown, p: { tool: string }) => Promise<unknown>)({}, { tool });
  return { run, read };
}

describe("mcp.app", () => {
  it("serves the resource the tool's own server declares, as untrusted data", async () => {
    const { run, read } = setup();
    const r = (await run("mcp__echo__show_chart")) as {
      available: boolean;
      app: { provenance: string; html: string };
    };
    expect(r.available).toBe(true);
    expect(r.app.provenance).toBe("untrusted");
    expect(r.app.html).toContain("chart");
    expect(read).toHaveBeenCalledWith("echo", "ui://echo/chart.html");
  });

  it("answers not available for a tool with no app, an unknown server, a stopped server or a withheld tool", async () => {
    expect(await setup().run("mcp__echo__other")).toEqual({ available: false });
    expect(await setup().run("mcp__ghost__show_chart")).toEqual({ available: false });
    expect(await setup().run("not-an-mcp-tool")).toEqual({ available: false });
    expect(await setup({ running: false }).run("mcp__echo__show_chart")).toEqual({
      available: false,
    });
    const withheld = setup({ withheld: true });
    expect(await withheld.run("mcp__echo__show_chart")).toEqual({ available: false });
    expect(withheld.read).not.toHaveBeenCalled();
  });

  it("takes a tool name, never a URI: a ui:// or file:// string reads nothing", async () => {
    const { run, read } = setup();
    for (const t of [
      "ui://echo/chart.html",
      "file:///etc/passwd",
      "mcp__echo__show_chart/../x",
      "https://evil.example/",
    ]) {
      expect(await run(t)).toEqual({ available: false });
    }
    expect(read).not.toHaveBeenCalled();
  });
});
