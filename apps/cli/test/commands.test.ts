import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { MockGateway } from "@psyche/web/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";
import { loadOrCreateIdentity } from "../src/identity.ts";
import { AUTOMATION, CREDENTIAL, DEVICE, HANDLERS, PAIRING_REQUEST } from "./fixtures.ts";
import { cleanupTempDirs, err, makeDeps, out, runJson, type TestDeps, tempDir } from "./helpers.ts";

const ALL_SCOPES = ["operator.read", "operator.write", "operator.approvals", "operator.admin"];
const SECRET = "psyche-test-secret-value-9f8e7d";

let gw: MockGateway;
const running: MockGateway[] = [];

async function startGateway(opts: ConstructorParameters<typeof MockGateway>[0]): Promise<void> {
  gw = await new MockGateway(opts).start();
  running.push(gw);
}

afterEach(async () => {
  for (const g of running.splice(0)) await g.stop();
  cleanupTempDirs();
});

const urlArgs = (deps: TestDeps) => ["--url", gw.origin, "--home", deps.home];
const callsTo = (method: string) => gw.calls.filter((c) => c.method === method);
const lastParams = (method: string) =>
  callsTo(method).at(-1)?.params as Record<string, unknown> | undefined;

interface Case {
  name: string;
  argv: (deps: TestDeps) => string[];
  stdin?: () => NodeJS.ReadableStream;
  human: (text: string, deps: TestDeps) => void;
  json: (data: Record<string, unknown>, deps: TestDeps) => void;
  calls?: (deps: TestDeps) => void;
}

