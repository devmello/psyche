---
"@psyche/protocol": minor
"@psyche/files": minor
"@psyche/agent-core": minor
"@psyche/gateway": minor
"@psyche/ui": minor
---

Attach files in the chat composer. A + button shows when the thread's model can take files (from `models.list`; unknown shows it, a model without vision is offered documents only and says why an image was refused, an embeddings model hides it). Picked, dropped or pasted files become removable chips that upload through the new chunked `library.upload` (25 MiB, origin `upload`), and their Library ids go in `chat.send` `attachments`. The Gateway gives the agent images as image parts (4 per message, 5 MB each) and PDF, DOCX, XLSX and text files as capped extracted text (32k characters each, 96k per message) in the new `TurnInput.attachmentText`, kept out of what the owner said.
