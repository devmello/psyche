import { PsycheError } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { describeChange } from "../src/compose/mcp-edit.ts";
import {
  redactArgv,
  redactMcpServers,
  redactText,
  redactUrl,
  scrubError,
  urlHoldsMarker,
} from "../src/redact.ts";

// Built at run time: a literal user:password@ address trips the repository's secret scan.
const withUser = (user: string, word: string, rest: string) => `https://${user}:${word}@${rest}`;

describe("urlHoldsMarker", () => {
  it.each([
    "https://h.example.com/mcp?token=***",
    "https://h.example.com/mcp?token=***#%",
    "https://a%@h.example.com/mcp?token=***",
    "https://h.example.com/mcp?a=1&b=%2a%2a%2a",
    "https://h.example.com/***/sse",
    "https://h.example.com/mcp?***",
    "https://h.example.com/mcp#***",
    withUser("***", "***", "h.example.com/mcp"),
    withUser("%2A%2A%2A", "%2A%2A%2A", "h.example.com/mcp"),
  ])("holds a marker: %s", (url) => {
    expect(urlHoldsMarker(url)).toBe(true);
  });

  it("fails closed on a part it cannot decode", () => {
    expect(urlHoldsMarker("https://a%@h.example.com/mcp?token=real")).toBe(true);
    expect(urlHoldsMarker("https://h.example.com/mcp?token=real#%")).toBe(true);
  });

  it.each([
    "https://h.example.com/mcp?token=real",
    "https://h.example.com/mcp?x=1#frag",
    "https://h.example.com/a/b",
    "https://h.example.com/mcp?note=star*",
    withUser("u", "pw", "h.example.com/mcp"),
  ])("does not hold a marker: %s", (url) => {
    expect(urlHoldsMarker(url)).toBe(false);
  });
});

describe("redactUrl", () => {
  it.each([
    ["https://h.example.com/mcp?sk-SECRET", "https://h.example.com/mcp?***"],
    ["https://h.example.com/mcp?flag=", "https://h.example.com/mcp?***"],
    ["https://h.example.com/mcp?sk-abc=1", "https://h.example.com/mcp?***=***"],
    ["https://h.example.com/mcp?mode=fast&mode=slow", "https://h.example.com/mcp?mode=***"],
    ["https://actions.example.com/mcp/sk-ak-abcdef/sse", "https://actions.example.com/mcp/***/sse"],
    ["https://h.example.com/v1/abcd1234efgh5678ij/x", "https://h.example.com/v1/***/x"],
    [withUser("u", "pw", "h.example.com/mcp#frag"), "https://h.example.com/mcp"],
    ["https://[2001:db8::1]:8443/mcp?token=S", "https://[2001:db8::1]:8443/mcp?token=***"],
  ])("%s", (raw, shown) => {
    expect(redactUrl(raw)).toBe(shown);
  });

  it.each([
    "https://h.example.com/a/b",
    "https://h.example.com/mcp/server-filesystem",
    "https://h.example.com/v2/chat",
  ])("leaves an ordinary path alone: %s", (url) => {
    expect(redactUrl(url)).toBe(url);
  });
});

describe("redactText", () => {
  it.each([
    ["HTTPS://h.example.com/mcp?token=SECRETVAL", "https://h.example.com/mcp?token=***"],
    ["failed wss://h.example.com/s?k=ABCD1234", "failed wss://h.example.com/s?k=***"],
    [
      "see https://[2001:db8::1]:8443/mcp?token=SECRET99.",
      "see https://[2001:db8::1]:8443/mcp?token=***.",
    ],
    ["(https://h.example.com/mcp?token=ab)S)", "(https://h.example.com/mcp?token=***)"],
    [
      "reach https://h.example.com/mcp?token=SECRETVAL, retry",
      "reach https://h.example.com/mcp?token=***, retry",
    ],
    [
      'cannot reach "https:\\/\\/h.example.com\\/mcp?token=SECRETVAL"',
      'cannot reach "https://h.example.com/mcp?token=***"',
    ],
  ])("%s", (text, shown) => {
    expect(redactText(text)).toBe(shown);
  });

  it("leaves text without an address alone", () => {
    expect(redactText("the server did not start")).toBe("the server did not start");
  });

  it("hides the stored address's own secrets wherever they appear", () => {
    const stored = withUser("u", "pw1234-long", "h.example.com/mcp?token=ABCD1234&mode=fast");
    const out = redactText(
      "auth failed: user u word pw1234-long, token=ABCD1234 (encoded: ABCD1234), mode fast",
      [stored],
    );
    expect(out).not.toContain("pw1234-long");
    expect(out).not.toContain("ABCD1234");
    // Positive control: the rest of the sentence is intact.
    expect(out).toContain("auth failed");
  });

  it("a stored ?debug=true does not blank every 'true' in an error", () => {
    const out = redactText("expected true but got true", [
      "https://h.example.com/mcp?debug=true&fmt=json",
    ]);
    expect(out).toBe("expected true but got true");
    // Positive control: a long stored value is still hidden.
    expect(
      redactText("bad token ABCD1234EFGH here", ["https://h.example.com/mcp?token=ABCD1234EFGH"]),
    ).toBe("bad token *** here");
  });

  it("does not mangle text with a short stored value", () => {
    const out = redactText("1 of 3 tools, step 1", ["https://h.example.com/mcp?n=1"]);
    expect(out).toBe("1 of 3 tools, step 1");
  });

  it("scrubs an error's message and details", () => {
    const e = scrubError(
      new PsycheError("unavailable", "no route to https://h.example.com/mcp?token=SECRETVAL", {
        details: { error: "tail https://h.example.com/x?k=SECRETVAL" },
      }),
    );
    expect(JSON.stringify([e.message, e.details])).not.toContain("SECRETVAL");
    expect(e.code).toBe("unavailable");
  });
});

