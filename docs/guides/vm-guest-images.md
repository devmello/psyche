# Prebuilt sandbox Mac images

Psyche can run Tasks in a **sandbox Mac**, a macOS guest that the Mac helper creates with Apple's Virtualization framework. The normal way to make one installs macOS from Apple's restore image. That is a 26 GB download and a 5 to 15 minute install, followed by a first boot that sets up the account, and then Psyche is installed in the guest.

A **guest image** packages a sandbox Mac at the end of all that. Psyche is installed and the guest's helper already has Accessibility and Screen Recording. You build the image once on a capable Mac. Then you, or people you trust, create sandbox Macs from it on other Macs without the download or the install.

This is feature L7. Images are plain files you copy around, a folder or one `.aar` archive. There is no image registry or `pull` command yet.

## What an image contains

| File | What |
| --- | --- |
| `manifest.json` | Format, macOS version, disk format and size, the guest's user name, and the size and SHA-256 of every other file |
| `Disk.asif` or `Disk.img` | The guest's disk (macOS, the Psyche install) |
| `AuxiliaryStorage` | The guest's NVRAM |
| `HardwareModel` | The virtual hardware model it was installed for |
| `bootstrap.json` | The guest's user name and password at build time |

An image never contains the guest's **machine identifier**. Each Mac that imports the image mints its own identifier and network (MAC) address, so two imports are two different Macs.

## Security

- **The image holds a password.** `bootstrap.json` is the guest administrator's password from the build. At the first start after an import, Psyche changes it to a new random password, kept in your keychain. That change covers the account, the login keychain and automatic login. It also replaces the guest's SSH keys with your helper's own. Until then, anyone who has the image knows the password. The guest is reachable only from your Mac (NAT), but treat an image like a backup of a computer: share it only with people you trust.
- **Checksums are checked before anything is copied.** Importing verifies the SHA-256 of every file against `manifest.json`. It also checks that the image has exactly the expected files, with no extras and no symbolic links. If you pass the published checksum of `manifest.json` (`imageSha256`), the manifest itself is checked too. Always pass it for an image you did not build.
- **One sandbox Mac per user** still applies. Importing an image while you already have a sandbox Mac fails with `guest_exists`.

## Build an image

You need a Mac with:

- macOS 27, for unattended setup of a macOS 27 guest;
- at least 24 GB of memory;
- about 60 GB of free disk space;
- a checkout of the Psyche repository.

The build boots one guest. On a smaller Mac the script refuses to run unless you pass `--force`.

```bash
deploy/macos/build-guest-image.sh --ipsw ~/Downloads/UniversalMac_27.0.1_Restore.ipsw --archive
```

Use `--download` instead of `--ipsw` to fetch Apple's latest restore image. The script:

1. builds the helper app if `apps/mac-helper/dist/PsycheHelper.app` is missing;
2. creates a throwaway Psyche home, so your own sandbox Mac is not touched;
3. creates the guest, installs macOS, and boots it once to set up the account, automatic login and Remote Login;
4. installs Psyche in the guest from this checkout's committed files and the helper app;
5. stops the guest and pre-grants the guest helper's Accessibility and Screen Recording;
6. writes the image to `apps/mac-helper/dist/guest-images/<id>/` and verifies it.

It prints two things:

- the image path;
- the **manifest checksum** (also saved as `<id>.manifest.sha256`): publish it next to the image.

With `--archive` it also writes `<id>.aar` (Apple Archive, compressed) and `<id>.aar.sha256`. Expect 20–40 minutes plus any download.

To check an image you were given:

```bash
"/Applications/Psyche.app/Contents/Resources/PsycheHelper.app/Contents/MacOS/psyche-helper" guest-image verify ~/Downloads/macos-27.0.1-20261020 --sha256 <published checksum>
```

## Create a sandbox Mac from an image

Creating from an image is the helper's `vm.create` with `image`, the image's folder or `.aar` file, and `imageSha256`, the published checksum. Settings → Devices has no "Create from image" button yet; it is planned.

- The new guest starts **stopped**, with Psyche installed and its permissions granted.
- Its first start rotates the bootstrap password. Until then, `vm.status` shows `passwordRotationPending: true`.
- If the guest cannot be reached at that first start, it keeps running and the rotation is retried at the next start.

An image works only on a Mac that can run its hardware model. Otherwise you get `image_unsupported`; build a newer image or install from an IPSW. A guest image is about as large as the guest's disk: 30–35 GB right after the build.

## Limits

- Unattended setup needs macOS 27 on the building Mac and in the guest. Images of older macOS versions cannot be built with this script.
- After every boot, including the first boot of an imported image, macOS in the guest is busy for 15–20 minutes indexing and setting up services. Tasks run, but slowly, until it settles.
- Images are files. Copy them yourself; Psyche does not download or publish them.
