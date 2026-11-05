# Linux test results

Fill this in during the real-machine test run in [the Linux desktop design, section 13](../design/linux-desktop-2026.md). One copy of the machine block and the step table per machine. Mark each step PASS, FAIL (with a note or an issue link) or SKIP (with the reason). Leave a cell empty if the step was not reached.

Before starting, tell the owner: a desktop VM uses 4 to 6 GB of RAM while it runs, so other sessions pause first. Shut the VM down afterwards.

- Build under test: `<version> (<build>)`, from CI run `<link>`
- Date:
- Tester:

## Machines

| # | Distro and session | Package | VM or hardware | Done |
| --- | --- | --- | --- | --- |
| T1 | Ubuntu 24.04 LTS, GNOME, Wayland | deb | 4 GB, 4 vCPU, 40 GB | |
| T2 | Fedora 43 KDE Plasma 6, Wayland | rpm | 4 GB, 4 vCPU, 40 GB | |
| T3 | Ubuntu 24.04, "Ubuntu on Xorg" session (same VM as T1) | deb | same as T1 | |
| T4 | Fedora 43 Workstation (GNOME, no tray) or Debian 13 with sway (optional) | rpm or deb | 4 GB | |

## Versions per machine

Copy this table for each machine. Get the values with the commands in the last column.

| Item | T1 | T2 | T3 | T4 | How |
| --- | --- | --- | --- | --- | --- |
| Distro and release | | | | | `. /etc/os-release; echo $PRETTY_NAME` |
| Kernel | | | | | `uname -r` |
| Architecture | | | | | `uname -m` |
| Session type | | | | | `echo $XDG_SESSION_TYPE` |
| Desktop and version | | | | | `echo $XDG_CURRENT_DESKTOP`; `gnome-shell --version` or `plasmashell --version` |
| xdg-desktop-portal | | | | | `busctl --user get-property org.freedesktop.portal.Desktop /org/freedesktop/portal/desktop org.freedesktop.portal.ScreenCast version`; package version with `dpkg -l xdg-desktop-portal` or `rpm -q xdg-desktop-portal` |
| Portal backend (gnome, kde, wlr, gtk) | | | | | `ls /usr/share/xdg-desktop-portal/portals/` |
| polkit | | | | | `pkaction --version` |
| Authentication agent | | | | | the process that shows the password dialog (`ps -e \| grep -i polkit`) |
| AT-SPI | | | | | `dpkg -l at-spi2-core` or `rpm -q at-spi2-core` |
| systemd | | | | | `systemctl --version \| head -1` |
| AppArmor userns restriction (Ubuntu) | | | | | `sysctl kernel.apparmor_restrict_unprivileged_userns` |
| Podman (T1, step 6) | | | | | `podman --version` |

## Step results

Copy this table for each machine. The step numbers are the ones in section 13.

| Step | What | T1 | T2 | T3 | T4 | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Install the package; polkit policy, systemd unit and AppArmor profile are in place; the app opens from the launcher; `psyche-gateway` is active and the window connects | | | | | |
| 1a | Idle RSS recorded (see the RAM table) | | | | | |
| 2 | AppImage on a fresh user: the Ubuntu sandbox message appears; `--setup-system` (one admin prompt) fixes it; the unit's `ExecStart` names the AppImage | n/a | n/a | | n/a | T1 only |
| 3a | Password presence: the dialog shows the translated Psyche message; wrong password is rejected and counted; right password approves once; audit entry `approval.password_from_window` | | | | | |
| 3b | Asking again right away prompts again (no caching) | | | | | |
| 3c | Screen locked, approve from the phone: refused with `presence_unavailable_here` | | | | | |
| 3d | Over SSH, `psyche approvals ...`: same refusal | | | | | |
| 3e | A test polkit rule returning YES: Settings shows `not_enforced` and approvals refuse (rule removed afterwards) | | | | | |
| 3f | KDE's agent shows the same flow | n/a | | n/a | n/a | T2 only |
| 3g | The X11 session shows the X11 warning in Settings | n/a | n/a | | n/a | T3 only |
| 4a | Direct computer use: `org.a11y.Status.IsEnabled` is true; Text Editor, LibreOffice and Firefox open | | | | | |
| 4b | Type a paragraph into Text Editor and save to `~/Documents/test.txt`; the portal dialog appears once | | | | | |
| 4c | After restarting the helper and the VM: no dialog (restore token). Survived reboot? | | | | | Record GNOME and KDE separately |
| 4d | Stop sharing from the top-bar indicator mid-task: the run cancels | | | | | |
| 4e | A password field in Firefox is redacted in the snapshot | | | | | |
| 4f | Refs with "no position" noted (GNOME) | | | | | List them |
| 5a | Virtual screen: a Writer task runs while typing in another app; nothing on the real display; the watch pane shows Writer; Take over works | | | | | |
| 5b | Text Editor open on the real screen, asked for on the virtual screen: `already_open_on_your_screen` | | | | | |
| 5c | Unsaved changes at the end of a task: the card appears | | | | | |
| 5d | RSS recorded; everything is gone 10 minutes after the task | | | | | |
| 6 | Separate desktop (T1 only, `sudo apt install podman` first): no `~` visible; read-only share rejects a write; one allowed origin works and another fails; `podman ps` empty after | n/a | n/a | n/a | n/a | T1 only; record image size and start time |
| 7a | Update from N-1 to N: AppImage self-replace | | | | | |
| 7b | Update from N-1 to N: deb or rpm with one admin prompt | | | | | |
| 7c | A failed launch and "Go back" restore the previous version | | | | | |
| 8a | Tray works (T1, T2) or is absent as expected (T4: closing the window quits the desktop, the Gateway stays) | | | | | |
| 8b | `Ctrl+Alt+Space` opens the pop-up after the desktop's consent dialog | | | | | |
| 8c | A notification with Approve on a no-presence card | | | | | |
| 9 | Uninstall: the sheet with "keep data"; the unit is gone; `~/.psyche` remains | | | | | |

## RAM

Idle numbers are taken after a few minutes with nothing running, in kilobytes of RSS (`ps -o rss= -p <pid>`) and shown here in MB. Peak numbers are the highest value seen during the step.

| Process | When | T1 (MB) | T2 (MB) | T3 (MB) | T4 (MB) |
| --- | --- | --- | --- | --- | --- |
| psyched | idle, window closed | | | | |
| Desktop (all Electron processes, summed) | idle, window open | | | | |
| Helper | idle (should be exiting on its own) | | | | |
| Helper | direct computer use, mid-task | | | | |
| Xvfb | virtual screen, mid-task | | | | |
| Helper | virtual screen, mid-task | | | | |
| LibreOffice Writer | virtual screen, mid-task | | | | |
| Everything above | 10 minutes after the task ends (should be none) | | | | |
| Separate desktop container | running (image size, start time, RSS) | | | | |

## Problems found

| # | Machine and step | What happened | Issue or PR |
| --- | --- | --- | --- |
| | | | |

## Human steps checklist

To be filled in once the packages exist. It lists the steps only a person at a real desktop can do (portal and password dialogs, the tray, notifications, lock screen, reboot persistence), each with the machine it needs and who ran it.

- [ ] (placeholder)