const CASES: Case[] = [
  {
    name: "pairing list",
    argv: () => ["pairing", "list"],
    human: (t) => {
      expect(t).toContain("CODE");
      expect(t).toContain(PAIRING_REQUEST.code);
    },
    json: (d) => expect(d.pairingRequests).toEqual([PAIRING_REQUEST]),
    calls: () => expect(lastParams("devices.pairing.list")).toEqual({ status: "pending" }),
  },
  {
    name: "pairing approve",
    argv: () => ["pairing", "approve", PAIRING_REQUEST.code.toLowerCase()],
    human: (t) => expect(t).toMatch(/^Approved Pixel 10 .* with operator\.read/),
    json: (d) => expect((d.device as { scopes: string[] }).scopes).toHaveLength(3),
    calls: () => {
      expect(callsTo("devices.pairing.list")).toHaveLength(1);
      expect(lastParams("devices.approve")).toEqual({
        pairingRequestId: PAIRING_REQUEST.id,
        scopes: ["operator.read", "operator.write", "operator.approvals"],
        code: PAIRING_REQUEST.code,
      });
    },
  },
  {
    name: "pairing approve --admin",
    argv: () => ["pairing", "approve", PAIRING_REQUEST.code, "--admin"],
    human: (t) => expect(t).toContain("operator.admin"),
    json: (d) => expect((d.device as { scopes: string[] }).scopes).toContain("operator.admin"),
    calls: () => expect(lastParams("devices.approve")?.scopes).toEqual(ALL_SCOPES),
  },
  {
    name: "pairing deny",
    argv: () => ["pairing", "deny", PAIRING_REQUEST.code, "--reason", "not mine"],
    human: (t) => expect(t).toBe(`Denied pairing request ${PAIRING_REQUEST.code} (Pixel 10 (web))`),
    json: (d) => expect((d.pairingRequest as { status: string }).status).toBe("denied"),
    calls: () =>
      expect(lastParams("devices.deny")).toEqual({
        pairingRequestId: PAIRING_REQUEST.id,
        reason: "not mine",
      }),
  },
  {
    name: "devices list",
    argv: () => ["devices", "list"],
    human: (t) => {
      expect(t).toContain("LAST SEEN");
      expect(t).toContain(DEVICE.id);
    },
    json: (d) => expect(d.devices).toEqual([DEVICE]),
    calls: () => expect(lastParams("devices.list")).toEqual({ includeRevoked: false }),
  },
  {
    name: "devices revoke --yes",
    argv: () => ["devices", "revoke", DEVICE.id, "--yes"],
    human: (t) => expect(t).toBe(`Revoked ${DEVICE.id}`),
    json: (d) => expect((d.device as { revokedAt: string }).revokedAt).toBeTruthy(),
    calls: () => expect(lastParams("devices.revoke")).toEqual({ deviceId: DEVICE.id }),
  },
  {
    name: "audit verify",
    argv: () => ["audit", "verify"],
    human: (t) => {
      expect(t).toContain("Hash chain intact: 2400 entries");
      expect(t).toContain("2 of 3 anchors signed and verified (keys: ed25519:0123456789abcdef)");
      expect(t).toContain("signing since entry 1000");
    },
    json: (d) => expect(d).toMatchObject({ ok: true, signedAnchors: 2 }),
    calls: () => expect(lastParams("audit.verify")).toEqual({}),
  },
  {
    name: "automations list",
    argv: () => ["automations", "list"],
    human: (t) => expect(t).toContain("Morning brief"),
    json: (d) => expect(d.automations).toEqual([AUTOMATION]),
  },
  {
    name: "automations run",
    argv: () => ["automations", "run", AUTOMATION.id],
    human: (t) => expect(t).toMatch(/^Started run 01JRUN/),
    json: (d) => expect(d).toHaveProperty("runId"),
    calls: () => {
      expect(lastParams("automations.run")).toEqual({ automationId: AUTOMATION.id });
      expect(callsTo("automations.run")[0]?.idempotencyKey).toBeTruthy();
    },
  },
  {
    name: "automations pause",
    argv: () => ["automations", "pause", AUTOMATION.id],
    human: (t) => expect(t).toBe(`Paused ${AUTOMATION.id}`),
    json: (d) => expect((d.automation as { enabled: boolean }).enabled).toBe(false),
    calls: () =>
      expect(lastParams("automations.update")).toEqual({
        automationId: AUTOMATION.id,
        enabled: false,
      }),
  },
  {
    name: "automations resume",
    argv: () => ["automations", "resume", AUTOMATION.id],
    human: (t) => expect(t).toBe(`Resumed ${AUTOMATION.id}`),
    json: (d) => expect((d.automation as { enabled: boolean }).enabled).toBe(true),
    calls: () => expect(lastParams("automations.update")?.enabled).toBe(true),
  },
  {
    name: "vault status",
    argv: () => ["vault", "status"],
    human: (t) => {
      expect(t).toMatch(/state:\s+unlocked/);
      expect(t).toMatch(/items:\s+1/);
    },
    json: (d) => expect((d.status as { state: string }).state).toBe("unlocked"),
  },
  {
    name: "vault list",
    argv: () => ["vault", "list"],
    human: (t) => {
      expect(t).toContain("{{cred:anthropic}}");
      expect(t).toContain("https://api.anthropic.com");
    },
    json: (d) => expect(d.credentials).toEqual([CREDENTIAL]),
  },
  {
    name: "vault add --secret-stdin",
    argv: () => [
      "vault",
      "add",
      "GitHub token",
      "--slug",
      "github-token",
      "--bind",
      "https://api.github.com/x",
      "--secret-stdin",
    ],
    stdin: () => Readable.from([`${SECRET}\n`]),
    human: (t) => expect(t).toBe("Added GitHub token; refer to it as {{cred:github-token}}"),
    json: (d) => expect((d.credential as { slug: string }).slug).toBe("github-token"),
    calls: (deps) => {
      const call = callsTo("vault.add")[0];
      expect(call?.idempotencyKey).toBeTruthy();
      expect(call?.params).toEqual({
        kind: "api_key",
        name: "GitHub token",
        slug: "github-token",
        bindings: [{ origin: "https://api.github.com" }],
        secret: { token: SECRET },
      });
      expect(out(deps)).not.toContain(SECRET);
      expect(err(deps)).not.toContain(SECRET);
      expect(out(deps)).not.toContain("9f8e7d");
    },
  },
  {
    name: "vault import",
    argv: (deps) => {
      const file = join(deps.userHome, "export.csv");
      writeFileSync(file, "name,url,username,password\nx,https://x.test,me,pw\n");
      return ["vault", "import", file, "--format", "chrome"];
    },
    human: (t) => {
      expect(t).toContain("Imported 1, skipped 1.");
      expect(t).toContain("Now delete");
    },
    json: (d) => expect(d.imported).toHaveLength(1),
    calls: () => {
      expect(lastParams("vault.import")?.format).toBe("chrome");
      expect(String(lastParams("vault.import")?.csv)).toContain("https://x.test");
      expect(callsTo("vault.import")[0]?.idempotencyKey).toBeTruthy();
    },
  },
  {
    name: "vault lock",
    argv: () => ["vault", "lock"],
    human: (t) => expect(t).toMatch(/state:\s+locked/),
    json: (d) => expect((d.status as { state: string }).state).toBe("locked"),
    calls: () => expect(callsTo("vault.lock")[0]?.idempotencyKey).toBeTruthy(),
  },
  {
    name: "vault unlock",
    argv: () => ["vault", "unlock", "--reason", "deploy"],
    human: (t) => expect(t).toMatch(/state:\s+unlocked/),
    json: (d) => expect((d.status as { state: string }).state).toBe("unlocked"),
    calls: () => {
      expect(lastParams("vault.unlock")).toEqual({ reason: "deploy" });
      expect(callsTo("vault.unlock")[0]?.idempotencyKey).toBeTruthy();
    },
  },
  {
    name: "config get (settings)",
    argv: () => ["config", "get"],
    human: (t) => {
      expect(t).toContain("appearance.theme");
      expect(t).toContain('"dark"');
    },
    json: (d) => {
      expect(d.source).toBe("settings");
      expect(d.stateVersion).toBe(3);
      expect(d.settings).toHaveProperty("appearance.theme", "dark");
    },
    calls: () => expect(lastParams("settings.get")).toEqual({}),
  },
  {
    name: "config get <key>",
    argv: () => ["config", "get", "appearance.theme"],
    human: (t) => expect(t).toContain("appearance.theme"),
    json: (d) => expect(d.source).toBe("settings"),
    calls: () => expect(lastParams("settings.get")).toEqual({ keys: ["appearance.theme"] }),
  },
  {
    name: "config set (settings)",
    argv: () => ["config", "set", "appearance.theme", "light"],
    human: (t) => expect(t).toBe("Set appearance.theme"),
    json: (d) => {
      expect(d.source).toBe("settings");
      expect(d.stateVersion).toBe(4);
    },
    calls: () => {
      expect(lastParams("settings.set")).toEqual({ key: "appearance.theme", value: "light" });
      expect(callsTo("settings.set")[0]?.idempotencyKey).toBeTruthy();
    },
  },
  {
    name: "version",
    argv: () => ["version"],
    human: (t) => {
      expect(t).toMatch(/psyche:\s+\S+ \(protocol \d+\)/);
      expect(t).toMatch(/gateway:\s+unknown/);
    },
    json: (d) => {
      expect(d.cli).toMatchObject({
        version: expect.any(String),
        protocolVersion: expect.any(Number),
      });
      expect(d.gateway).toEqual({ version: "unknown" });
    },
  },
];

