// `pnpm app:build | app:install | app:ship` on the platform this runs on: the bash scripts in
// deploy/macos on a Mac, the PowerShell scripts in deploy/windows on Windows.
//
//   node scripts/dev/app.mjs build [args]     sh deploy/macos/build-local.sh | deploy/windows/build-local.ps1
//   node scripts/dev/app.mjs install [args]   sh deploy/macos/install-local.sh | deploy/windows/install-local.ps1
//   node scripts/dev/app.mjs ship [args]      build, then install (args go to install)
//
// The macOS flags work on Windows too: --arch x64 → -Arch x64, --keep-data → -KeepData,
// --reset → -Reset, --yes / -y → -Yes,
// --no-launch → -NoLaunch, --dry-run → -DryRun, --skip-helper → -SkipHelper, --smoke → -Smoke.
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");

const PS_FLAGS = {
  "--arch": "-Arch",
  "--keep-data": "-KeepData",
  "--reset": "-Reset",
  "--yes": "-Yes",
  "-y": "-Yes",
  "--no-launch": "-NoLaunch",
  "--dry-run": "-DryRun",
  "--skip-helper": "-SkipHelper",
  "--smoke": "-Smoke",
  "--no-installer": "-NoInstaller",
};

/** macOS-style flags to the PowerShell scripts' parameters; anything else passes through. */
export function toPowerShellArgs(args) {
  return args.flatMap((a) => {
    const [flag, value] = a.split(/=(.*)/s, 2);
    const ps = PS_FLAGS[flag];
    if (!ps) return [a];
    return value === undefined ? [ps] : [ps, value];
  });
}

/** The command for `step` on `platform`: [program, args]. */
export function commandFor(step, args, platform = process.platform, shell = "powershell.exe") {
  if (platform === "darwin") {
    return ["sh", [join(ROOT, "deploy", "macos", `${step}-local.sh`), ...args]];
  }
  if (platform === "win32") {
    return [
      shell,
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(ROOT, "deploy", "windows", `${step}-local.ps1`),
        ...toPowerShellArgs(args),
      ],
    ];
  }
  throw new Error(
    `pnpm app:${step} builds the desktop app on macOS or Windows (this is ${platform}); a server runs the Gateway with Docker (deploy/README.md)`,
  );
}

/** PowerShell 7 when it is installed, else the Windows PowerShell every Windows has. */
function powershell() {
  return spawnSync("pwsh.exe", ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore" }).status ===
    0
    ? "pwsh.exe"
    : "powershell.exe";
}

function run(step, args) {
  const [cmd, argv] = commandFor(
    step,
    args,
    process.platform,
    process.platform === "win32" ? powershell() : undefined,
  );
  const r = spawnSync(cmd, argv, { stdio: "inherit", cwd: ROOT });
  if (r.error) throw r.error;
  return r.status ?? 1;
}

function main(argv) {
  const [step, ...args] = argv;
  if (step === "build" || step === "install") return run(step, args);
  if (step === "ship") {
    const built = run("build", []);
    return built === 0 ? run("install", args) : built;
  }
  process.stderr.write("usage: node scripts/dev/app.mjs build|install|ship [args]\n");
  return 64;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`app: ${err.message}\n`);
    process.exitCode = 1;
  }
}
