---
"@psyche/protocol": minor
"@psyche/gateway": minor
"@psyche/desktop": minor
"@psyche/web": minor
---

The Gateway names its build in the handshake (`ConnectChallenge.server`: version, build, commit), and the desktop restarts its own LaunchAgent when the running Gateway's build is not the one the app shipped. The build also goes into the LaunchAgent plist as `PSYCHE_BUILD`, so an updated app reloads the agent. This fixes an old Gateway being left running on top of replaced files after an app update. No protocol bump: the field is optional.
