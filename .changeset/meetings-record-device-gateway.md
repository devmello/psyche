---
"@psyche/gateway": minor
"@psyche/proactive": patch
---

Record meeting takes the owner's device microphone: audio pushed to the Gateway becomes a Library WAV that the file transcriber (the Mac helper's `speech.transcribe_file`, or any `PathTranscriber`) reads where it lies. It is available once a transcriber is online, only the capturing device may push, and a recording ends by itself when chunks stop or the device disconnects.
