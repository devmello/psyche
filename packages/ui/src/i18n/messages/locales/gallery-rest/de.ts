import type { Catalogue } from "../../index.ts";

/** Completed gallery strings (de); merged into `../de.ts`. */
export const galleryRest: Partial<Catalogue> = {
  "gallery.intro":
    "Such dir etwas zum Ausprobieren aus. Jeder Connector fragt nach, bevor er etwas tut, und du kannst ihn jederzeit entfernen.",
  "gallery.search": "Connectors durchsuchen",
  "gallery.noMatch":
    "Nichts passt. Versuche ein anderes Wort oder füge deinen eigenen MCP-Server hinzu.",
  "gallery.back": "Alle Connectors",
  "gallery.getKey": "Wo du ihn bekommst.",
  "gallery.keyStaysInVault":
    "Er wird in deinem Tresor aufbewahrt, nie in den Einstellungen des Servers.",
  "gallery.tryAsking": "Frag nach dem Hinzufügen zum Beispiel:",
  "gallery.custom.desc":
    "Jeder MCP-Server: ein Befehl, der in der Sandbox läuft, oder eine Webadresse.",
  "gallery.badge.builtIn": "Integriert",
  "gallery.badge.official": "Offiziell",
  "gallery.badge.community": "Community",
  "gallery.category.popular": "Beliebt",
  "gallery.category.files": "Dateien und Wissen",
  "gallery.category.dev": "Entwicklung",
  "gallery.category.productivity": "Produktivität",
  "gallery.category.comms": "Nachrichten und E-Mail",
  "gallery.category.web": "Web",
  "gallery.category.everyday": "Alltag",
  "gallery.category.finance": "Finanzen",
  "gallery.category.custom": "Deine eigenen",
  "gallery.builtin.google": "Gmail, Google Kalender und Drive.",
  "gallery.builtin.microsoft": "Outlook-Mail und -Kalender.",
  "gallery.builtin.imap": "Jedes Mailkonto mit IMAP-Unterstützung.",
  "gallery.builtin.appleNotes": "Deine Notizen in Apple Notizen lesen und ergänzen.",
  "gallery.builtin.appleReminders": "Erinnerungen ansehen und anlegen.",
  "gallery.builtin.appleCalendar": "Deinen Kalender ansehen und Termine hinzufügen.",
  "gallery.builtin.appleMail": "Mails in Apple Mail lesen und entwerfen.",
  "gallery.builtin.appleShortcuts": "Die Kurzbefehle ausführen, die du auswählst.",
  "gallery.builtin.obsidian": "Deinen Obsidian-Vault durchsuchen und lesen.",
  "gallery.builtin.slack": "Chatte mit Psyche aus Slack. Einrichtung unter „Kanäle“.",
  "gallery.preset.github.desc": "Repositories, Issues und Pull Requests durchstöbern.",
  "gallery.preset.github.example": "Welche Pull Requests warten auf meine Prüfung?",
  "gallery.preset.github.field.token.label": "Persönliches Zugriffstoken",
  "gallery.preset.github.field.token.help":
    "Ein fein abgestuftes Token, beschränkt auf die Repositories, die Psyche sehen soll.",
  "gallery.preset.gitlab.desc":
    "Projekte, Merge Requests und Issues auf GitLab.com. Du meldest dich an, wenn es sich verbindet.",
  "gallery.preset.gitlab.example":
    "Fasse die offenen Merge Requests in meinem Hauptprojekt zusammen.",
  "gallery.preset.git.desc": "Verlauf, Branches und Diffs eines lokalen Repositorys lesen.",
  "gallery.preset.git.example": "Was hat sich in diesem Repository in der letzten Woche geändert?",
  "gallery.preset.git.field.repo.label": "Repository-Ordner",
  "gallery.preset.git.field.repo.help":
    "Der Ordner eines Git-Repositorys auf diesem Mac. Psyche kann seinen Verlauf und seine Diffs lesen.",
  "gallery.preset.sentry.desc":
    "Fehler und Issues in deinen Sentry-Projekten untersuchen. Du meldest dich an, wenn es sich verbindet.",
  "gallery.preset.sentry.example": "Was sind die häufigsten ungelösten Fehler dieser Woche?",
  "gallery.preset.linear.desc":
    "Issues und Projekte finden und aktualisieren. Du meldest dich an, wenn es sich verbindet.",
  "gallery.preset.linear.example": "Welche Issues sind mir zugewiesen und diese Woche fällig?",
  "gallery.preset.jira.desc":
    "Jira-Issues und Confluence-Seiten durchsuchen. Du meldest dich an, wenn es sich verbindet.",
  "gallery.preset.jira.example": "Zeige die Jira-Tickets, die ich gestern aktualisiert habe.",
  "gallery.preset.notion.desc":
    "Seiten in deinem Notion-Workspace durchsuchen, lesen und bearbeiten. Du meldest dich an, wenn es sich verbindet.",
  "gallery.preset.notion.example": "Finde in Notion meine Meeting-Notizen vom letzten Dienstag.",
  "gallery.preset.todoist.desc":
    "Deine Todoist-Aufgaben und -Projekte ansehen und verwalten. Du meldest dich an, wenn es sich verbindet.",
  "gallery.preset.todoist.example": "Was ist heute in Todoist fällig?",
  "gallery.preset.airtable.desc":
    "Die Datensätze in deinen Airtable-Bases lesen und aktualisieren.",
  "gallery.preset.airtable.example":
    "Liste die Datensätze in meiner Projekte-Base auf, die als blockiert markiert sind.",
  "gallery.preset.airtable.field.key.label": "Persönliches Zugriffstoken",
  "gallery.preset.airtable.field.key.help":
    "Erstelle ein Token, das die Bases lesen kann, die du nutzen willst.",
  "gallery.preset.fetch.desc": "Eine Webseite abrufen und als reinen Text lesen.",
  "gallery.preset.fetch.example": "Lies diese Seite und nenne mir die drei wichtigsten Punkte.",
  "gallery.preset.fetch.field.sites.label": "Websites, die erreicht werden dürfen",
  "gallery.preset.fetch.field.sites.help":
    "Hostnamen, durch Kommas getrennt, etwa en.wikipedia.org. Leer erreicht er nur die Paketregistry.",
  "gallery.preset.braveSearch.desc": "Mit Brave das Web, Nachrichten und Bilder durchsuchen.",
  "gallery.preset.braveSearch.example":
    "Suche nach den Nachrichten dieser Woche über Open-Source-KI-Modelle.",
  "gallery.preset.braveSearch.field.key.label": "API-Schlüssel",
  "gallery.preset.braveSearch.field.key.help": "Der kostenlose Tarif reicht zum Ausprobieren.",
  "gallery.preset.playwright.desc":
    "Einen separaten Browser steuern, um Seiten zu lesen und Formulare auszufüllen.",
  "gallery.preset.playwright.example": "Öffne example.com und sag mir, was auf der Seite steht.",
  "gallery.preset.playwright.field.sites.label": "Websites, die erreicht werden dürfen",
  "gallery.preset.playwright.field.sites.help":
    "Hostnamen, durch Kommas getrennt, die geöffnet werden dürfen. Leer lassen, um ihn offline zu halten.",
  "gallery.preset.firecrawl.desc": "Websites in sauberen Text umwandeln und durchsuchen.",
  "gallery.preset.firecrawl.example":
    "Durchsuche die Doku-Website auf example.com und fasse die wichtigsten Abschnitte zusammen.",
  "gallery.preset.firecrawl.field.key.label": "API-Schlüssel",
  "gallery.preset.firecrawl.field.key.help":
    "Wird genutzt, um Websites für dich zu erfassen und zu durchsuchen.",
  "gallery.preset.time.desc": "Die aktuelle Uhrzeit abrufen und zwischen Zeitzonen umrechnen.",
  "gallery.preset.time.example": "Wie spät ist es in Tokio, wenn es in San Francisco 9 Uhr ist?",
  "gallery.preset.homeAssistant.desc":
    "Die Geräte ansehen und steuern, die du in Home Assistant freigibst.",
  "gallery.preset.homeAssistant.example": "Welche Lichter sind gerade an?",
  "gallery.preset.homeAssistant.field.url.label": "Serveradresse",
  "gallery.preset.homeAssistant.field.url.help":
    "Schalte die Integration „Model Context Protocol Server“ ein und kopiere ihre Adresse dann aus Einstellungen, System, KI. Sie muss mit https:// beginnen.",
  "gallery.preset.stripe.desc":
    "Kunden, Zahlungen und Salden nachschlagen. Nur lesend, festgelegt durch deinen eingeschränkten Schlüssel.",
  "gallery.preset.stripe.example": "Wie viel habe ich in den letzten 30 Tagen berechnet?",
  "gallery.preset.stripe.field.key.label": "Eingeschränkter Schlüssel",
  "gallery.preset.stripe.field.key.help":
    "Erstelle einen eingeschränkten Schlüssel (er beginnt mit rk_) nur mit Leseberechtigung. Andere Schlüssel werden hier abgelehnt.",
};
