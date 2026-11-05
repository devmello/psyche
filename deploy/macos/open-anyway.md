### Opening Psyche the first time (Mac)

Psyche is signed with its own certificate, not an Apple Developer ID, and it is not notarized. The first time you open it, macOS says **"Apple could not verify Psyche is free of malware"**. That is expected. Once:

1. Click **Done** (not Move to Trash).
2. Open **System Settings › Privacy & Security** and scroll to **Security**.
3. Click **Open Anyway** next to "Psyche was blocked", then confirm with your password or Touch ID.

After that it opens normally, and updates that Psyche downloads itself install without asking again. Every release is signed with the same certificate, so your macOS permissions (Microphone, Accessibility and so on) carry over. If the SHA-1 of the certificate ever changes, this note will say so and you will need to reinstall once by hand.

To check a download yourself: `codesign -d -r- /Applications/Psyche.app` should print `identifier "com.psyche.desktop" and certificate leaf = H"…"` with the hash published in `deploy/macos/designated-requirements.txt`.
