import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * INT-2 server mode (topology C): the temporary Compose file until S22's deploy/ merges.
 * CI validates it statically; `docker compose up` runs only with PSYCHE_LIVE_TESTS=1 and docker.
 */

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, "compose.yaml"), "utf8");
const serveRaw = readFileSync(join(here, "serve.json"), "utf8");

interface Service {
  image?: string;
  build?: { context: string; dockerfile: string };
  network_mode?: string;
  ports?: unknown[];
  expose?: unknown[];
  environment?: Record<string, string>;
  env_file?: { path: string; required: boolean }[];
  secrets?: string[];
  volumes?: string[];
  read_only?: boolean;
  cap_drop?: string[];
  security_opt?: string[];
  profiles?: string[];
  healthcheck?: { test: string[] };
}
interface ComposeFile {
  name: string;
  services: Record<string, Service>;
  secrets: Record<string, { file?: string; environment?: string }>;
  volumes: Record<string, unknown>;
}

const compose = parse(raw, { merge: true }) as ComposeFile;
const gateway = compose.services.gateway as Service;
const tailscale = compose.services.tailscale as Service;

describe("server-mode compose.yaml (static)", () => {
  it("runs psyched on the host's loopback with nothing published", () => {
    expect(gateway.network_mode).toBe("host");
    for (const svc of Object.values(compose.services)) {
      expect(svc.ports).toBeUndefined();
      expect(svc.expose).toBeUndefined();
    }
    // No bind override: the Gateway's default is 127.0.0.1:7979 and it refuses anything else.
    expect(gateway.environment?.PSYCHE_HOST).toBeUndefined();
    expect(gateway.environment?.PSYCHE_PORT).toBeUndefined();
    expect(gateway.healthcheck?.test.join(" ")).toContain("http://127.0.0.1:7979/healthz");
    expect(gateway.build?.dockerfile).toBe("tests/integration/server-mode/Dockerfile");
    expect(existsSync(join(here, "Dockerfile"))).toBe(true);
    expect(readFileSync(join(here, "Dockerfile.dockerignore"), "utf8")).toContain(
      "tests/integration/server-mode/secrets",
    );
  });

  it("keeps $PSYCHE_HOME on a named volume and hardens the container", () => {
    expect(gateway.environment?.PSYCHE_HOME).toBe("/data");
    expect(gateway.volumes).toContain("psyche-home:/data");
    expect(compose.volumes).toHaveProperty("psyche-home");
    expect(gateway.read_only).toBe(true);
    expect(gateway.cap_drop).toEqual(["ALL"]);
    expect(gateway.security_opt).toContain("no-new-privileges:true");
  });

  it("passes the Telegram token as a Compose secret file, never inline", () => {
    expect(gateway.secrets).toEqual(["telegram_bot_token"]);
    expect(compose.secrets.telegram_bot_token).toEqual({ file: "./secrets/telegram_bot_token" });
    expect(gateway.environment?.PSYCHE_TELEGRAM_BOT_TOKEN_FILE).toBe(
      "/run/secrets/telegram_bot_token",
    );
    expect(gateway.environment).not.toHaveProperty("PSYCHE_TELEGRAM_BOT_TOKEN");
    expect(gateway.env_file).toEqual([{ path: ".env", required: false }]);
    expect(readFileSync(join(here, ".gitignore"), "utf8").split("\n")).toEqual(
      expect.arrayContaining([".env", "secrets/"]),
    );
  });

  it("fronts the Gateway with a pinned Tailscale Serve sidecar: https 443 → 127.0.0.1:7979", () => {
    expect(tailscale.image).toMatch(/^tailscale\/tailscale:v[\d.]+@sha256:[0-9a-f]{64}$/);
    expect(tailscale.profiles).toEqual(["tailscale"]);
    expect(tailscale.network_mode).toBe("host");
    expect(tailscale.environment).toMatchObject({
      TS_SERVE_CONFIG: "/config/serve.json",
      TS_AUTHKEY: `\${TS_AUTHKEY:-}`,
      TS_USERSPACE: "true",
    });
    expect(tailscale.volumes).toContain("./serve.json:/config/serve.json:ro");
    const serve = JSON.parse(serveRaw) as {
      TCP: Record<string, { HTTPS: boolean }>;
      Web: Record<string, { Handlers: Record<string, { Proxy: string }> }>;
      AllowFunnel: Record<string, boolean>;
    };
    expect(serve.TCP["443"]).toEqual({ HTTPS: true });
    expect(serve.Web[`\${TS_CERT_DOMAIN}:443`]?.Handlers["/"]).toEqual({
      Proxy: "http://127.0.0.1:7979",
    });
    expect(Object.values(serve.AllowFunnel)).toEqual([false]);
  });

  it("contains no secrets", () => {
    for (const text of [raw, serveRaw]) {
      expect(text).not.toMatch(/tskey-[a-z]+-[A-Za-z0-9]/);
      expect(text).not.toMatch(/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/); // Telegram bot token shape
      expect(text).not.toMatch(/sk-[A-Za-z0-9-]{20,}/);
    }
  });
});

const live = process.env.PSYCHE_LIVE_TESTS === "1";
const docker =
  live && spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;

describe.skipIf(!docker)("server-mode compose up (live: PSYCHE_LIVE_TESTS=1 and docker)", () => {
  const run = (...args: string[]) =>
    execFileSync("docker", ["compose", "-f", join(here, "compose.yaml"), ...args], {
      cwd: here,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

  it(
    "builds, starts and answers /healthz on the host loopback",
    async () => {
      const secret = join(here, "secrets", "telegram_bot_token");
      if (!existsSync(secret)) {
        mkdirSync(dirname(secret), { recursive: true });
        writeFileSync(secret, "", { mode: 0o600 }); // empty: Telegram off
      }
      run("config", "--quiet");
      try {
        run("up", "-d", "--build", "gateway");
        let ok = false;
        for (let i = 0; i < 60 && !ok; i++) {
          ok = await fetch("http://127.0.0.1:7979/healthz").then(
            (r) => r.ok,
            () => false,
          );
          if (!ok) await new Promise((r) => setTimeout(r, 2000));
        }
        expect(ok).toBe(true);
      } finally {
        run("down", "--volumes");
      }
    },
    15 * 60_000,
  );
});