describe("commands against a paired MockGateway", () => {
  beforeEach(async () => {
    await startGateway({
      pair: { phase: "paired", scopes: ALL_SCOPES },
      handlers: HANDLERS,
    });
  });

  for (const c of CASES) {
    it(`${c.name} (human)`, async () => {
      const deps = makeDeps(c.stdin ? { stdin: c.stdin() } : {});
      const code = await run([...c.argv(deps), ...urlArgs(deps)], deps);
      expect(err(deps)).toBe("");
      expect(code).toBe(0);
      c.human(out(deps), deps);
      c.calls?.(deps);
    });
    it(`${c.name} (--json)`, async () => {
      const deps = makeDeps(c.stdin ? { stdin: c.stdin() } : {});
      const { code, json } = await runJson([...c.argv(deps), ...urlArgs(deps)], deps);
      expect(code).toBe(0);
      c.json(json, deps);
      c.calls?.(deps);
    });
  }

  it("devices revoke without --yes and no terminal is a usage error", async () => {
    const deps = makeDeps();
    expect(await run(["devices", "revoke", DEVICE.id, ...urlArgs(deps)], deps)).toBe(2);
    expect(callsTo("devices.revoke")).toHaveLength(0);
  });

  it("pairing approve with an unknown code fails without approving", async () => {
    const deps = makeDeps();
    const { code, json } = await runJson(["pairing", "approve", "NOPE", ...urlArgs(deps)], deps);
    expect(code).toBe(1);
    expect(json).toMatchObject({ ok: false, error: { code: "failure" } });
    expect(callsTo("devices.approve")).toHaveLength(0);
  });

  describe("config.json keys", () => {
    it("config set gateway.port writes config.json 0600 without touching the Gateway", async () => {
      const deps = makeDeps();
      expect(await run(["config", "set", "gateway.port", "8000", ...urlArgs(deps)], deps)).toBe(0);
      expect(out(deps)).toContain("Restart the Gateway");
      const file = join(deps.home, "config.json");
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ gateway: { port: 8000 } });
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(gw.connects).toHaveLength(0);
      expect(gw.calls).toHaveLength(0);
    });

    it("config set gateway.port --json", async () => {
      const deps = makeDeps();
      const { code, json } = await runJson(
        ["config", "set", "gateway.port", "8000", ...urlArgs(deps)],
        deps,
      );
      expect(code).toBe(0);
      expect(json).toEqual({
        source: "config.json",
        key: "gateway.port",
        value: 8000,
        restartRequired: true,
      });
      expect(gw.connects).toHaveLength(0);
    });

    it("config get gateway.port reads the file", async () => {
      const deps = makeDeps();
      writeFileSync(join(deps.home, "config.json"), JSON.stringify({ gateway: { port: 8000 } }));
      const { code, json } = await runJson(
        ["config", "get", "gateway.port", ...urlArgs(deps)],
        deps,
      );
      expect(code).toBe(0);
      expect(json).toEqual({ source: "config.json", values: { "gateway.port": 8000 } });
      expect(gw.connects).toHaveLength(0);
    });

    it("unknown gateway.foo is a usage error (exit 2)", async () => {
      const deps = makeDeps();
      expect(await run(["config", "set", "gateway.foo", "1", ...urlArgs(deps)], deps)).toBe(2);
      expect(err(deps)).toContain("Unknown config key gateway.foo");
      const j = makeDeps();
      const { code, json } = await runJson(["config", "set", "gateway.foo", "1", ...urlArgs(j)], j);
      expect(code).toBe(2);
      expect(json).toMatchObject({ ok: false, error: { code: "usage" } });
      expect(existsSync(join(deps.home, "config.json"))).toBe(false);
    });

    it("an invalid gateway.port value is a usage error", async () => {
      const deps = makeDeps();
      expect(await run(["config", "set", "gateway.port", "99999", ...urlArgs(deps)], deps)).toBe(2);
    });
  });

  describe("status", () => {
    it("healthy Gateway with an identity → exit 0, cli.paired true (human)", async () => {
      const deps = makeDeps();
      loadOrCreateIdentity(deps.home);
      expect(await run(["status", ...urlArgs(deps)], deps)).toBe(0);
      expect(out(deps)).toMatch(/gateway:\s+healthy at http:\/\/127\.0\.0\.1:\d+/);
      expect(out(deps)).toMatch(/cli:\s+paired \(operator\.read/);
    });

    it("healthy Gateway with an identity → --json", async () => {
      const deps = makeDeps();
      const id = loadOrCreateIdentity(deps.home);
      const { code, json } = await runJson(["status", ...urlArgs(deps)], deps);
      expect(code).toBe(0);
      expect(json.gateway).toMatchObject({ url: gw.origin, reachable: true, healthy: true });
      expect(json.cli).toEqual({ paired: true, scopes: ALL_SCOPES, deviceId: id.deviceId });
      expect(json.service).toHaveProperty("kind");
    });

    it("without an identity it does not connect (no pairing request)", async () => {
      const deps = makeDeps();
      const { code, json } = await runJson(["status", ...urlArgs(deps)], deps);
      expect(code).toBe(0);
      expect((json.cli as { paired: boolean }).paired).toBe(false);
      expect(gw.connects).toHaveLength(0);
      expect(existsSync(join(deps.home, "cli", "device.json"))).toBe(false);
    });
  });

  describe("diagnostics", () => {
    /** Keeps the local Chrome / Ollama probes deterministic. */
    const noLocalServices = (deps: TestDeps): TestDeps => {
      const real = deps.fetch;
      deps.fetch = ((input: string | URL | Request, init?: RequestInit) => {
        const u = new URL(input instanceof Request ? input.url : String(input));
        if (u.port === "9222" || u.port === "11434") {
          return Promise.reject(new TypeError("fetch failed"));
        }
        return real(input, init);
      }) as typeof fetch;
      return deps;
    };

    it("doctor --json has checks and a matching exit code", async () => {
      const deps = noLocalServices(makeDeps());
      const { code, json } = await runJson(["doctor", ...urlArgs(deps)], deps);
      expect(code).toBe(json.ok ? 0 : 1);
      const checks = json.checks as { id: string; status: string; message: string }[];
      const ids = checks.map((c) => c.id);
      expect(ids).toEqual(expect.arrayContaining(["config", "gateway", "bind", "auth", "models"]));
      for (const c of checks) {
        expect(["ok", "warn", "fail", "skip"]).toContain(c.status);
        expect(typeof c.message).toBe("string");
      }
      expect(checks.find((c) => c.id === "gateway")?.status).toBe("ok");
      expect(checks.find((c) => c.id === "auth")?.status).toBe("ok");
    });

    it("doctor (human) prints status lines", async () => {
      const deps = noLocalServices(makeDeps());
      const code = await run(["doctor", ...urlArgs(deps)], deps);
      expect([0, 1]).toContain(code);
      expect(out(deps)).toMatch(/^\[ok {2}\] config:/m);
    });

    it("doctor --offline does not connect", async () => {
      const deps = noLocalServices(makeDeps());
      const { json } = await runJson(["doctor", "--offline", ...urlArgs(deps)], deps);
      expect(Array.isArray(json.checks)).toBe(true);
      expect(gw.connects).toHaveLength(0);
    });

    it("security audit --json has findings, notChecked and a matching exit code", async () => {
      const deps = noLocalServices(makeDeps());
      const { code, json } = await runJson(["security", "audit", ...urlArgs(deps)], deps);
      expect(code).toBe(json.ok ? 0 : 1);
      expect(Array.isArray(json.findings)).toBe(true);
      const notChecked = json.notChecked as { rule: string; reason: string }[];
      // channels.list and skills.list are not mocked / not registered.
      expect(notChecked.map((n) => n.rule)).toEqual(expect.arrayContaining(["channels", "skills"]));
    });

    it("security audit --fail-at critical exits 0 when nothing critical", async () => {
      const deps = noLocalServices(makeDeps());
      const { code, json } = await runJson(
        ["security", "audit", "--fail-at", "critical", ...urlArgs(deps)],
        deps,
      );
      const findings = json.findings as { severity: string }[];
      expect(code).toBe(findings.some((f) => f.severity === "critical") ? 1 : 0);
    });

    it("security audit --fail-at bogus is a usage error", async () => {
      const deps = noLocalServices(makeDeps());
      expect(await run(["security", "audit", "--fail-at", "bogus", ...urlArgs(deps)], deps)).toBe(
        2,
      );
    });
  });

  describe("identity", () => {
    it("first connection creates device.json 0600 in a 0700 dir and reuses it", async () => {
      const deps = makeDeps();
      expect(await run(["vault", "status", ...urlArgs(deps)], deps)).toBe(0);
      const dir = join(deps.home, "cli");
      const file = join(dir, "device.json");
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      const stored = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;

      expect(await run(["vault", "status", ...urlArgs(deps)], deps)).toBe(0);
      expect(gw.connects).toHaveLength(2);
      const [a, b] = gw.connects;
      expect(a?.deviceId).toBe(stored.deviceId);
      expect(b?.deviceId).toBe(stored.deviceId);
      expect(a?.publicKey).toBe(stored.publicKey);
      expect(b?.publicKey).toBe(stored.publicKey);
    });

    it("connect params identify a linux CLI client and carry no handshake secret", async () => {
      const deps = makeDeps();
      expect(await run(["vault", "status", ...urlArgs(deps)], deps)).toBe(0);
      const params = gw.connects[0] as Record<string, unknown>;
      expect(params.role).toBe("client");
      expect(params.deviceFamily).toBe("cli");
      expect(params.platform).toBe("linux");
      expect(params).not.toHaveProperty("handshakeSecret");
      expect(params.protocolVersion).toEqual({ min: expect.any(Number), max: expect.any(Number) });
    });
  });

  describe("export", () => {
    const exportHandlers = () => {
      Object.assign(gw.handlers, {
        "threads.list": () => ({
          threads: [{ thread: { id: "01JTHREAD00000000000000001", title: "Trip plans" } }],
          nextCursor: null,
        }),
        "chat.export": (params: unknown) => {
          const fmt = (params as { format: string }).format;
          return {
            mime: fmt === "json" ? "application/json" : "text/markdown",
            content: fmt === "json" ? '{"messages":[]}' : "# Trip plans\n",
          };
        },
        "memory.export": () => ({
          filename: "memory.zip",
          mime: "application/zip",
          data: Buffer.from("PK\u0003\u0004fake").toString("base64"),
          bytes: 8,
        }),
        "receipts.list": () => ({ receipts: [{ id: "r1" }], nextCursor: null }),
        "grants.list": () => ({ grants: [{ id: "g1", kind: "exec" }] }),
        "library.list": () => ({ items: [{ id: "l1", path: "a.txt" }], nextCursor: null }),
        "vault.list": () => ({
          credentials: [{ ...CREDENTIAL, secret: { token: SECRET }, value: SECRET }],
        }),
      });
    };

    const seedHome = (deps: TestDeps) => {
      mkdirSync(join(deps.home, "library"), { mode: 0o700 });
      writeFileSync(join(deps.home, "library", "a.txt"), "library file");
      mkdirSync(join(deps.home, "audit"), { mode: 0o700 });
      writeFileSync(join(deps.home, "audit", "2026-10.jsonl"), '{"seq":1}\n');
    };

    const checkFiles = (dir: string) => {
      const threadBase = join(dir, "threads", "01JTHREAD00000000000000001-Trip_plans");
      expect(readFileSync(`${threadBase}.md`, "utf8")).toBe("# Trip plans\n");
      expect(readFileSync(`${threadBase}.json`, "utf8")).toBe('{"messages":[]}');
      expect(
        readFileSync(join(dir, "memory", "memory.zip"))
          .subarray(0, 2)
          .toString(),
      ).toBe("PK");
      expect(JSON.parse(readFileSync(join(dir, "receipts.json"), "utf8"))).toEqual([{ id: "r1" }]);
      expect(JSON.parse(readFileSync(join(dir, "grants.json"), "utf8"))).toHaveLength(1);
      expect(readFileSync(join(dir, "library", "a.txt"), "utf8")).toBe("library file");
      expect(readdirSync(join(dir, "audit"))).toEqual(["2026-10.jsonl"]);
      const refsText = readFileSync(join(dir, "vault-references.json"), "utf8");
      expect(refsText).not.toContain(SECRET);
      const refs = JSON.parse(refsText) as Record<string, unknown>[];
      expect(refs).toHaveLength(1);
      expect(Object.keys(refs[0] ?? {}).sort()).toEqual(["bindings", "id", "kind", "name", "slug"]);
      const manifest = JSON.parse(readFileSync(join(dir, "export.json"), "utf8")) as {
        format: string;
        skipped: { what: string }[];
      };
      expect(manifest.format).toBe("psyche-export");
      expect(manifest.skipped.map((s) => s.what)).toContain("config.json");
    };

    it("export --out writes every file (human)", async () => {
      exportHandlers();
      const deps = makeDeps();
      seedHome(deps);
      const dir = join(tempDir(), "export");
      expect(await run(["export", "--out", dir, ...urlArgs(deps)], deps)).toBe(0);
      expect(out(deps)).toContain("Skipped:");
      expect(out(deps)).toContain("config.json");
      expect(out(deps)).not.toContain(SECRET);
      checkFiles(dir);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    });

    it("export --out --json lists counts and skipped items", async () => {
      exportHandlers();
      const deps = makeDeps();
      seedHome(deps);
      const dir = join(tempDir(), "export");
      const { code, json } = await runJson(["export", "--out", dir, ...urlArgs(deps)], deps);
      expect(code).toBe(0);
      expect(json.out).toBe(dir);
      expect(json.counts).toMatchObject({
        threads: 1,
        receipts: 1,
        grants: 1,
        library: 1,
        libraryFiles: 1,
        vaultReferences: 1,
        auditFiles: 1,
      });
      expect((json.skipped as { what: string }[]).map((s) => s.what)).toEqual(["config.json"]);
      checkFiles(dir);
    });

    it("export lists unavailable data as skipped", async () => {
      const deps = makeDeps();
      const dir = join(tempDir(), "export");
      const { code, json } = await runJson(["export", "--out", dir, ...urlArgs(deps)], deps);
      expect(code).toBe(0);
      const skipped = (json.skipped as { what: string }[]).map((s) => s.what);
      expect(skipped).toEqual(expect.arrayContaining(["memory", "receipts", "grants", "library"]));
    });

    it("export refuses a non-empty --out", async () => {
      const deps = makeDeps();
      const dir = tempDir();
      writeFileSync(join(dir, "x"), "x");
      expect(await run(["export", "--out", dir, ...urlArgs(deps)], deps)).toBe(2);
    });
  });
});

