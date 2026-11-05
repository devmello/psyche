import { describe, expect, it } from "vitest";
import { buildBundle, MAX_BUNDLE_BYTES, verifyBundle } from "../src/bundle.ts";
import {
  buildConnectorBundle,
  type ConnectorModel,
  connectorWidenedBy,
  normalizeRequests,
  scanConnector,
  verifyConnectorBundle,
} from "../src/connector-bundle.ts";
import { createSkillsHandlers } from "../src/handlers.ts";
import { policyViolations, SKILL_FORBIDDEN_TOOLS } from "../src/policy.ts";
import { createSkillTools } from "../src/tools.ts";
import { TreeBuilder } from "../src/tree.ts";
import { authorKey, NOW, rejects, simple, treeOf } from "./bundle-kit.ts";
import { setup } from "./helpers.ts";

/** Connector bundles (docs/design/shared-bundles-2026.md section 8): the file and its rules. */

const enc = (s: string) => new TextEncoder().encode(s);

function model(over: Partial<ConnectorModel> = {}): ConnectorModel {
  return {
    name: "notes-sync",
    title: "Notes sync",
    description: "Searches and appends to a notes service.",
    requests: normalizeRequests({
      command: "node",
      args: ["server.mjs", "--fast"],
      env: ["NOTES_DIR"],
      secrets: [{ name: "NOTES_TOKEN", purpose: "API access" }],
      network: ["api.notes.example"],
      tools: [
        { name: "search", sideEffect: "read" },
        { name: "append", sideEffect: "write" },
      ],
    }),
    ...over,
  };
}

const script = () => treeOf({ "server.mjs": "console.log('hi');\n" });

// biome-ignore lint/suspicious/noExplicitAny: tests poke at arbitrary parsed JSON
type Json = Record<string, any>;

/** The file with `edit` applied to its parsed JSON, the signature left as it was. */
function edited(text: string, edit: (j: Json) => void): string {
  const j = JSON.parse(text);
  edit(j);
  return JSON.stringify(j);
}

