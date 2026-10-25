/** The Liquid Glass spike stories (`components/GlassSurface.stories.tsx`). */
export const glass = {
  "glass.impl.native": "Native glass",
  "glass.impl.refraction": "CSS + refraction",
  "glass.impl.css": "CSS blur",
  "glass.impl.opaque": "Opaque fallback",
  "glass.impl.resolved": "Requested {requested} · drawn as {resolved}",
  "glass.impl.nativeNote":
    "Desktop only (PSYCHE_GLASS=native); here it falls back down the ladder.",
  "glass.demo.sidebar": "Sidebar",
  "glass.demo.toolbar": "Toolbar",
  "glass.demo.chat": "Chat",
  "glass.demo.search": "Search",
  "glass.demo.feed": "Feed",
  "glass.demo.library": "Library",
  "glass.demo.threadMain": "Main chat",
  "glass.demo.threadDentist": "Dentist booking",
  "glass.demo.threadLisbon": "Lisbon trip",
  "glass.demo.persona": "Wren · Holding the 2:30 slot",
  "glass.demo.mode": "balanced",
  "glass.demo.model": "Sonnet",
  "glass.demo.composer": "Message Wren…",
  "glass.demo.send": "Send",
  "glass.demo.dictate": "Dictate",
  "glass.demo.newChat": "New side chat",
  "glass.demo.backdropPhoto": "over a photo",
  "glass.demo.backdropText": "over text",
  "glass.demo.paragraph":
    "Three slots work with your Tuesday focus block: 9:30, 11:00 and 2:30. I held 2:30 because the front desk confirms within the hour. The intake form needs two fields from you before Monday.",
  "glass.probe.title": "Frame probe",
  "glass.probe.running": "Scrolling for {seconds, number} s…",
  "glass.probe.result":
    "{frames, number} frames · mean {mean} ms · p95 {p95} ms · p99 {p99} ms · {dropped, number} over budget",
} as const;
