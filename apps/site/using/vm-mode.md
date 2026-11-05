---
title: VM mode
---

# VM mode

VM mode runs the agent's work inside a sandbox Mac: a macOS virtual machine on your Mac, managed by Psyche Helper with Apple's Virtualization framework. A task that runs there uses the guest's apps, browser, files and command line instead of yours. The guest sees only the folders you share with it, read only unless you approve more, and Psyche never falls back to running a task's commands on your own Mac. The pieces are built, but creating the sandbox Mac is not reachable from the app yet, so treat this page as a preview.

## Turn it on

1. **Have a guest.** The sandbox Mac is created and installed by Psyche Helper. Installing downloads a macOS restore image of about 26 GB, unless you point it at a local IPSW file. The guest gets 4 CPU cores, 8 GB of memory and an 80 GB disk by default; your Mac always keeps at least 2 cores and 4 GB. When the guest's Psyche node connects, it pairs with your Gateway like any other device, and you approve it.
2. **Open Settings → VM mode** and turn on **Use a sandbox Mac for tasks**.
3. Under **Guest that runs task commands**, pick the guest. Until one has paired, it says "No guest is paired yet".
4. Under **Where a task runs when it doesn't say**, choose **Container sandbox** or **Sandbox Mac**.

::: info Screenshot placeholder
Settings → VM mode: the Use a sandbox Mac for tasks switch, the guest picker, the Container sandbox / Sandbox Mac choice, the Clipboard and Credentials options, and the Guest status box showing Running.
:::

## What it can do

- **Run a task's commands in the guest.** When a task runs in the sandbox Mac, its commands go to the guest's own Psyche node. If the guest is not running, those tasks wait until it is. They never run on your Mac instead.
- **Show its state.** The Guest status box shows what Psyche Helper last reported: the phase (Created, Installing macOS, Setting up, Running, Stopped and so on), the guest's macOS version, its resources, whether the guest helper is connected, and shared folders. Every phase change leaves a receipt.
- **Lifecycle.** Psyche Helper can start, stop, pause, resume and suspend the guest (suspend saves its state, and the next start restores it), resize it while stopped, and delete it.
- **Unattended setup.** On a macOS 27 Mac with a macOS 27 guest, the first boot creates the guest's user, auto-login and remote login with no Setup Assistant. Other combinations need one guided step.
- **Moving files.** Copying a file into the guest puts a read-only copy there. Copying a file out goes into a folder you shared with the agent, never over an existing file, and leaves a receipt.

### Shares

- Folders you share into the guest are **read only** by default. Read and write needs your approval, folder by folder.
- Psyche never shares `/`, your home folder, `~/Library`, system folders or Psyche's own data folder.
- In the guest, shares appear under `/Volumes/Psyche Shares/`.
- Settings → File access has a separate **VM shares** group for them.

### Clipboard and credentials

- **Clipboard:** "Paste into the guest only" (the default) or "Both ways".
- **Credentials:** "Host vault" (the default) keeps values on your Mac and fills them through the helper one at a time; "Guest vault" keeps a separate vault inside the guest.

## What it isolates, and what it doesn't

Isolated inside the guest: computer use, file access, browsing and the command sandbox for tasks that run there. A problem inside the guest reaches your Mac only through what you connected.

Not isolated:

- **The network.** The guest shares your Mac's network and IP address, and can reach other machines on your local network.
- **Shared folders**, and anything you allow to be written back.
- **The clipboard**, if you choose "Both ways".
- **An iCloud account** you sign in to inside the guest.
- **The host vault**, one approved fill at a time.

## What it asks you

- **Pairing the guest's node** with your Gateway, like any new device.
- **A read-and-write share**, folder by folder.
- **Copying a file out of the guest**, installing Psyche in the guest, granting the guest helper its permissions, and deleting the guest are owner actions that ask you. The agent cannot do them.
- Inside the guest, the agent asks for the same things it asks for on your Mac.

## On Windows: the sandbox PC

On Windows the same idea is a **sandbox PC**: a small Linux virtual machine on your PC, run through Hyper-V's Host Compute Service by a Windows service that Psyche installs. It is Linux, not Windows, and it is a command sandbox: a task that runs there gets a Linux shell with common tools (Node, Python, Git, ffmpeg and more), the folders you share with it, and no access to the rest of your PC. Psyche never falls back to running those commands on your PC.

**Turn it on:** Settings → Sandbox PC → turn it on.

1. Psyche asks Windows for administrator rights once, with a single UAC prompt, to install the service. Nothing else needs administrator rights, and the service serves only your account. If you dismiss the prompt, or your account cannot elevate, nothing is installed.
2. Psyche restarts its helper and downloads the guest image (a Linux kernel, an initial RAM disk and a root disk). Settings shows the download size and the disk it takes before you start; every file is checked against a published SHA-256 as it arrives. The image is kept in `%LOCALAPPDATA%\Psyche\vm-images`, readable only by your account and SYSTEM.
3. Create and start the guest from the same screen. When its Psyche node connects, approve it like any new device.

**Limits:**

- One sandbox PC per account, and one guest running at a time. A guest defaults to 4 CPUs, 4 GB of memory and a 64 GB session disk (it only takes the space it uses).
- It runs the `exec` tool only. `run_script`, scripts saved as tools, connectors Psyche makes itself and local (stdio) MCP servers need `srt`, which has no Windows build, so they are unavailable on Windows; the sandbox PC does not carry them. A local MCP server can run in a Docker or Podman container instead if the Gateway has `PSYCHE_MCP_LAUNCHER=container`.
- Folders are shared read only unless you approve more, as above. The guest has no network unless Psyche attaches one for the task.
- The root disk is never written: each start begins from the same system, and only the session disk (the node's identity, the guest's home) persists.
- It needs virtualization that Windows lets Psyche's service use. Settings says when it cannot be turned on.
- Docker or Podman, if installed, remain an alternative for the `exec` tool; a task's workspace chooses which one runs it.

## Limits today

- **You cannot create the sandbox Mac from the app.** Settings says to create one from Psyche Helper, but the helper has no window or menu for it, and no Psyche screen or CLI command starts the creation. Until that lands, VM mode cannot be set up by an owner.
- VM mode has been tested only against a simulated helper (3 of 3 scenario runs). The real virtual machine code has been exercised only by hand, and restoring a saved guest needs re-testing on real hardware.
- The prompt-injection corpus has no cases for VM mode yet.
- Clipboard sync is not built: the setting is saved, but nothing copies between the guest and your Mac yet.
- "Fresh Mac" resets per task (snapshots) are not built, nor is setup for a macOS 26 guest without the guided step.
- One sandbox Mac per user. macOS allows at most two macOS guests per Mac, and Apple's license limits macOS guests to personal and development use.
- The sandbox Mac needs you logged in on your Mac. A Mac without a logged-in user cannot run it.

## Learn more

- [Security overview](/security/)
- [Permissions](/security/permissions)
- [VM mode in the architecture](https://github.com/devmello/psyche/blob/main/docs/02-architecture.md#10-vm-mode-a-mac-inside-psyche)
- [VM mode security](https://github.com/devmello/psyche/blob/main/docs/05-security-and-permissions.md#13-vm-mode-security)
- [Psyche Helper: VM mode](https://github.com/devmello/psyche/blob/main/apps/mac-helper/README.md#vm-mode-l1l5)
- [Provisioning spike](https://github.com/devmello/psyche/blob/main/docs/archive/spikes-docs/spike-06-vz-provisioning.md)
