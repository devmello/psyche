---
"@psyche/gateway": minor
"@psyche/proactive": patch
---

Post-meeting notes in the Gateway: `meetings.notes.create` and Record meeting (`meetings.record.*`) on `MeetingNotesService`, with `VoiceMemoService` transcribing long recordings through the helper's `speech.transcribe_file`; meeting prep reads attendees and open loops from the people graph, and "they owe you" items become graph loops.
