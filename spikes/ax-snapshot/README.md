# axsnap: Accessibility-tree snapshot spike (spike-04)

A throwaway Swift tool that snapshots an app's focused window as one line per element. It can also act on elements by ref. The findings are in [`docs/spikes/spike-04-ax-snapshot.md`](../../docs/spikes/spike-04-ax-snapshot.md). Do not build on this code; `apps/mac-helper` (S14) owns the real thing.

## Build and grant

```sh
./build.sh            # signs with your first "Apple Development" identity, else ad-hoc
.build/axrun prompt   # shows the Accessibility prompt for AXSnap.app; enable it in System Settings
.build/axrun doctor   # AXIsProcessTrusted / CGPreflight* status
```

`build.sh` produces two binaries:

- `.build/AXSnap.app`, with bundle id `com.psyche.spike.axsnap`. This is the TCC identity.
- `.build/axrun`, a launcher that spawns the app binary with TCC responsibility disclaimed. Without it, a process started from a shell is checked against the shell's responsible process: the terminal, or the Claude Code CLI under Claude.app's `disclaimer`. That process has no Accessibility grant.

With a real certificate the grant survives rebuilds. With an ad-hoc signature it does not (`tccutil reset Accessibility com.psyche.spike.axsnap` clears it).

## Use

```sh
.build/axrun apps
.build/axrun snap Notes                       # text format; --json for JSON
.build/axrun snap Safari --no-prune --no-clip # raw-ish, for comparison
.build/axrun bench Finder 10                  # warm timings + ref reuse
.build/axrun script <<'EOF'                   # refs persist for the life of one process
snap Notes
press "?button=New Note"
sleep 700
snap Notes
set ?focused "Title\nBody"
EOF
```

A ref is one of:

- `eN` from a snapshot in the same process.
- `?focused`.
- A selector `?role=label-substring`, which must match exactly one node.

Commands:

- AX actions: `press`, `confirm`, `cancel`, `raise`, `showmenu`, `scrollto`, `pick`, `inc`, `dec`, `custom <ref> <name>`.
- Attribute writes: `focus`, `select`, `set` (AXValue, read back with backoff), `insert` (AXSelectedText).
- Reads: `get`, `value`.
- Menus: `menu <app> "File>Rename"`.
- CGEvent fallbacks: `click`, `clickxy`, `type`, `key cmd+n` (optionally `--pid`), `scroll`.
- App control: `activate`, and `appattr <app> AXManualAccessibility true`.

`electron-form/` is a minimal Electron page used for the Electron test. Run it with any Electron binary: `<Electron.app>/Contents/MacOS/Electron electron-form`.

The spike deliberately has no socket or daemon mode. A local listener that lets any process drive the UI through a TCC-granted binary is a confused deputy (see the write-up).
