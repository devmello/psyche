import { describe, expect, it } from "vitest";
import { reResolvesOnLaunch } from "../src/index.ts";

/**
 * Package runners re-resolve their package on every start, so a server started through one is
 * never idle-stopped (and never restarted by the host) unless the package is pinned to an exact
 * version. Owner decision on PR #1401.
 */
const split = (line: string) => line.split(" ");

describe("reResolvesOnLaunch", () => {
  // Must match: a restart could fetch a different release.
  it.each([
    "npx -y @scope/pkg",
    "npx @modelcontextprotocol/server-filesystem /tmp",
    "npx -y pkg@latest",
    "npx -y pkg@^1",
    "npx -y pkg@~1.2.3",
    "npx -y pkg@1",
    "npx -y pkg@1.2",
    "npx -y pkg@1.x",
    "npx -y pkg@>=1.2.3",
    "npx -y pkg@next",
    "npx -y pkg@v1.2.3",
    "npx -y github:someone/pkg",
    "npx -y https://example.com/pkg.tgz",
    "npx -y ./local-pkg",
    "npx -p pkg@1.2.3 -p other server",
    "npx --package=pkg server",
    "npx -c 'pkg@1.2.3 run'",
    "npx",
    "/usr/local/bin/npx -y pkg",
    "C:\\Program Files\\nodejs\\npx.cmd -y pkg",
    "pnpx pkg",
    "pnpm dlx pkg",
    "pnpm dlx --package=pkg@^2 server",
    "yarn dlx pkg",
    "yarn dlx -p pkg server",
    "bunx pkg",
    "bunx pkg@latest",
    "bun x pkg",
    "npm exec pkg",
    "npm exec -- pkg",
    "npm x pkg@latest",
    "uvx mcp-server-fetch",
    "uvx mcp-server-fetch@latest",
    "uvx mcp-server-fetch>=1.0",
    "uvx mcp-server-fetch==1.*",
    "uvx --from mcp-server-fetch mcp-server-fetch",
    "uvx --from git+https://github.com/x/y tool",
    "uvx --from pkg==1.0.0 --with extra tool",
    "uvx --with-requirements req.txt pkg==1.0.0",
    "uvx --python 3.12 pkg",
    "uv tool run pkg",
    "pipx run pkg",
    "pipx run --spec pkg app",
    "pipx run pkg==1.*",
    "sh -c npx -y pkg",
    "env FOO=1 npx -y pkg",
    "node server.js && npx pkg",
  ])("%s", (line) => {
    expect(reResolvesOnLaunch(split(line))).toBe(true);
  });

  it("splits a shell string inside one argument", () => {
    expect(reResolvesOnLaunch(["sh", "-c", "npx -y @scope/pkg"])).toBe(true);
    expect(reResolvesOnLaunch(["sh", "-c", "npx -y @scope/pkg@1.2.3"])).toBe(false);
  });

  // Must not match: no runner, or every package pinned to one exact release.
  it.each([
    "node server.js",
    "node /opt/npx-free/server.js",
    "python -m mcp_server",
    "/usr/bin/env python3 server.py",
    "docker run --rm -i mcp/fetch",
    "npm run start",
    "pnpm start",
    "yarn start",
    "uv run server.py",
    "pipx install pkg",
    "npx -y @scope/pkg@1.2.3",
    "npx -y pkg@1.2.3",
    "npx pkg@1.2.3 --port 3000 extra",
    "npx -y pkg@1.2.3-beta.1",
    "npx -y pkg@1.2.3+build.5",
    "npx --yes --registry https://registry.example pkg@1.2.3",
    "npx -p pkg@1.2.3 -p @s/other@0.1.0 server",
    "npx --package=pkg@1.2.3 server",
    "npm exec -- pkg@1.2.3",
    "pnpm dlx pkg@1.2.3",
    "yarn dlx pkg@1.2.3",
    "bunx @scope/pkg@2.0.0",
    "bun x pkg@2.0.0",
    "uvx mcp-server-fetch==2025.4.7",
    "uvx mcp-server-fetch@2025.4.7",
    "uvx pkg[extra]==1.0.0",
    "uvx --python 3.12 pkg==1.0.0",
    "uvx --from pkg==1.0.0 tool",
    "uvx --from pkg==1.0.0 --with other==2.0,third==3.1rc1 tool",
    "uv tool run pkg==1.0.post1",
    "pipx run pkg==1.0.0",
    "pipx run --spec pkg==1.0.0 app",
  ])("%s", (line) => {
    expect(reResolvesOnLaunch(split(line))).toBe(false);
  });
});