describe("the changed-parameters row", () => {
  const mk = (url: string) =>
    ({ id: "w", name: "W", trust: "unknown", transport: { kind: "http", url } }) as never;

  it("never lists a key that looks like a secret", () => {
    const { out } = describeChange(
      mk("https://h.example.com/mcp?sk-OLDSECRET&mode=a"),
      mk("https://h.example.com/mcp?sk-NEWSECRET&mode=b"),
    );
    expect(out.queryChanged).toEqual(["mode"]);
    expect(JSON.stringify(out)).not.toContain("SECRET");
  });
});

describe("redactMcpServers", () => {
  const stored = [
    {
      id: "a",
      name: "A",
      trust: "unknown",
      transport: {
        kind: "stdio",
        command: ["node", "x.js"],
        env: { PLAIN: "plain-secret-value", REF: "{{cred:a-key}}" },
      },
      sandbox: { allowedDomains: ["example.com"] },
    },
    {
      id: "b",
      name: "B",
      trust: "unknown",
      transport: { kind: "http", url: "https://h.example.com/mcp?token=URLSECRET" },
      auth: { kind: "oauth", clientId: "client-secret-id", scopes: ["x"] },
    },
    {
      id: "c",
      name: "C",
      trust: "unknown",
      transport: { kind: "http", url: "https://h.example.com/mcp" },
      auth: { kind: "bearer", credential: "{{cred:c-key}}" },
    },
  ];

  it("blanks env values, redacts URLs and keeps only an auth kind", () => {
    const out = JSON.stringify(redactMcpServers(stored));
    for (const secret of ["plain-secret-value", "URLSECRET", "client-secret-id", "c-key"]) {
      expect(out).not.toContain(secret);
    }
    // Positive control: names, references and shape survive.
    expect(out).toContain('"PLAIN":""');
    expect(out).toContain("{{cred:a-key}}");
    expect(out).toContain("h.example.com/mcp?token=***");
    expect(out).toContain('"kind":"oauth"');
    expect(out).toContain("example.com");
  });

  it("does not touch the stored value", () => {
    redactMcpServers(stored);
    expect(JSON.stringify(stored)).toContain("plain-secret-value");
  });

  it("returns nothing for what is not a list of entries", () => {
    expect(redactMcpServers(undefined)).toBeUndefined();
    expect(redactMcpServers("raw-secret-string")).toEqual([]);
    expect(redactMcpServers([null, "x", { id: "k" }])).toEqual([{ id: "k" }]);
  });
});

describe("redactArgv", () => {
  it.each([
    [
      ["npx", "-y", "server", "--api-key=sk-live-abc"],
      ["npx", "-y", "server", "--api-key=***"],
    ],
    [
      ["node", "x.js", "--token", "abc"],
      ["node", "x.js", "--token", "***"],
    ],
    [
      ["node", "x.js", "--password=hunter2"],
      ["node", "x.js", "--password=***"],
    ],
    [
      ["node", "sk-abc", "ghp_abc", "xoxb-1-2"],
      ["node", "***", "***", "***"],
    ],
    [
      ["node", "AbCdEfGhIj1234567890"],
      ["node", "***"],
    ],
    [
      ["node", "https://h.example.com/m?token=S"],
      ["node", "https://h.example.com/m?token=***"],
    ],
  ])("%j", (argv, shown) => {
    expect(redactArgv(argv)).toEqual(shown);
  });

  it.each([
    [
      ["node", "TOKEN=plainsecretvalue"],
      ["node", "TOKEN=***"],
    ],
    [
      ["node", "API_KEY=abc", "MODE=fast"],
      ["node", "API_KEY=***", "MODE=fast"],
    ],
    [
      ["node", "-k", "AbCdEfGhIj1234567890"],
      ["node", "-k", "***"],
    ],
    [
      ["node", "--mode=AbCdEfGhIj1234567890"],
      ["node", "--mode=***"],
    ],
    [
      ["node", "--access-token", "abc"],
      ["node", "--access-token", "***"],
    ],
  ])("hides a secret that a name or a value gives away: %j", (argv, shown) => {
    expect(redactArgv(argv)).toEqual(shown);
  });

  it.each([
    [["node", "--auth-mode", "oauth"]],
    [["node", "--key-name", "primary"]],
    [["node", "--token-file", "/Users/me/token.txt"]],
    [["node", "-k", "primary"]],
    [["node", "FOO=bar", "--retries=3"]],
  ])("does not over-redact: %j", (argv) => {
    expect(redactArgv(argv)).toEqual(argv);
  });

  it.each([
    [["npx", "-y", "@modelcontextprotocol/server-filesystem", "/Users/me/Projects"]],
    [["node", "dist/server.js", "--port=8080", "--verbose"]],
    [["uvx", "mcp-server-git", "--repository", "/Users/me/repo"]],
  ])("leaves ordinary arguments alone: %j", (argv) => {
    expect(redactArgv(argv)).toEqual(argv);
  });

  it("is applied to the settings view", () => {
    const out = JSON.stringify(
      redactMcpServers([
        {
          id: "a",
          transport: { kind: "stdio", command: ["node", "x.js", "--token=live-value-1"] },
        },
      ]),
    );
    expect(out).not.toContain("live-value-1");
    expect(out).toContain("x.js");
  });
});
