import type { Catalogue } from "../../index.ts";

/** Approval-friction and person-interaction strings (de); merged into `../de.ts`. */
export const friction: Partial<Catalogue> = {
  "friction.title": "Rückfragen bei Freigaben",
  "friction.hint":
    "Wie oft Psyche vor einer Aktion nachfragt und wie du antwortest. Nur Zahlen aus dem Prüfprotokoll.",
  "friction.window": "Zeitraum",
  "friction.window.days": "Letzte {days} Tage",
  "friction.loading": "Freigaben werden gezählt…",
  "friction.error": "Rückfragen konnten nicht geladen werden: {reason}",
  "friction.retry": "Erneut versuchen",
  "friction.empty":
    "Psyche hat in diesem Zeitraum keine Aktionen geprüft, daher gibt es nichts anzuzeigen.",
  "friction.since": "Seit {date}",
  "friction.asked":
    "Bei {asks, plural, one {# Aktion} other {# Aktionen}} von {decisions, plural, one {# Aktion} other {# Aktionen}} nachgefragt ({rate} %).",
  "friction.perRun": "Läufe, in denen nachgefragt wurde, hatten im Schnitt {n} Rückfragen.",
  "friction.answered":
    "Von den beendeten Rückfragen wurden {rate} % beantwortet, bevor sie abliefen.",
  "friction.approved": "Von den beendeten Rückfragen wurden {rate} % genehmigt.",
  "friction.noTimes":
    "In diesem Zeitraum wurde keine Rückfrage beantwortet, daher gibt es keine Antwortzeit.",
  "friction.times":
    "Die Antwort dauerte im Median {p50}. Das langsamste Zehntel brauchte {p90} oder mehr.",
  "friction.expired":
    "{n, plural, =0 {Keine Rückfrage ist unbeantwortet abgelaufen.} one {# Rückfrage ist unbeantwortet abgelaufen.} other {# Rückfragen sind unbeantwortet abgelaufen.}}",
  "friction.rejected":
    "{n, plural, =0 {Keine Antwort wurde abgelehnt.} one {# Antwort wurde als ungültig abgelehnt.} other {# Antworten wurden als ungültig abgelehnt.}}",
  "friction.saved":
    "{n, plural, =0 {Keine Aktion lief über eine dauerhafte Freigabe ohne Rückfrage.} one {# Aktion lief über eine dauerhafte Freigabe ohne Rückfrage.} other {# Aktionen liefen über eine dauerhafte Freigabe ohne Rückfrage.}}",
  "friction.grantsCreated":
    "{n, plural, =0 {Es wurden keine dauerhaften Freigaben erstellt.} one {Es wurde # dauerhafte Freigabe erstellt.} other {Es wurden # dauerhafte Freigaben erstellt.}}",
  "friction.kinds": "Wo die Rückfragen entstanden",
  "friction.kind.row":
    "{kind}: {asks} nachgefragt, {approved} genehmigt, {declined} abgelehnt, {expired} abgelaufen",
  "friction.rules": "Häufigste Gründe für eine Rückfrage",
  "friction.rule.row": "{label}: {count}",
  "friction.rule.mode": "Deine Moduseinstellung",
  "friction.rule.taint": "Inhalt von außen",
  "friction.rule.policy": "Deine Richtlinie",
  "friction.rule.designated": "Ein geschützter Ort",
  "friction.rule.site": "Eine Website-Regel",
  "friction.rule.other": "Eine andere Regel",
  "friction.modes": "Nach Modus",
  "friction.mode.row": "{mode}: {asks} von {decisions} nachgefragt",

  "people.interactions.title": "Letzte Interaktionen",
  "people.interactions.empty": "Noch keine Interaktionen mit {name}.",
  "people.interactions.error": "Interaktionen konnten nicht geladen werden: {reason}",
  "people.interactions.more": "Mehr anzeigen",
  "people.interactions.loadingMore": "Wird geladen…",
};
