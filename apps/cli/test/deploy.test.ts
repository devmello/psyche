import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderLaunchAgentPlist, renderSystemdUnit } from "../src/supervisor.ts";

/** The files in deploy/ are the CLI's renderers' output, and each one validates. */

const deploy = resolve(import.meta.dirname, "../../../deploy");
const read = (p: string) => readFileSync(resolve(deploy, p), "utf8");
const has = (cmd: string) => spawnSync("/bin/sh", ["-c", `command -v ${cmd}`]).status === 0;

describe("deploy/launchd/com.psyche.gateway.plist", () => {
  it("is what `psyche start` writes for the example paths", () => {
    expect(read("launchd/com.psyche.gateway.plist")).toBe(
      renderLaunchAgentPlist({
        program: "/usr/local/bin/psyched",
        psycheHome: "/Users/you/.psyche",
      }),
    );
  });

  it.skipIf(!existsSync("/usr/bin/plutil"))("passes plutil -lint", () => {
    expect(() =>
      execFileSync("/usr/bin/plutil", [
        "-lint",
        resolve(deploy, "launchd/com.psyche.gateway.plist"),
      ]),
    ).not.toThrow();
  });
});

describe("deploy/systemd/psyche-gateway.service", () => {
  it("is what `psyche start` writes for the example paths", () => {
    expect(read("systemd/psyche-gateway.service")).toBe(
      renderSystemdUnit({ program: "/usr/local/bin/psyched", psycheHome: "/home/you/.psyche" }),
    );
  });

  it.skipIf(!has("systemd-analyze"))("passes systemd-analyze verify", () => {
    const r = spawnSync(
      "systemd-analyze",
      ["--user", "verify", resolve(deploy, "systemd/psyche-gateway.service")],
      {
        encoding: "utf8",
      },
    );
    // The example ExecStart path does not exist on the runner; every other complaint is a failure.
    const problems = r.stderr
      .split("\n")
      .filter((l) => l.trim() && !/is not executable|No such file|Command .* not found/.test(l));
    expect(problems).toEqual([]);
  });
});

describe("deploy/Dockerfile", () => {
  const dockerfile = read("Dockerfile");

  it("runs as a non-root user with a /healthz healthcheck on Node 24", () => {
    expect(dockerfile).toMatch(/^USER 10001:10001$/m);
    expect(dockerfile).toMatch(/^HEALTHCHECK .*\n.*\/healthz/m);
    expect(dockerfile).toMatch(/node:24\.\d+\.\d+-bookworm-slim@sha256:[0-9a-f]{64}/);
    expect(dockerfile).not.toMatch(/EXPOSE/);
  });
});

describe("deploy/docker-compose.yml", () => {
  const compose = read("docker-compose.yml");

  it("keeps the Gateway on loopback with no published ports", () => {
    // No PSYCHE_HOST: the Gateway's default is loopback and env would override config.json.
    expect(compose).not.toMatch(/PSYCHE_(HOST|PORT|ALLOWED_ORIGINS):/);
    expect(compose).not.toMatch(/^\s+ports:/m);
    expect(compose).toMatch(/psyche-home:\/data/);
    // The Docker socket mount stays commented out (documented as a risk).
    expect(compose).not.toMatch(/^\s+- \/var\/run\/docker\.sock/m);
  });

  it.skipIf(!has("docker"))("is valid for every profile", () => {
    for (const args of [
      [],
      ["--profile", "tailscale", "--profile", "cloudflare", "--profile", "browser"],
    ]) {
      const r = spawnSync(
        "docker",
        ["compose", "-f", resolve(deploy, "docker-compose.yml"), ...args, "config", "-q"],
        {
          encoding: "utf8",
        },
      );
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
    }
  });
});

