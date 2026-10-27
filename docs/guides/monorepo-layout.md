# Monorepo layout and disk use

Psyche is one repository for every platform: the TypeScript Gateway, web app, desktop app and CLI today, and a Windows helper, an iOS app and an Android app later. This page says where each platform lives, how the toolchains stay optional, how CI decides what to run, and how checkouts stay small when many sessions each have their own git worktree.

## Where each platform lives

| Platform | Folder | Toolchain | Status |
| --- | --- | --- | --- |
| Gateway, web, desktop, CLI, node, docs site | `apps/gateway`, `apps/web`, `apps/desktop`, `apps/cli`, `apps/node`, `apps/site` | Node 24 and pnpm | exists |
| TypeScript libraries | `packages/*` | Node 24 and pnpm | exists |
| Mac helper (Swift) | `apps/mac-helper` | Xcode or the Swift toolchain | exists |
| Swift code shared by the Mac helper and iOS | `packages/swift` (one SwiftPM package) | Swift | planned |
| Windows helper (C#/.NET) | `apps/windows-helper` | .NET SDK | planned |
| iOS app (SwiftUI) | `apps/ios` | Xcode | planned |
| Android app (Kotlin) | `apps/android` | Android SDK and Gradle | planned |

The native folders do not exist yet. Create each one in the PR that adds the app, and add its paths to the three places that name them: `scripts/dev/sparse.sh`, the `changes` job in `.github/workflows/ci.yml`, and `.github/CODEOWNERS`.

## Native toolchains are opt-in

`pnpm install` and every TypeScript script must work on a machine with no Xcode, no .NET SDK and no Android SDK, and on Linux CI. Rules that keep this true:

- The native apps are not pnpm workspace packages. `pnpm-workspace.yaml` lists `apps/*`, but pnpm only picks up folders that contain a `package.json`, so a native folder without one is invisible to it. Do not add a `package.json` to a native app just to run scripts; call `swift`, `dotnet` or `gradlew` directly (or from a script under `scripts/dev`).
- No root script (`build`, `typecheck`, `test`, `lint`) may call a native toolchain. Native builds run from their own folder or from their own CI job.
- Never add a dependency from a TypeScript package on native build output. Clients talk to the Gateway over the protocol, not through files.

## Check out only what you work on

`scripts/dev/sparse.sh` turns on `git sparse-checkout` (cone mode) for the current worktree:

```sh
pnpm sparse core      # TypeScript apps and packages, docs, tests, deploy, CI
pnpm sparse mac       # core + apps/mac-helper + packages/swift
pnpm sparse windows   # core + apps/windows-helper
pnpm sparse mobile    # core + apps/ios + apps/android + packages/swift
pnpm sparse all       # everything again
```

Sparse checkout is per worktree, so each session picks its own profile. Files in the repo root are always present. Every profile keeps `apps/mac-helper/Sources/PsycheProtocol`, because `pnpm protocol:gen` writes the Swift structs there; without it the generator would scatter files outside the checkout. Directories that do not exist yet are accepted and match nothing.

## Protocol codegen is the contract between clients

`packages/protocol` is the single definition of the Gateway protocol. `pnpm protocol:gen` turns it into the TypeScript declarations in `packages/protocol/generated` and the Swift `Codable` structs in `apps/mac-helper/Sources/PsycheProtocol`; `pnpm protocol:check` fails when the committed output is stale, and CI runs it. Every new client follows the same rule:

1. The client's models are generated, never hand-written: C# records into `apps/windows-helper/**/Protocol` (quicktype supports C#), Kotlin data classes into `apps/android/**/protocol`, and for iOS the same Swift structs through `packages/swift`.
2. The generated folder is committed, marked as generated in its header, and listed in `.github/CODEOWNERS` as changed only through `protocol:` PRs.
3. A protocol change reruns every CI job whose platform consumes it (below), so an enum case added in TypeScript cannot silently break a client's `switch`.

## CI runs only the platforms a change touches

The `changes` job in `.github/workflows/ci.yml` diffs the pull request (or push) against its base and publishes one output per platform. A platform job declares `needs: changes` and `if: needs.changes.outputs.<platform> == 'true'`.

| Output | True when the change touches | Job |
| --- | --- | --- |
| `ts` | anything except native app folders | `ci` (typecheck, lint, tests, protocol freshness) |
| `helper` | `packages/protocol/`, `packages/swift/`, `apps/mac-helper/` | `helper` (Swift build and test on macOS) |
| `windows` | `packages/protocol/`, `apps/windows-helper/` | to add with the app |
| `ios` | `packages/protocol/`, `packages/swift/`, `apps/ios/` | to add with the app |
| `android` | `packages/protocol/`, `apps/android/` | to add with the app |

A manual run, a tag, a new branch and any change to `ci.yml` itself run everything. The generated Swift protocol files count as TypeScript changes, so their freshness check still runs. A new platform job looks like this:

```yaml
  windows:
    name: windows helper (dotnet build + test)
    needs: changes
    if: needs.changes.outputs.windows == 'true'
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@<pinned sha>
      - uses: actions/setup-dotnet@<pinned sha>
      - run: dotnet test apps/windows-helper
```

Workflows that only run on a schedule, on tags or on demand (`desktop`, `security`, `release`) need no path filter; `docs` already has one.

## Disk: why checkouts stay small

A worktree reports about 2.6 GB with `du`, nearly all of it `node_modules`. Almost none of that is real disk on macOS: pnpm imports packages from its global store (`~/Library/pnpm/store/v11`) as APFS clones, which share blocks with the store. `du` counts shared blocks once per file, so it overstates. What a new worktree really costs, measured with `df` before and after (not `du`):

| Step | Real disk written |
| --- | --- |
| `pnpm install` in a new worktree | about 35 MB (`node_modules` symlinks and metadata, node-pty's native build restored from the store) |
| Electron's `dist`, extracted the first time anything launches Electron | 308 MB, without sharing |
| Electron's `dist`, cloned from the shared copy by the root `postinstall` | about 0 MB |

So the per-worktree cost drops from about 343 MB to about 35 MB, plus whatever build outputs a session produces.

Settings that make this work (all in `pnpm-workspace.yaml`; pnpm 12 reads its settings there, not from `.npmrc`):

- `packageImportMethod: clone-or-copy` keeps cloning and never falls back to hardlinks, so a worktree cannot change a file in the store.
- `sideEffectsCache: true` stores allowBuilds results once in the store.
- The store stays global. Do not set `store-dir` per repository.

Electron 44 has no install script, so pnpm's side-effects cache cannot hold its `dist`. `scripts/dev/electron-dist.sh` keeps one extracted copy per Electron version in `~/Library/Caches/psyche/electron-dist` and clones it into each worktree from the root `postinstall`. Run `pnpm electron:prime` once per Electron version to create the shared copy; after that every `pnpm install` in a new worktree clones it. CI skips all of this (`ELECTRON_SKIP_BINARY_DOWNLOAD`).

### Shared caches

| Cache | Location | Notes |
| --- | --- | --- |
| pnpm store | `~/Library/pnpm/store/v11` | global; the source of the clones |
| Turbo | `~/Library/Caches/psyche/turbo` | set by `scripts/dev/turbo.sh`, which the root `build`, `dev` and `typecheck` scripts run; capped at 5 GB by `PSYCHE_TURBO_CACHE_MAX_MB`; `pnpm cache:prune` prunes by age and size |
| Electron download | `~/Library/Caches/electron` | global by default |
| Playwright browsers | `~/Library/Caches/ms-playwright` | global by default; `PLAYWRIGHT_BROWSERS_PATH` is not set anywhere in the repo and must not be |
| Vite and Storybook | `node_modules/.vite`, `node_modules/.cache` | inside `node_modules`, so never committed and removed with it |

Set `PSYCHE_CACHE_DIR` to move everything under `~/Library/Caches/psyche`. These native defaults are already global and must stay that way, so a second worktree does not rebuild them:

- **Xcode `DerivedData`** (`~/Library/Developer/Xcode/DerivedData`): do not pass `-derivedDataPath` inside the repo. Xcode keys each project by its path, so worktrees do not collide.
- **SwiftPM** (`~/Library/Caches/org.swift.swiftpm`, `~/Library/org.swift.swiftpm`): downloaded packages are shared. `swift build --package-path apps/mac-helper` writes `.build` per worktree; `pnpm clean` removes it.
- **Gradle** (`~/.gradle`): do not set `GRADLE_USER_HOME` per repository. When `apps/android` lands, its `gradle.properties` sets `org.gradle.caching=true` (and so does the developer's `~/.gradle/gradle.properties`), so identical tasks are restored from the shared build cache instead of rerun.
- **NuGet** (`~/.nuget/packages`): do not set `RestorePackagesPath`. `bin` and `obj` are per worktree build output and are cleaned.

### Commands

```sh
pnpm clean              # remove build outputs in this checkout (never source or node_modules)
pnpm disk:report        # real disk use: shared stores and caches, and each worktree's unique share
pnpm worktrees:prune    # dry run: finished worktrees that could go; add --yes to remove them
pnpm cache:prune        # prune the shared Turbo cache now
```

`pnpm disk:report` estimates what each worktree really owns (source, build outputs and an Electron `dist` that is not a clone) and prints the shared stores next to it. For ground truth, compare the volume's `Used` column around an operation:

```sh
df -k /System/Volumes/Data   # note "Used", run the operation, run it again, subtract
```

`pnpm worktrees:prune` only considers `.claude/worktrees/*`. It removes a worktree when its branch is merged into `origin/main` (or `gh` reports its pull request as merged with the same commit), it has no uncommitted or untracked files, no process is using it, and its git index was not touched recently. Without `--yes` it only prints the plan. Branches are kept.
