/** The memory map: a List | Map view of the Memory page (`memory-page/map/`). */
export const memoryMap = {
  "memory.page.view": "View",
  "memory.page.view.list": "List",
  "memory.page.view.map": "Map",

  "memory.map.title": "Memory map",
  "memory.map.canvasLabel":
    "Map of {nodes, plural, one {# item} other {# items}} with {links, plural, one {# link} other {# links}}. Drag to pan, scroll or pinch to zoom, arrow keys to move.",
  "memory.map.loading": "Loading the map",
  "memory.map.loadFailed": "Couldn't load the memory map.",
  "memory.map.empty":
    "Nothing to map yet. As Psyche learns about the people, projects and topics in your life, they appear here, linked.",
  "memory.map.sparse":
    "Only a few links so far. More appear as people share projects, meetings and conversations with you.",
  "memory.map.truncated": "Showing the {shown} most important of {total}.",

  "memory.map.search": "Find on the map",
  "memory.map.search.placeholder": "Find a person, project or topic",
  "memory.map.search.results": "Matches",
  "memory.map.search.none": "Nothing on the map matches “{q}”.",

  "memory.map.filters": "Show on the map",
  "memory.map.group.people": "People",
  "memory.map.group.projects": "Projects",
  "memory.map.group.events": "Events",
  "memory.map.group.topics": "Topics",
  "memory.map.group.other": "Places and orgs",
  "memory.map.quiet": "{n, plural, one {# person gone quiet} other {# people gone quiet}}",

  "memory.map.kind.person": "Person",
  "memory.map.kind.org": "Organisation",
  "memory.map.kind.project": "Project",
  "memory.map.kind.place": "Place",
  "memory.map.kind.event": "Event",
  "memory.map.kind.topic": "Topic",
  "memory.map.kind.assignment": "Work item",

  "memory.map.edge.works_on": "Works on",
  "memory.map.edge.met_in": "Met in",
  "memory.map.edge.co_mentioned": "Mentioned together",
  "memory.map.edge.related": "Related",
  "memory.map.legend": "Links",

  "memory.map.zoomIn": "Zoom in",
  "memory.map.zoomOut": "Zoom out",
  "memory.map.fit": "Fit to view",

  "memory.map.focus.showing":
    "{name} and {n, plural, =0 {no connections} one {# connection} other {# connections}}",
  "memory.map.focus.clear": "Show everything",

  "memory.map.card.connections": "{n, plural, =0 {No links} one {# link} other {# links}}",
  "memory.map.card.quiet": "Gone quiet",
  "memory.map.card.private": "Private",
  "memory.map.card.open": "Open",
  "memory.map.card.focus": "Focus here",
  "memory.map.card.hint": "Click to open. Shift-click to focus here.",

  "memory.map.list.label": "Items on the map, most important first",
} as const;