describe("deploy/backup", () => {
  it.each(["backup.sh", "restore.sh", "verify.sh"])("%s is valid sh", (name) => {
    const r = spawnSync("/bin/sh", ["-n", resolve(deploy, "backup", name)], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });
});

describe("deploy/sandbox-image/publish.sh --dry-run (what the release job runs before a tag)", () => {
  it.skipIf(!has("jq"))(
    "prints build, push and sign for every variant and leaves versions.json alone",
    () => {
      const script = resolve(deploy, "sandbox-image/publish.sh");
      const before = read("sandbox-image/versions.json");
      const r = spawnSync(
        "bash",
        [script, "--dry-run", "--version", "1.2.3", "core", "base", "full"],
        {
          encoding: "utf8",
        },
      );
      expect(r.status, r.stderr).toBe(0);
      const out = `${r.stdout}${r.stderr}`;
      for (const tag of ["1.2.3-core", "1.2.3", "1.2.3-full"]) {
        expect(out).toContain(`ghcr.io/devmello/psyche-sandbox:${tag}`);
      }
      expect(out.match(/\+ cosign sign --yes/g)).toHaveLength(3);
      expect(out).toContain("--provenance=mode=max");
      expect(read("sandbox-image/versions.json")).toBe(before);
      expect(
        spawnSync("bash", [script, "--dry-run", "--version", "1.2"], { encoding: "utf8" }).status,
      ).toBe(2);
    },
  );
});

describe("deploy/scripts/render-compose.mjs (the release's pinned Compose file, #296)", () => {
  const script = resolve(deploy, "scripts/render-compose.mjs");
  const digest = `sha256:${"a".repeat(64)}`;
  const ref = `ghcr.io/devmello/psyche-gateway:1.2.3@${digest}`;

  it("never defaults to an unpinned latest in the repository file", () => {
    expect(read("docker-compose.yml")).not.toMatch(/psyche-gateway:latest/);
    expect(read("docker-compose.yml")).toMatch(/image: \$\{PSYCHE_IMAGE:-psyche-gateway:local\}/);
  });

  it("defaults the gateway to the release image by digest and drops its build block", () => {
    const r = spawnSync(process.execPath, [script, resolve(deploy, "docker-compose.yml"), ref], {
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`image: \${PSYCHE_IMAGE:-${ref}}`);
    // The gateway's build block (which needs a checkout) is gone; the browser sidecar keeps its own.
    expect(r.stdout).not.toContain("dockerfile: deploy/Dockerfile");
    expect(r.stdout.match(/^\s+build:/gm)).toHaveLength(1);
    expect(r.stdout).not.toContain("psyche-gateway:local");
  });

  it("refuses a reference that is not pinned by digest", () => {
    const r = spawnSync(
      process.execPath,
      [script, resolve(deploy, "docker-compose.yml"), "ghcr.io/x/y:latest"],
      {
        encoding: "utf8",
      },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("pinned by digest");
  });
});

describe("Compose sidecars (#298)", () => {
  const compose = read("docker-compose.yml");
  const block = (name: string) => {
    const start = compose.indexOf(`\n  ${name}:\n`);
    const end = compose.indexOf("\n\n", start + 1);
    return compose.slice(start, end === -1 ? undefined : end);
  };

  it("bakes the browser sidecar from a pinned base and a committed lockfile; nothing fetched at start", () => {
    expect(compose).not.toMatch(/npx/);
    expect(block("browser")).toMatch(/build:\s*\n\s+context: \.\/browser/);
    const dockerfile = read("browser/Dockerfile");
    const base = /FROM mcr\.microsoft\.com\/playwright:v([\d.]+)-noble@sha256:[0-9a-f]{64}/.exec(
      dockerfile,
    );
    expect(base).not.toBeNull();
    expect(dockerfile).toContain("npm ci");
    const lock = JSON.parse(read("browser/package-lock.json")) as {
      packages: Record<string, { version?: string; integrity?: string }>;
    };
    const pw = lock.packages["node_modules/playwright"];
    expect(pw?.version).toBe(base?.[1]);
    expect(pw?.integrity).toMatch(/^sha512-/);
    expect(lock.packages["node_modules/playwright-core"]?.integrity).toMatch(/^sha512-/);
  });

  it("runs Tailscale without capabilities, read-only, with no-new-privileges", () => {
    const ts = block("tailscale");
    expect(ts).toMatch(/cap_drop: \[ALL\]/);
    expect(ts).toMatch(/read_only: true/);
    expect(ts).toMatch(/no-new-privileges:true/);
    expect(ts).toMatch(/tailscale\/tailscale:v[\d.]+@sha256:[0-9a-f]{64}/);
  });

  it("the release render accepts the local browser build and nothing else unpinned", () => {
    const r = spawnSync(
      process.execPath,
      [
        resolve(deploy, "scripts/render-compose.mjs"),
        resolve(deploy, "docker-compose.yml"),
        `ghcr.io/devmello/psyche-gateway:1.0.0@sha256:${"b".repeat(64)}`,
      ],
      { encoding: "utf8" },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("psyche-browser:local");
    expect(r.stdout).toMatch(/context: \.\/browser/);
  });
});

describe("deploy/scripts/node-pins.mjs (#295)", () => {
  const script = resolve(deploy, "scripts/node-pins.mjs");

  it("every Node pin in the repository is an exact, digest-pinned version, and they agree", () => {
    const r = spawnSync(process.execPath, [script, "check"], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/deploy\/Dockerfile: node:24\.\d+\.\d+-bookworm-slim@sha256:/);
    expect(r.stdout).toMatch(
      /deploy\/sandbox-image\/Dockerfile: node:24\.\d+\.\d+-trixie-slim@sha256:/,
    );
  });

  it("finds floating and disagreeing pins, and rewrites every variant to one version", async () => {
    const { checkPins, findPins, repin } = (await import(script)) as {
      checkPins: (b: Record<string, unknown[]>) => { problems: string[] };
      findPins: (t: string) => { version: string; variant: string }[];
      repin: (t: string, v: string, d: (tag: string) => Promise<string>) => Promise<string>;
    };
    const d = (c: string) => c.repeat(64);
    const text = `FROM node:24-bookworm@sha256:${d("a")}\nARG X=node:24.22.0-trixie-slim@sha256:${d("b")}\n`;
    expect(findPins(text).map((p) => `${p.version}-${p.variant}`)).toEqual([
      "24-bookworm",
      "24.22.0-trixie-slim",
    ]);
    expect(checkPins({ f: findPins(text) }).problems).toEqual([
      "f: node:24-bookworm is not an exact version",
      "pins disagree: 24, 24.22.0",
    ]);
    const out = await repin(text, "24.22.1", async (tag) =>
      tag.endsWith("trixie-slim") ? d("d") : d("c"),
    );
    expect(out).toBe(
      `FROM node:24.22.1-bookworm@sha256:${d("c")}\nARG X=node:24.22.1-trixie-slim@sha256:${d("d")}\n`,
    );
    expect(checkPins({ f: findPins(out) }).problems).toEqual([]);
  });
});

describe("deploy/scripts/release-preflight.mjs (before a tag)", () => {
  const script = resolve(deploy, "scripts/release-preflight.mjs");
  const repo = resolve(deploy, "..");

  it("passes on the repository, with the 24 h dependency cool-down present", () => {
    const r = spawnSync(process.execPath, [script], { encoding: "utf8" });
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/^ok\s+cooldown: minimumReleaseAge \d+ minutes$/m);
    expect(r.stdout).toMatch(/^ok\s+node-pins:/m);
    expect(r.stdout).toMatch(/^ok\s+compose:/m);
  });

  it("fails without the cool-down, or with a shorter one", () => {
    for (const ws of [
      "packages:\n  - apps/*\n",
      "packages:\n  - apps/*\nminimumReleaseAge: 60\n",
    ]) {
      const root = mkdtempSync(join(tmpdir(), "psyche-preflight-"));
      try {
        for (const f of [
          "deploy/Dockerfile",
          "deploy/docker-compose.yml",
          "deploy/update-policy.json",
          "deploy/sandbox-image/Dockerfile",
          "deploy/sandbox-image/versions.json",
          "tests/integration/server-mode/Dockerfile",
          "apps/desktop/src/main/release-keys.ts",
        ]) {
          mkdirSync(dirname(join(root, f)), { recursive: true });
          writeFileSync(join(root, f), readFileSync(join(repo, f)));
        }
        writeFileSync(join(root, "pnpm-workspace.yaml"), ws);
        const r = spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" });
        expect(r.status).toBe(1);
        expect(r.stdout).toMatch(/^fail\s+cooldown:/m);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});

describe("deploy/macos/make-dmg.sh (no Developer ID)", () => {
  // Builds and mounts a disk image, so it runs only when asked (PSYCHE_DMG_TEST=1, macOS).
  it
    .skipIf(process.platform !== "darwin" || !has("hdiutil") || process.env.PSYCHE_DMG_TEST !== "1")
    .each([
      { presigned: false, identifier: "dev.psyche.test" },
      // The package step's inside-out signature is kept, not replaced by a --deep one.
      { presigned: true, identifier: "dev.psyche.kept" },
    ])(
    "presigned=$presigned: ad-hoc signed app, Applications link and checksum",
    ({ presigned, identifier }) => {
      const dir = mkdtempSync(join(tmpdir(), "psyche-dmg-"));
      try {
        // A stub app: one Mach-O executable and its Info.plist.
        const app = join(dir, "Psyche.app");
        mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
        execFileSync("/bin/cp", ["/usr/bin/true", join(app, "Contents", "MacOS", "Psyche")]);
        writeFileSync(
          join(app, "Contents", "Info.plist"),
          `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Psyche</string>
<key>CFBundleIdentifier</key><string>dev.psyche.test</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`,
        );
        if (presigned) {
          execFileSync("/usr/bin/codesign", [
            "--force",
            "--sign",
            "-",
            "--identifier",
            identifier,
            app,
          ]);
        }
        const out = join(dir, "out");
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          PSYCHE_DMG_BACKGROUND: join(dir, "none.png"),
          PSYCHE_DMG_LAYOUT: "0",
        };
        delete env.PSYCHE_SIGN_IDENTITY;
        // No Finder layout, so the test scripts no app and opens no windows.
        const dmg = execFileSync(
          "/bin/bash",
          [resolve(deploy, "macos/make-dmg.sh"), app, "1.2.3", "arm64", out],
          { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        )
          .trim()
          .split("\n")
          .at(-1);
        expect(dmg).toBe(join(out, "Psyche-1.2.3-arm64.dmg"));
        const sum = execFileSync("/usr/bin/shasum", ["-a", "256", "Psyche-1.2.3-arm64.dmg"], {
          cwd: out,
          encoding: "utf8",
        });
        expect(readFileSync(join(out, "Psyche-1.2.3-arm64.dmg.sha256"), "utf8")).toBe(sum);

        const mnt = join(dir, "mnt");
        mkdirSync(mnt);
        execFileSync("/usr/bin/hdiutil", [
          "attach",
          "-readonly",
          "-nobrowse",
          "-noautoopen",
          "-mountpoint",
          mnt,
          dmg as string,
        ]);
        try {
          expect(existsSync(join(mnt, "Applications"))).toBe(true);
          const info = spawnSync(
            "/usr/bin/codesign",
            ["-dv", "--verbose=2", join(mnt, "Psyche.app")],
            { encoding: "utf8" },
          );
          expect(info.status).toBe(0);
          expect(info.stderr).toContain("Signature=adhoc");
          expect(info.stderr).toContain(`Identifier=${identifier}`);
          expect(
            spawnSync("/usr/bin/codesign", [
              "--verify",
              "--deep",
              "--strict",
              join(mnt, "Psyche.app"),
            ]).status,
          ).toBe(0);
        } finally {
          execFileSync("/usr/bin/hdiutil", ["detach", mnt, "-quiet"]);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});

describe("deploy/scripts/build-psyched.mjs launchers", () => {
  it.skipIf(process.platform === "win32")(
    "find the bundle through absolute and relative symlinks (`/usr/local/bin/psyche`)",
    async () => {
      const { PSYCHE_LAUNCHER, PSYCHED_LAUNCHER } = await import(
        resolve(deploy, "scripts/build-psyched.mjs")
      );
      const dir = mkdtempSync(join(tmpdir(), "psyche-launch-"));
      try {
        const bundle = join(dir, "Psyche.app", "Contents", "Resources", "psyched");
        mkdirSync(join(bundle, "runtime"), { recursive: true });
        // A stand-in runtime that prints the entry point it was given.
        writeFileSync(join(bundle, "runtime", "node"), '#!/bin/sh\nprintf "%s\\n" "$2"\n', {
          mode: 0o755,
        });
        writeFileSync(join(bundle, "psyche"), PSYCHE_LAUNCHER, { mode: 0o755 });
        writeFileSync(join(bundle, "psyched"), PSYCHED_LAUNCHER, { mode: 0o755 });
        const bin = join(dir, "bin");
        mkdirSync(bin);
        symlinkSync(join(bundle, "psyche"), join(bin, "psyche"));
        symlinkSync("../Psyche.app/Contents/Resources/psyched/psyched", join(bin, "psyched"));
        symlinkSync(join(bin, "psyche"), join(bin, "psyche2"));
        const runIt = (p: string) => execFileSync(p, [], { encoding: "utf8" }).trim();
        expect(runIt(join(bin, "psyche"))).toBe(join(bundle, "app/apps/cli/src/main.ts"));
        expect(runIt(join(bin, "psyche2"))).toBe(join(bundle, "app/apps/cli/src/main.ts"));
        expect(runIt(join(bin, "psyched"))).toBe(
          // Not normalized: the launcher keeps the relative link's `..`.
          `${bin}/../Psyche.app/Contents/Resources/psyched/app/apps/gateway/src/main.ts`,
        );
        expect(runIt(join(bundle, "psyched"))).toBe(join(bundle, "app/apps/gateway/src/main.ts"));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("deploy/macos/make-dmg.sh refuses to --deep re-sign a bundled helper", () => {
  it.skipIf(process.platform !== "darwin" || !has("codesign"))(
    "an unsigned app with PsycheHelper.app fails before any image is built",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "psyche-dmg-helper-"));
      try {
        const app = join(dir, "Psyche.app");
        mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
        mkdirSync(join(app, "Contents", "Resources", "PsycheHelper.app", "Contents"), {
          recursive: true,
        });
        execFileSync("/bin/cp", ["/usr/bin/true", join(app, "Contents", "MacOS", "Psyche")]);
        const env: NodeJS.ProcessEnv = { ...process.env, PSYCHE_DMG_LAYOUT: "0" };
        delete env.PSYCHE_SIGN_IDENTITY;
        const out = join(dir, "out");
        const r = spawnSync(
          "/bin/sh",
          [resolve(deploy, "macos/make-dmg.sh"), app, "1.2.3", "arm64", out],
          { env, encoding: "utf8" },
        );
        expect(r.status).toBe(1);
        expect(r.stderr).toContain("bundles PsycheHelper.app");
        expect(existsSync(join(out, "Psyche-1.2.3-arm64.dmg"))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