describe("skills", () => {
  const pdf = {
    name: "pdf",
    description: "PDF tools",
    source: "home",
    path: "/h/skills/pdf",
    trust: "verified",
    userInvocable: true,
    disableModelInvocation: false,
    enabled: true,
    hash: "h1",
    status: "active",
    reasons: [],
    findings: [],
    userEnabled: true,
    overrides: [],
    version: "1.0.0",
  };
  const skillHandlers = {
    "skills.list": () => ({ skills: [pdf] }),
    "skills.proposeInstall": (params: unknown) => ({
      proposal: {
        id: "01JPROPOSAL000000000000001",
        name: "pdf",
        source: (params as { source: unknown }).source,
        trust: "local",
        findings: [{ rule: "net", severity: "warn", message: "network call" }],
      },
      approval: { id: "01JAPPROVAL000000000000001" },
    }),
  };

  const skillCases: { name: string; argv: string[]; human: RegExp; key: string }[] = [
    { name: "skills list", argv: ["skills", "list"], human: /pdf\s+1\.0\.0/, key: "skills" },
    {
      name: "skills install",
      argv: ["skills", "install", "./pdf"],
      human: /approval 01JAPPROVAL/,
      key: "approvalId",
    },
    { name: "skills verify", argv: ["skills", "verify"], human: /pdf\s+active/, key: "results" },
  ];

  describe("on a Gateway that answers them", () => {
    beforeEach(async () => {
      await startGateway({
        pair: { phase: "paired", scopes: ALL_SCOPES },
        handlers: skillHandlers,
        validate: false,
      });
    });

    for (const c of skillCases) {
      it(`${c.name} (human)`, async () => {
        const deps = makeDeps();
        expect(await run([...c.argv, ...urlArgs(deps)], deps)).toBe(0);
        expect(out(deps)).toMatch(c.human);
      });
      it(`${c.name} (--json)`, async () => {
        const deps = makeDeps();
        const { code, json } = await runJson([...c.argv, ...urlArgs(deps)], deps);
        expect(code).toBe(0);
        expect(json).toHaveProperty(c.key);
      });
    }

    it("skills install proposes the parsed source", async () => {
      const deps = makeDeps();
      await run(
        ["skills", "install", "https://example.test/skill.git", "--ref", "v1", ...urlArgs(deps)],
        deps,
      );
      expect(lastParams("skills.proposeInstall")).toEqual({
        source: { kind: "git", url: "https://example.test/skill.git", ref: "v1" },
      });
      await run(["skills", "install", "/tmp/s.zip", ...urlArgs(deps)], deps);
      expect(lastParams("skills.proposeInstall")).toEqual({
        source: { kind: "zip", path: "/tmp/s.zip" },
      });
      await run(["skills", "install", "/tmp/skill-dir", ...urlArgs(deps)], deps);
      expect(lastParams("skills.proposeInstall")).toEqual({
        source: { kind: "path", path: "/tmp/skill-dir" },
      });
      // Never installs directly: that needs the owner's approved skill_install.
      expect(gw.calls.some((c) => c.method === "skills.install")).toBe(false);
    });

    it("skills verify exits 1 on a hash mismatch, and on unknown trust with --strict", async () => {
      gw.handlers["skills.list"] = () => ({ skills: [{ ...pdf, status: "hash_mismatch" }] });
      const deps = makeDeps();
      expect(await run(["skills", "verify", ...urlArgs(deps)], deps)).toBe(1);
      gw.handlers["skills.list"] = () => ({ skills: [{ ...pdf, trust: "unknown" }] });
      expect(await run(["skills", "verify", ...urlArgs(deps)], deps)).toBe(0);
      expect(await run(["skills", "verify", "--strict", ...urlArgs(deps)], deps)).toBe(1);
    });
  });

  describe("on a Gateway that does not register them", () => {
    beforeEach(async () => {
      await startGateway({ pair: { phase: "paired", scopes: ALL_SCOPES } });
    });

    for (const c of skillCases) {
      it(`${c.name} → exit 1, error code unavailable`, async () => {
        const deps = makeDeps();
        const { code, json } = await runJson([...c.argv, ...urlArgs(deps)], deps);
        expect(code).toBe(1);
        expect(json).toMatchObject({ ok: false, error: { code: "unavailable" } });
        const h = makeDeps();
        expect(await run([...c.argv, ...urlArgs(h)], h)).toBe(1);
        expect(err(h)).toContain("not available on this Gateway");
      });
    }
  });
});

describe("completion (no Gateway)", () => {
  for (const shell of ["bash", "zsh", "fish"]) {
    it(`completion ${shell} (human)`, async () => {
      const deps = makeDeps();
      expect(await run(["completion", shell], deps)).toBe(0);
      expect(out(deps)).toContain("pairing");
      expect(out(deps)).toContain(shell === "fish" ? "-l json" : "--json");
    });
    it(`completion ${shell} (--json)`, async () => {
      const deps = makeDeps();
      const { code, json } = await runJson(["completion", shell], deps);
      expect(code).toBe(0);
      expect(json.shell).toBe(shell);
      expect(String(json.script)).toContain("pairing");
    });
  }

  it("completion with an unknown shell is a usage error", async () => {
    const deps = makeDeps();
    expect(await run(["completion", "tcsh"], deps)).toBe(2);
  });
});
