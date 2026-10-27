import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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

describe("deploy/sandbox-image/publish.sh split build (native per-arch runners, then merge)", () => {
  const script = () => resolve(deploy, "sandbox-image/publish.sh");
  const run = (...args: string[]) => spawnSync("bash", [script(), ...args], { encoding: "utf8" });

  it.skipIf(!has("jq"))("--platform builds one platform by digest: no tag, no signature", () => {
    const before = read("sandbox-image/versions.json");
    const r = run(
      "--dry-run",
      "--version",
      "1.2.3",
      "--platform",
      "linux/arm64",
      "--digests-dir",
      "/tmp/d",
      "core",
      "full",
    );
    expect(r.status, r.stderr).toBe(0);
    const out = `${r.stdout}${r.stderr}`;
    expect(out.match(/\+ docker buildx build --platform linux\/arm64 /g)).toHaveLength(2);
    expect(out).toContain("push-by-digest=true");
    expect(out).toContain("/tmp/d/core/linux-arm64");
    expect(out).not.toContain("--tag");
    expect(out).not.toContain("cosign sign");
    expect(read("sandbox-image/versions.json")).toBe(before);
  });

  it.skipIf(!has("jq"))("--merge joins every platform per variant, then signs and records", () => {
    const r = run("--dry-run", "--version", "1.2.3", "--merge", "/tmp/d", "core", "base", "full");
    expect(r.status, r.stderr).toBe(0);
    const out = `${r.stdout}${r.stderr}`;
    const creates = out.match(/\+ docker buildx imagetools create --tag \S+ .*/g) ?? [];
    expect(creates).toHaveLength(3);
    for (const c of creates) expect(c.match(/@sha256:/g)).toHaveLength(2);
    expect(out).toContain("ghcr.io/devmello/psyche-sandbox:1.2.3-core");
    expect(out.match(/\+ cosign sign --yes/g)).toHaveLength(3);
    expect(out).not.toContain("docker buildx build");
  });

  it.skipIf(!has("jq"))("refuses an unknown platform and a platform without a digests dir", () => {
    expect(run("--dry-run", "--platform", "linux/s390x", "--digests-dir", "/tmp/d").status).toBe(2);
    expect(run("--dry-run", "--platform", "linux/arm64").status).toBe(2);
    expect(
      run("--dry-run", "--platform", "linux/arm64", "--digests-dir", "/tmp/d", "--merge", "/tmp/d")
        .status,
    ).toBe(2);
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
        writeFileSync(
          join(bundle, "runtime", "node"),
          '#!/bin/sh\nfor a; do case $a in *.mjs) printf "%s\\n" "$a" ;; esac; done\n',
          {
            mode: 0o755,
          },
        );
        writeFileSync(join(bundle, "psyche"), PSYCHE_LAUNCHER, { mode: 0o755 });
        writeFileSync(join(bundle, "psyched"), PSYCHED_LAUNCHER, { mode: 0o755 });
        const bin = join(dir, "bin");
        mkdirSync(bin);
        symlinkSync(join(bundle, "psyche"), join(bin, "psyche"));
        symlinkSync("../Psyche.app/Contents/Resources/psyched/psyched", join(bin, "psyched"));
        symlinkSync(join(bin, "psyche"), join(bin, "psyche2"));
        const runIt = (p: string) => execFileSync(p, [], { encoding: "utf8" }).trim();
        expect(runIt(join(bin, "psyche"))).toBe(join(bundle, "app/apps/cli/dist/main.mjs"));
        expect(runIt(join(bin, "psyche2"))).toBe(join(bundle, "app/apps/cli/dist/main.mjs"));
        expect(runIt(join(bin, "psyched"))).toBe(
          // Not normalized: the launcher keeps the relative link's `..`.
          `${bin}/../Psyche.app/Contents/Resources/psyched/app/apps/gateway/dist/main.mjs`,
        );
        expect(runIt(join(bundle, "psyched"))).toBe(join(bundle, "app/apps/gateway/dist/main.mjs"));
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

describe("deploy/scripts/build-psyched.mjs foreign prebuilds", () => {
  it("keeps only darwin-<arch> addons, including onnxruntime-node's napi-v6 tree", async () => {
    const { pruneForeignPrebuilds } = await import(resolve(deploy, "scripts/build-psyched.mjs"));
    const dir = mkdtempSync(join(tmpdir(), "psyche-prune-"));
    try {
      const ort = join(dir, "node_modules/onnxruntime-node/bin/napi-v6");
      for (const p of ["darwin/arm64", "darwin/x64", "linux/x64", "win32/x64"])
        mkdirSync(join(ort, p), { recursive: true });
      const pre = join(dir, "node_modules/better-sqlite3/prebuilds");
      for (const p of ["darwin-arm64", "linux-x64"]) mkdirSync(join(pre, p), { recursive: true });
      expect(pruneForeignPrebuilds(dir, "arm64")).toBe(4);
      expect(readdirSync(ort)).toEqual(["darwin"]);
      expect(readdirSync(join(ort, "darwin"))).toEqual(["arm64"]);
      expect(readdirSync(pre)).toEqual(["darwin-arm64"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("deploy/scripts/prune-package-waste.mjs (app size, phase 1)", () => {
  /** A pnpm store with the packages the Gateway ships, each with files it does and does not load. */
  function fixture(): string {
    const app = mkdtempSync(join(tmpdir(), "psyche-waste-"));
    const put = (rel: string, text = "x") => {
      mkdirSync(dirname(join(app, rel)), { recursive: true });
      writeFileSync(join(app, rel), text);
    };
    const pkg = (id: string, name: string) => `node_modules/.pnpm/${id}/node_modules/${name}`;
    const sqlite = pkg("better-sqlite3@13.0.3", "better-sqlite3");
    for (const f of [
      "lib/index.js",
      "prebuilds/darwin-arm64.node",
      "package.json",
      "LICENSE",
      "deps/sqlite3/sqlite3.c",
      "src/better_sqlite3.cpp",
      "build/Release/obj.target/x.o",
      "binding.gyp",
      "README.md",
    ])
      put(`${sqlite}/${f}`);
    const pdf = pkg("pdfjs-dist@6.4.299", "pdfjs-dist");
    for (const f of [
      "legacy/build/pdf.mjs",
      "legacy/build/pdf.worker.mjs",
      "legacy/build/pdf.min.mjs",
      "legacy/build/pdf.mjs.map",
      "legacy/web/viewer.mjs",
      "build/pdf.mjs",
      "web/viewer.html",
      "image_decoders/pdf.image_decoders.mjs",
      "cmaps/Adobe-Japan1-0.bcmap",
      "standard_fonts/FoxitSans.pfb",
      "wasm/openjpeg.wasm",
      "LICENSE",
    ])
      put(`${pdf}/${f}`);
    const pw = pkg("playwright-core@1.64.1", "playwright-core");
    for (const f of ["lib/coreBundle.js", "lib/vite/traceViewer/index.html", "index.js"])
      put(`${pw}/${f}`);
    // A scoped package with tests, docs, declarations and a licence next to its code.
    const ai = pkg("@ai-sdk+gateway@4.0.0", "@ai-sdk/gateway");
    for (const f of [
      "dist/index.mjs",
      "dist/index.d.ts",
      "dist/index.mjs.map",
      "test/a.test.js",
      "docs/guide.md",
      "CHANGELOG.md",
      "LICENSE.md",
      ".eslintrc.json",
      "package.json",
    ])
      put(`${ai}/${f}`);
    // Workspace sources: tests and changelogs go, the code stays.
    for (const f of [
      "packages/db/src/index.ts",
      "packages/db/src/index.test.ts",
      "packages/db/test/a.test.ts",
      "packages/db/migrations/0001.sql",
      "packages/db/vitest.config.ts",
      "packages/db/CHANGELOG.md",
    ])
      put(f);
    // onnxruntime ships its dylib twice, as two copies instead of a link.
    const ort = `${pkg("onnxruntime-node@1.30.0", "onnxruntime-node")}/bin/napi-v6/darwin/arm64`;
    put(`${ort}/libonnxruntime.1.30.0.dylib`, "dylib-bytes");
    put(`${ort}/libonnxruntime.1.dylib`, "dylib-bytes");
    put(`${ort}/onnxruntime_binding.node`, "binding");
    return app;
  }
  const all = (dir: string, base = dir): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() && !e.isSymbolicLink()
        ? all(join(dir, e.name), base)
        : [join(dir, e.name).slice(base.length + 1)],
    );

  it("cuts sources, docs, tests and unused builds, and keeps what the Gateway loads", async () => {
    const { prunePackageWaste } = await import(resolve(deploy, "scripts/prune-package-waste.mjs"));
    const app = fixture();
    try {
      const r = prunePackageWaste(app);
      expect(r.installed).toBeGreaterThan(0);
      const left = all(app).sort();
      const pnpm = "node_modules/.pnpm";
      expect(left.filter((f) => f.includes("better-sqlite3"))).toEqual([
        `${pnpm}/better-sqlite3@13.0.3/node_modules/better-sqlite3/LICENSE`,
        `${pnpm}/better-sqlite3@13.0.3/node_modules/better-sqlite3/lib/index.js`,
        `${pnpm}/better-sqlite3@13.0.3/node_modules/better-sqlite3/package.json`,
        `${pnpm}/better-sqlite3@13.0.3/node_modules/better-sqlite3/prebuilds/darwin-arm64.node`,
      ]);
      const pdf = `${pnpm}/pdfjs-dist@6.4.299/node_modules/pdfjs-dist`;
      expect(left.filter((f) => f.startsWith(pdf))).toEqual([
        `${pdf}/LICENSE`,
        `${pdf}/cmaps/Adobe-Japan1-0.bcmap`,
        `${pdf}/legacy/build/pdf.mjs`,
        `${pdf}/legacy/build/pdf.worker.mjs`,
        `${pdf}/standard_fonts/FoxitSans.pfb`,
        `${pdf}/wasm/openjpeg.wasm`,
      ]);
      const pw = `${pnpm}/playwright-core@1.64.1/node_modules/playwright-core`;
      expect(left.filter((f) => f.startsWith(pw))).toEqual([
        `${pw}/index.js`,
        `${pw}/lib/coreBundle.js`,
      ]);
      const ai = `${pnpm}/@ai-sdk+gateway@4.0.0/node_modules/@ai-sdk/gateway`;
      expect(left.filter((f) => f.startsWith(ai))).toEqual([
        `${ai}/LICENSE.md`,
        `${ai}/dist/index.mjs`,
        `${ai}/package.json`,
      ]);
      expect(left.filter((f) => f.startsWith("packages/"))).toEqual([
        "packages/db/migrations/0001.sql",
        "packages/db/src/index.ts",
      ]);
    } finally {
      rmSync(app, { recursive: true, force: true });
    }
  });

  it("links onnxruntime's second copy of its dylib to the first instead of shipping both", async () => {
    const { prunePackageWaste } = await import(resolve(deploy, "scripts/prune-package-waste.mjs"));
    const app = fixture();
    try {
      const r = prunePackageWaste(app);
      expect(r.dupes).toBe("dylib-bytes".length);
      const dir = join(
        app,
        "node_modules/.pnpm/onnxruntime-node@1.30.0/node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64",
      );
      expect(lstatSync(join(dir, "libonnxruntime.1.dylib")).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(dir, "libonnxruntime.1.dylib"), "utf8")).toBe("dylib-bytes");
      expect(lstatSync(join(dir, "libonnxruntime.1.30.0.dylib")).isSymbolicLink()).toBe(false);
    } finally {
      rmSync(app, { recursive: true, force: true });
    }
  });
});

describe("deploy/scripts/bundle-gateway.mjs (app size, esbuild bundle)", () => {
  /** A miniature exported tree in pnpm's layout: workspace packages, a bundled dep, an external one, assets. */
  function tree(): string {
    const app = mkdtempSync(join(tmpdir(), "psyche-bundle-"));
    const put = (rel: string, text = "x") => {
      mkdirSync(dirname(join(app, rel)), { recursive: true });
      writeFileSync(join(app, rel), text);
    };
    const link = (from: string, to: string) => {
      mkdirSync(dirname(join(app, from)), { recursive: true });
      symlinkSync(to, join(app, from));
    };
    put("package.json", "{}");
    put("README.md");
    put(
      "apps/gateway/src/main.ts",
      `import { greet } from "@psyche/lib";
import native from "native-thing";
import pure from "pure-js";
process.stdout.write(JSON.stringify({ greet: greet("x"), native: native(), pure: pure(), url: Boolean(globalThis.__PSYCHE_BUNDLE_URL__) }));
`,
    );
    put("apps/gateway/package.json", "{}");
    put("apps/cli/src/main.ts", `console.log("cli");`);
    put(
      "packages/lib/package.json",
      '{"name":"@psyche/lib","type":"module","exports":{".":"./src/index.ts"}}',
    );
    put("packages/lib/src/index.ts", `export const greet = (n: string): string => "hello " + n;`);
    put("packages/lib/test/a.test.ts");
    put("packages/db/migrations/0001.sql", "create table t (a);");
    put("packages/files/src/extract/worker.ts", `console.log("worker");`);
    put("skills/a/SKILL.md", "---\nname: a\n---");
    put("templates/T.md");
    put("apps/web/dist/index.html", "<html>");
    put("apps/web/src/main.tsx");
    put("deploy/sandbox-image/Dockerfile", "FROM scratch");
    put("deploy/other/x.sh");
    put("packages/model-router/src/cli/mcp-stdio-bridge.mjs");
    put("packages/model-router/src/cli/other.ts");
    const store = "node_modules/.pnpm";
    put(`${store}/pure-js@1.0.0/node_modules/pure-js/index.js`, "module.exports = () => 'pure';");
    put(
      `${store}/pure-js@1.0.0/node_modules/pure-js/package.json`,
      '{"name":"pure-js","main":"index.js"}',
    );
    put(
      `${store}/native-thing@1.0.0/node_modules/native-thing/index.js`,
      "module.exports = () => 'native';",
    );
    put(
      `${store}/native-thing@1.0.0/node_modules/native-thing/package.json`,
      '{"name":"native-thing","main":"index.js"}',
    );
    put(`${store}/native-dep@1.0.0/node_modules/native-dep/index.js`);
    put(`${store}/unused@1.0.0/node_modules/unused/index.js`);
    link(
      `${store}/native-thing@1.0.0/node_modules/native-dep`,
      "../../native-dep@1.0.0/node_modules/native-dep",
    );
    link(
      "apps/gateway/node_modules/pure-js",
      "../../../node_modules/.pnpm/pure-js@1.0.0/node_modules/pure-js",
    );
    link(
      "apps/gateway/node_modules/native-thing",
      "../../../node_modules/.pnpm/native-thing@1.0.0/node_modules/native-thing",
    );
    link("apps/gateway/node_modules/@psyche/lib", "../../../../packages/lib");
    // pnpm's hoisted store links the workspace packages too; they dangle once the sources go.
    link(`${store}/node_modules/@psyche/lib`, "../../../../packages/lib");
    return app;
  }
  const all = (dir: string, base = dir): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() && !e.isSymbolicLink()
        ? all(join(dir, e.name), base)
        : [join(dir, e.name).slice(base.length + 1)],
    );

  it("bundles the entries with the workspace and pure dependencies inside, and an external outside", async () => {
    const { bundleGateway } = await import(resolve(deploy, "scripts/bundle-gateway.mjs"));
    const app = tree();
    try {
      const sizes = await bundleGateway(app, {
        root: resolve(deploy, ".."),
        entries: {
          "apps/gateway/dist/main": "apps/gateway/src/main.ts",
          "apps/gateway/dist/extract-worker": "packages/files/src/extract/worker.ts",
          "apps/cli/dist/main": "apps/cli/src/main.ts",
        },
        external: ["native-thing"],
      });
      // Shared code may land in chunk-<hash>.mjs files next to the entries (code splitting).
      expect(
        Object.keys(sizes)
          .filter((f) => !/\/chunk-[^/]+\.mjs$/.test(f))
          .sort(),
      ).toEqual([
        "apps/cli/dist/main.mjs",
        "apps/gateway/dist/extract-worker.mjs",
        "apps/gateway/dist/main.mjs",
      ]);
      for (const f of Object.keys(sizes)) expect(f.startsWith("apps/")).toBe(true);
      const main = readFileSync(join(app, "apps/gateway/dist/main.mjs"), "utf8");
      expect(main).toContain("hello "); // the workspace package is inside
      expect(main).toMatch(/["']pure["']/); // so is the pure dependency
      expect(main).not.toMatch(/["']native["']/);
      expect(main).toContain("native-thing"); // still an import, resolved from node_modules at run time
      expect(main.startsWith("globalThis.__PSYCHE_BUNDLE_URL__")).toBe(true);
    } finally {
      rmSync(app, { recursive: true, force: true });
    }
  });

  it("drops the sources but keeps assets and the external package with its dependencies", async () => {
    const { bundleGateway, discardSources } = await import(
      resolve(deploy, "scripts/bundle-gateway.mjs")
    );
    const app = tree();
    try {
      await bundleGateway(app, {
        root: resolve(deploy, ".."),
        entries: { "apps/gateway/dist/main": "apps/gateway/src/main.ts" },
        external: ["native-thing"],
      });
      const r = discardSources(app, { external: ["native-thing"] });
      expect(r.external).toEqual(["native-thing"]);
      expect(all(app).sort()).toEqual([
        "apps/gateway/dist/main.mjs",
        "apps/web/dist/index.html",
        "deploy/sandbox-image/Dockerfile",
        "node_modules/.pnpm/native-dep@1.0.0/node_modules/native-dep/index.js",
        "node_modules/.pnpm/native-thing@1.0.0/node_modules/native-dep", // pnpm's link to its dependency
        "node_modules/.pnpm/native-thing@1.0.0/node_modules/native-thing/index.js",
        "node_modules/.pnpm/native-thing@1.0.0/node_modules/native-thing/package.json",
        "node_modules/native-thing", // the link the bundles resolve it through
        "packages/db/migrations/0001.sql",
        "packages/model-router/src/cli/mcp-stdio-bridge.mjs",
        "skills/a/SKILL.md",
        "templates/T.md",
      ]);
      expect(lstatSync(join(app, "node_modules/native-thing")).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(app, "node_modules/native-thing/index.js"), "utf8")).toContain(
        "native",
      );
      expect(existsSync(join(app, "node_modules/.pnpm/unused@1.0.0"))).toBe(false);
      // codesign cannot seal a link to nothing: none may be left.
      expect(existsSync(join(app, "node_modules/.pnpm/node_modules/@psyche/lib"))).toBe(false);
      const links = execFileSync("find", [app, "-type", "l"], { encoding: "utf8" })
        .split("\n")
        .filter(Boolean);
      expect(links.filter((l) => !existsSync(l))).toEqual([]);
      // The bundle still runs from its place in the tree: externals resolve, the bundle announces itself.
      const out = execFileSync(process.execPath, [join(app, "apps/gateway/dist/main.mjs")], {
        encoding: "utf8",
      });
      expect(JSON.parse(out)).toEqual({
        greet: "hello x",
        native: "native",
        pure: "pure",
        url: true,
      });
    } finally {
      rmSync(app, { recursive: true, force: true });
    }
  });
});

describe("deploy/scripts/size-budget.mjs", () => {
  it("passes under the limit, fails over it, and can be skipped", async () => {
    const { checkBudget } = await import(resolve(deploy, "scripts/size-budget.mjs"));
    const limits = { psychedMB: 100 };
    expect(checkBudget("psychedMB", 99.5, limits)).toContain("99.5 MiB of 100 MiB");
    expect(() => checkBudget("psychedMB", 100.5, limits)).toThrow(/over the budget/);
    expect(() => checkBudget("appMB", 1, limits)).toThrow(/no "appMB"/);
    process.env.PSYCHE_SIZE_BUDGET = "skip";
    try {
      expect(checkBudget("psychedMB", 500, limits)).toContain("skipped");
    } finally {
      delete process.env.PSYCHE_SIZE_BUDGET;
    }
  });

  it("holds every kind to a number in deploy/size-budget.json", () => {
    const b = JSON.parse(read("size-budget.json")) as Record<string, number>;
    for (const k of ["psychedMB", "appMB", "dmgMB"]) expect(b[k], k).toBeGreaterThan(0);
  });
});

describe("deploy/scripts/build-psyched.mjs bundled skills (#506)", () => {
  function app(skills: Record<string, string | null>): string {
    const dir = mkdtempSync(join(tmpdir(), "psyche-skills-"));
    mkdirSync(join(dir, "apps/gateway/src/compose"), { recursive: true });
    for (const [name, md] of Object.entries(skills)) {
      mkdirSync(join(dir, "skills", name), { recursive: true });
      if (md !== null) writeFileSync(join(dir, "skills", name, "SKILL.md"), md);
    }
    return dir;
  }
  const md = (name: string) => `---\nname: ${name}\ndescription: x\n---\n`;

  it("lists the shipped skills and fails when the folder or a SKILL.md is missing", async () => {
    const { checkShippedSkills } = await import(resolve(deploy, "scripts/build-psyched.mjs"));
    const ok = app({ "weekly-review": md("weekly-review"), browsing: md("browsing") });
    const empty = app({});
    const noMd = app({ browsing: null });
    const wrong = app({ browsing: md("other") });
    try {
      expect(checkShippedSkills(ok)).toEqual(["browsing", "weekly-review"]);
      expect(() => checkShippedSkills(empty)).toThrow(/bundled skills folder missing/);
      expect(() => checkShippedSkills(noMd)).toThrow(/browsing has no SKILL\.md/);
      expect(() => checkShippedSkills(wrong)).toThrow(/SKILL\.md names "other"/);
    } finally {
      for (const d of [ok, empty, noMd, wrong]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("the repository's own skills pass", async () => {
    const { checkShippedSkills } = await import(resolve(deploy, "scripts/build-psyched.mjs"));
    expect(checkShippedSkills(resolve(deploy, "..")).length).toBeGreaterThanOrEqual(12);
  });
});

describe("deploy/scripts/build-psyched.mjs server subset", () => {
  /** A tiny pnpm layout: the Gateway, viewers (UI deps), ui, web, and a .pnpm store. */
  function layout(): string {
    const app = mkdtempSync(join(tmpdir(), "psyche-prune-"));
    const file = (p: string, text = "") => {
      mkdirSync(dirname(join(app, p)), { recursive: true });
      writeFileSync(join(app, p), text);
    };
    const link = (target: string, at: string) => {
      mkdirSync(dirname(join(app, at)), { recursive: true });
      symlinkSync(target, join(app, at));
    };
    const pkg = (dir: string, name: string, deps: Record<string, string> = {}) =>
      file(`${dir}/package.json`, JSON.stringify({ name, dependencies: deps }));
    pkg("apps/gateway", "@psyche/gateway", {
      "@psyche/viewers": "workspace:*",
      ws: "1",
      pdfjs: "1",
    });
    file(
      "apps/gateway/src/main.ts",
      'import { WebSocket } from "ws";\nimport type { X } from "react";\nimport { mimeFromName } from "@psyche/viewers/core/detect";\nconst p = () => import("pdfjs");\n',
    );
    pkg("apps/cli", "@psyche/cli");
    pkg("apps/web", "@psyche/web");
    file("apps/web/dist/index.html", "<!doctype html>");
    pkg("packages/viewers", "@psyche/viewers", { "@psyche/protocol": "workspace:*", react: "1" });
    for (const f of ["convert", "detect", "registry"]) file(`packages/viewers/src/core/${f}.ts`);
    file("packages/viewers/src/react/Sheet.tsx", 'import React from "react";\n');
    pkg("packages/protocol", "@psyche/protocol");
    file("packages/protocol/src/index.ts");
    pkg("packages/ui", "@psyche/ui", { react: "1" });
    const store = "node_modules/.pnpm";
    for (const id of [
      "ws@1/node_modules/ws",
      "dep-a@1/node_modules/dep-a",
      "react@1/node_modules/react",
      "pdfjs@1/node_modules/pdfjs",
      "@napi-rs+canvas@1/node_modules/@napi-rs/canvas",
    ])
      file(`${store}/${id}/package.json`, "{}");
    file(`${store}/ws@1/node_modules/ws/index.js.map`, "{}");
    file(`${store}/ws@1/node_modules/ws/index.d.ts`, "");
    link("../../dep-a@1/node_modules/dep-a", `${store}/ws@1/node_modules/dep-a`);
    link(
      "../../../@napi-rs+canvas@1/node_modules/@napi-rs/canvas",
      `${store}/pdfjs@1/node_modules/@napi-rs/canvas`,
    );
    link("../../../node_modules/.pnpm/ws@1/node_modules/ws", "apps/gateway/node_modules/ws");
    link(
      "../../../node_modules/.pnpm/pdfjs@1/node_modules/pdfjs",
      "apps/gateway/node_modules/pdfjs",
    );
    link("../../../../packages/viewers", "apps/gateway/node_modules/@psyche/viewers");
    link(
      "../../../node_modules/.pnpm/react@1/node_modules/react",
      "packages/viewers/node_modules/react",
    );
    link("../../../protocol", "packages/viewers/node_modules/@psyche/protocol");
    link(
      "../../../node_modules/.pnpm/react@1/node_modules/react",
      "packages/ui/node_modules/react",
    );
    link("../../../node_modules/.pnpm/react@1/node_modules/react", "apps/web/node_modules/react");
    return app;
  }

  it("keeps what the Gateway can load and drops the viewer UI, ui, canvas, maps and declarations", async () => {
    const { pruneToServerSubset, checkImports } = await import(
      resolve(deploy, "scripts/build-psyched.mjs")
    );
    const app = layout();
    try {
      const stats = pruneToServerSubset(app);
      const store = join(app, "node_modules/.pnpm");
      expect(existsSync(join(store, "ws@1"))).toBe(true);
      expect(existsSync(join(store, "dep-a@1"))).toBe(true);
      expect(existsSync(join(store, "pdfjs@1"))).toBe(true);
      expect(existsSync(join(store, "react@1"))).toBe(false);
      expect(existsSync(join(store, "@napi-rs+canvas@1"))).toBe(false);
      expect(existsSync(join(store, "pdfjs@1/node_modules/@napi-rs"))).toBe(false);
      expect(existsSync(join(store, "ws@1/node_modules/ws/index.js.map"))).toBe(false);
      expect(existsSync(join(store, "ws@1/node_modules/ws/index.d.ts"))).toBe(false);
      expect(existsSync(join(app, "packages/ui"))).toBe(false);
      expect(existsSync(join(app, "apps/web/dist/index.html"))).toBe(true);
      expect(existsSync(join(app, "packages/viewers/src/core/detect.ts"))).toBe(true);
      expect(existsSync(join(app, "packages/viewers/src/react/Sheet.tsx"))).toBe(false);
      expect(existsSync(join(app, "packages/viewers/node_modules/react"))).toBe(false);
      expect(stats).toMatchObject({ workspaces: 1, packages: 2, files: 2 });
      expect(existsSync(join(app, "apps/web/node_modules"))).toBe(false);
      // `import type` needs nothing at runtime; the lazy import("pdfjs") does.
      expect(checkImports(app)).toEqual([]);
      rmSync(join(app, "apps/gateway/node_modules/pdfjs"));
      expect(checkImports(app)).toEqual(["apps/gateway/src/main.ts: pdfjs"]);
    } finally {
      rmSync(app, { recursive: true, force: true });
    }
  });
});

describe("deploy/scripts/release-notes.mjs", () => {
  it("leads with the curated notes for the tag's minor version, without dependency bumps", () => {
    const root = mkdtempSync(join(tmpdir(), "psyche-notes-"));
    try {
      mkdirSync(join(root, "docs/release-notes"), { recursive: true });
      writeFileSync(
        join(root, "docs/release-notes/0.3.md"),
        "# Psyche v0.3.0-alpha.0\n\nCurated.\n",
      );
      for (const [name, body] of [
        [
          "gateway",
          "### Minor Changes\n\n- abc123: A feature.\n\n### Patch Changes\n\n- Updated dependencies [abc123]\n  - @psyche/protocol@0.3.0-alpha.0\n",
        ],
        [
          "web",
          "### Patch Changes\n\n- Updated dependencies [abc123]\n  - @psyche/protocol@0.3.0-alpha.0\n",
        ],
      ] as const) {
        mkdirSync(join(root, "apps", name), { recursive: true });
        writeFileSync(
          join(root, "apps", name, "package.json"),
          JSON.stringify({ name: `@psyche/${name}` }),
        );
        writeFileSync(
          join(root, "apps", name, "CHANGELOG.md"),
          `# @psyche/${name}\n\n## 0.3.0-alpha.0\n\n${body}\n## 0.2.0\n\n- old\n`,
        );
      }
      const run = (tag: string) =>
        execFileSync(process.execPath, [resolve(deploy, "scripts/release-notes.mjs"), root, tag], {
          encoding: "utf8",
        });
      const notes = run("v0.3.0-alpha.0");
      expect(notes.startsWith("# Psyche v0.3.0-alpha.0\n\nCurated.")).toBe(true);
      expect(notes).toContain("<details><summary>Changes by package</summary>");
      expect(notes).toContain("### @psyche/gateway 0.3.0-alpha.0");
      expect(notes).toContain("- abc123: A feature.");
      expect(notes).not.toContain("Updated dependencies");
      expect(notes).not.toContain("@psyche/protocol@");
      expect(notes).not.toContain("### Patch Changes");
      // A package whose section held only dependency bumps drops out.
      expect(notes).not.toContain("### @psyche/web");
      expect(notes).not.toContain("- old");
      // No curated file: the plain heading.
      expect(run("v0.4.0").startsWith("# Psyche v0.4.0\n")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