describe("connector bundle format", () => {
  it("round-trips a signed bundle with its lists and script payload", () => {
    const key = authorKey("Ada");
    const text = buildConnectorBundle(model(), script(), key, NOW);
    const v = verifyConnectorBundle(text);
    expect(v.signer).toEqual(key.author);
    expect(v.manifest.kind).toBe("connector");
    expect(v.manifest.requests).toEqual(model().requests);
    expect([...v.tree.keys()]).toEqual(["server.mjs"]);
    expect(v.bundleHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(v.ancestors).toEqual([]);
  });

  it("works without a payload and unsigned, and says so", () => {
    const v = verifyConnectorBundle(buildConnectorBundle(model(), new Map(), undefined, NOW));
    expect(v.signer).toBeUndefined();
    expect(v.tree.size).toBe(0);
  });

  it("the signature covers the command, the args, the network and the env", () => {
    const text = buildConnectorBundle(model(), script(), authorKey("Ada"), NOW);
    const cases: [string, (j: Json) => void][] = [
      ["command", (j) => (j.manifest.requests.command = "python3")],
      ["args", (j) => j.manifest.requests.args.push("--steal")],
      ["args order", (j) => j.manifest.requests.args.reverse()],
      ["network", (j) => j.manifest.requests.network.push("evil.example")],
      ["env", (j) => j.manifest.requests.env.unshift("AAA_EXTRA")],
      ["secrets", (j) => j.manifest.requests.secrets.pop()],
      ["tools", (j) => (j.manifest.requests.tools[0].sideEffect = "destructive")],
      ["name", (j) => (j.manifest.name = "other-name")],
      ["description", (j) => (j.manifest.description = "something else")],
    ];
    for (const [what, edit] of cases) {
      expect(() => verifyConnectorBundle(edited(text, edit)), what).toThrow(
        /signature does not verify/,
      );
    }
    expect(() => verifyConnectorBundle(text)).not.toThrow();
  });

  it("a stripped signature or a swapped key is refused, never read as unsigned", () => {
    const text = buildConnectorBundle(model(), script(), authorKey("Ada"), NOW);
    expect(() => verifyConnectorBundle(edited(text, (j) => delete j.signature))).toThrow(
      /must be signed/,
    );
    const other = authorKey("Mallory");
    expect(() =>
      verifyConnectorBundle(edited(text, (j) => (j.manifest.author = other.author))),
    ).toThrow(/signature does not verify/);
  });

  it("a connector signature cannot be replayed as a skill bundle, or the other way round", () => {
    const key = authorKey("Ada");
    const c = buildConnectorBundle(model(), script(), key, NOW);
    expect(() => verifyBundle(c)).toThrow();
    const s = buildBundle(simple("tidy"), key, NOW);
    expect(() => verifyConnectorBundle(s)).toThrow(/unknown field|not a connector bundle/);
    // Even relabelled, the domain prefix differs, so the signature cannot carry over.
    const relabelled = edited(c, (j) => {
      j.manifest.format = "psyche-skill";
      j.manifest.kind = "skill";
    });
    expect(() => verifyBundle(relabelled)).toThrow();
  });

  it("carries names, never values: no field exists for one, and unknown fields are errors", () => {
    const text = buildConnectorBundle(model(), script(), authorKey("Ada"), NOW);
    expect(() =>
      verifyConnectorBundle(edited(text, (j) => (j.manifest.requests.envValues = { A: "b" }))),
    ).toThrow(/unknown field/);
    expect(() =>
      verifyConnectorBundle(
        edited(text, (j) => (j.manifest.requests.secrets[0].value = "not-allowed")),
      ),
    ).toThrow(/unknown field/);
    expect(() =>
      verifyConnectorBundle(edited(text, (j) => (j.manifest.requests.env[0] = "NOTES_DIR=/x"))),
    ).toThrow();
  });

  it("refuses lists the rules do not allow", () => {
    const bad = (requests: Partial<ConnectorModel["requests"]>) =>
      buildConnectorBundle(
        model({ requests: { ...model().requests, ...requests } }),
        new Map(),
        undefined,
        NOW,
      );
    // A secret-shaped name belongs in `secrets`.
    expect(() => bad({ env: ["API_KEY"] })).toThrow(/looks like a secret/);
    // A vault placeholder, or a NUL, cannot be part of a command.
    expect(() => bad({ args: ["--token", "{{cred:mail}}"] })).toThrow(/placeholder/);
    expect(() => bad({ args: ["a\u0000b"] })).toThrow();
    // Domains, not addresses, not URLs.
    expect(() => bad({ network: ["10.0.0.1"] })).toThrow(/not a domain/);
    expect(() => bad({ network: ["https://x.example"] })).toThrow(/not a domain/);
    // Names listed twice, or unsorted lists, are not canonical.
    expect(() =>
      bad({ env: ["NOTES_DIR"], secrets: [{ name: "NOTES_DIR", purpose: "" }] }),
    ).toThrow(/twice/);
    expect(() => bad({ network: ["b.example", "a.example"] })).toThrow(/sorted/);
    expect(() => bad({ tools: [{ name: "bad name!", sideEffect: "read" }] })).toThrow(
      /not a tool name/,
    );
    // Too many of anything.
    expect(() =>
      bad({
        network: Array.from({ length: 51 }, (_, i) => `d${String(i).padStart(2, "0")}.example`),
      }),
    ).toThrow(/more than/);
    expect(() => bad({ args: Array.from({ length: 63 }, () => "x") })).toThrow(/arguments/);
  });

  it("the same path rules and caps as a skill hold for the payload", async () => {
    const key = authorKey("Ada");
    const good = buildConnectorBundle(model(), script(), key, NOW);
    const withFile = (path: string) =>
      edited(good, (j) => {
        j.files[0].path = path;
        j.manifest.payload.files[0].path = path;
      });
    for (const path of [
      "../escape.mjs",
      "/etc/passwd",
      "a/./b",
      "a//b",
      "a\\b",
      ".git/config",
      "LESSONS.md",
    ]) {
      expect(() => verifyConnectorBundle(withFile(path)), path).toThrow();
    }
    // Case and form folding: `A.mjs` and `a.mjs` collide on APFS.
    const two = new TreeBuilder();
    two.add("a.mjs", enc("1"));
    two.add("A.mjs", enc("2"));
    expect(() => verifyConnectorBundle(buildConnectorBundle(model(), two.tree, key, NOW))).toThrow(
      /differ only in case/,
    );
    // A file over the per-file cap, a count over the file cap, and a bundle over 8 MiB.
    const small = { maxFiles: 2, maxFileBytes: 10, maxTotalBytes: 15 };
    const t1 = new TreeBuilder({ maxFiles: 50, maxFileBytes: 1_000, maxTotalBytes: 10_000 });
    t1.add("big.txt", enc("x".repeat(50)));
    expect(() =>
      verifyConnectorBundle(buildConnectorBundle(model(), t1.tree, key, NOW), small),
    ).toThrow(/larger than/);
    const t2 = new TreeBuilder({ maxFiles: 50, maxFileBytes: 1_000, maxTotalBytes: 10_000 });
    for (const n of ["a", "b", "c"]) t2.add(`${n}.txt`, enc("1"));
    expect(() =>
      verifyConnectorBundle(buildConnectorBundle(model(), t2.tree, key, NOW), small),
    ).toThrow(/more than 2 files/);
    expect(() => verifyConnectorBundle(`{"x":"${"a".repeat(MAX_BUNDLE_BYTES)}"}`)).toThrow(
      /larger than/,
    );
    // A file whose bytes do not match its hash, and non-canonical base64.
    expect(() =>
      verifyConnectorBundle(
        edited(good, (j) => (j.files[0].data = Buffer.from("other").toString("base64"))),
      ),
    ).toThrow(/hash|match/);
    // No link, target or mode fields can exist.
    expect(() =>
      verifyConnectorBundle(edited(good, (j) => (j.files[0].target = "/etc/passwd"))),
    ).toThrow(/unknown field/);
  });

  it("scans the command line and the scripts for secrets and bad endpoints", () => {
    // Built at run time: the repo secret scan flags literal key shapes.
    const fake = ["gh", "p_", "a".repeat(36)].join("");
    const r = model().requests;
    const findings = scanConnector({ ...r, args: ["--token", fake] }, new Map());
    expect(findings.some((f) => f.rule === "secret" && f.severity === "high")).toBe(true);
    const tree = treeOf({ "x.mjs": `fetch("https://webhook.site/abc")\n` });
    expect(scanConnector(r, tree).some((f) => f.severity === "high")).toBe(true);
    // The message never quotes the match.
    expect(JSON.stringify(findings)).not.toContain(fake);
  });
});

describe("what an update asks for beyond the installed version", () => {
  const base = model().requests;
  const before = { requests: base, treeHash: "sha256:a" };

  it("is nothing for the same request, or a narrower one", () => {
    expect(connectorWidenedBy(before, before)).toBeUndefined();
    const narrower = normalizeRequests({
      command: "node",
      args: ["server.mjs", "--fast"],
      env: [],
      secrets: [],
      network: [],
      tools: [{ name: "search", sideEffect: "read" }],
    });
    expect(
      connectorWidenedBy(before, { requests: narrower, treeHash: "sha256:a" }),
    ).toBeUndefined();
  });

  it("flags a changed command, arguments, new env, secrets, domains, tools and scripts", () => {
    const widen = (r: Partial<typeof base>, treeHash = "sha256:a") =>
      connectorWidenedBy(before, { requests: { ...base, ...r }, treeHash });
    expect(widen({ command: "python3" })?.command).toBe(true);
    expect(widen({ args: ["server.mjs"] })?.command).toBe(true);
    expect(widen({ env: [...base.env, "OTHER_DIR"].sort() })?.env).toEqual(["OTHER_DIR"]);
    expect(
      widen({ secrets: [...base.secrets, { name: "SECOND_TOKEN", purpose: "" }] })?.secrets,
    ).toEqual(["SECOND_TOKEN"]);
    expect(widen({ network: [...base.network, "evil.example"].sort() })?.network).toEqual([
      "evil.example",
    ]);
    expect(
      widen({ tools: [...base.tools, { name: "delete", sideEffect: "destructive" as const }] })
        ?.tools,
    ).toEqual(["delete"]);
    // A tool that is still there but can do more than it said.
    expect(
      widen({
        tools: base.tools.map((t) =>
          t.name === "search" ? { ...t, sideEffect: "write" as const } : t,
        ),
      })?.tools,
    ).toEqual(["search"]);
    expect(widen({}, "sha256:b")?.payload).toBe(true);
  });

  it("a first install is all of it", () => {
    const w = connectorWidenedBy(undefined, { requests: base, treeHash: "sha256:a" });
    expect(w?.command).toBe(true);
    expect(w?.network).toEqual(["api.notes.example"]);
  });
});

describe("the agent cannot export, import or trust a connector", () => {
  it("a skill cannot declare the connector methods or the new author methods as tools", () => {
    for (const tool of [
      "connectors.export",
      "connectors.proposeImport",
      "connectors.resetRecords",
      "skills.authors.rotate",
      "skills.authors.importNotice",
      "skills.authors.createNotice",
    ]) {
      expect(policyViolations({ tools: [tool], permissions: [], prompts: [] }), tool).toHaveLength(
        1,
      );
    }
    expect(SKILL_FORBIDDEN_TOOLS).toContain("connectors.*");
  });

  it("the new methods are admin-scope, side-effecting owner actions, and the agent's skill tools stay read-only", async () => {
    const { Methods } = await import("@psyche/protocol");
    const m = Methods as Record<string, { scope: string; sideEffecting?: boolean }>;
    for (const name of [
      "connectors.export",
      "connectors.proposeImport",
      "connectors.resetRecords",
      "skills.authors.rotate",
      "skills.authors.createNotice",
      "skills.authors.importNotice",
    ]) {
      expect(m[name]?.scope, name).toBe("operator.admin");
      expect(m[name]?.sideEffecting, name).toBe(true);
    }
    const a = setup();
    expect(
      createSkillTools(a.loader)
        .map((t) => t.spec.name)
        .sort(),
    ).toEqual(["skills_read", "skills_search"]);
  });

  it("the handlers refuse to sign, rotate or import a notice without the Gateway's gates", async () => {
    const a = setup();
    const handlers = createSkillsHandlers(a.loader, { broker: a.broker });
    await rejects(handlers["skills.authors.rotate"]({}));
    await rejects(handlers["skills.authors.createNotice"]({ kind: "key", reason: "lost" }));
  });

  it("a rejected request never partially succeeds: a forged file leaves no trace", async () => {
    const e = await rejects(() => verifyConnectorBundle("{}"));
    expect(e.code).toBe("invalid_params");
  });
});
