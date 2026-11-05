---
"@psyche/protocol": minor
"@psyche/ui": minor
"@psyche/gateway": minor
"@psyche/desktop": patch
"@psyche/web": minor
---

Linux virtual screen: Psyche can work in your apps on a private, invisible display while you keep using your own screen. The helper runs its own Xvfb and window manager, starts apps in a `psyche-vscreen.slice` systemd scope with memory limits, refuses apps that are already open on your screen, undoes launches that open a window somewhere else, and parks the Task when an app asks "Save changes?". The new watch pane shows the screen, has Stop, and lets you take over while Psyche pauses. All new text is in the ten languages.
