---
"@psyche/desktop": minor
---

Voice HUD window (V-G, #691, spec §6.2): with voice conversation on, main keeps a warm, hidden, non-activating panel running the renderer at `/voice-hud` and shows it top-centre when the voice key goes down in any app. The preload bridge gains `psyche.voiceHud.{done, openThread}`; main accepts them only from the HUD window. `done` destroys the window (freeing the microphone) and warms a fresh one; `openThread` also brings up the main window on that thread. Screen lock and sleep destroy it until the Mac is back. The HUD may call the Gateway and use the microphone like an app renderer.
