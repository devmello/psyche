---
"@psyche/desktop": minor
"@psyche/web": minor
"@psyche/ui": patch
---

The ask panel is the voice pop-up (part of #693): hold the voice key, speak, and let go. The words are sent as a plain chat (or left in the input when Review before sending is on) and the answer appears as text. The panel window now exists when Ask about screen or Talk with Psyche is on; screen capture still follows Ask about screen. A `VoiceKeySource` seam in desktop main keeps the macOS key watch replaceable.
