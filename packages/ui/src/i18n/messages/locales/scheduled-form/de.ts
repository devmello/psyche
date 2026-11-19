import type { Catalogue } from "../../index.ts";

/** Automation form strings (de); merged into `../de.ts`. */
export const scheduledForm: Partial<Catalogue> = {
  "scheduled.form.edit.title": "Automatisierung bearbeiten",
  "scheduled.form.prompt": "Was soll Psyche tun?",
  "scheduled.form.prompt.hint":
    "Schreib es so, wie du Psyche etwas fragen würdest. Es läuft ohne Aufsicht und kann dir deshalb keine Rückfragen stellen.",
  "scheduled.form.name": "Name (optional)",
  "scheduled.form.name.hint": "Leer lassen, dann wird die erste Zeile der Anweisung verwendet.",
  "scheduled.form.when": "Wann",
  "scheduled.form.zone": "Zeiten in {zone}.",
  "scheduled.form.when.kind": "Wiederholung",
  "scheduled.form.when.once": "Einmal, zu Datum und Uhrzeit",
  "scheduled.form.when.daily": "Jeden Tag, zu einer Uhrzeit",
  "scheduled.form.when.weekdays": "Werktags, zu einer Uhrzeit",
  "scheduled.form.when.weekly": "Wöchentlich, an ausgewählten Tagen",
  "scheduled.form.when.interval": "Alle paar Stunden",
  "scheduled.form.when.custom": "Aktueller Zeitplan: {schedule}",
  "scheduled.form.date": "Datum",
  "scheduled.form.time": "Uhrzeit",
  "scheduled.form.days": "An diesen Tagen",
  "scheduled.form.hours": "Stunden zwischen den Läufen",
  "scheduled.form.custom.hint":
    "Psyche behält diesen Zeitplan so bei. Wähle eine andere Option, um ihn zu ändern.",
  "scheduled.form.switch.hint":
    "Eine einmalige Automatisierung kann sich nicht wiederholen, und eine wiederholte kann nicht einmalig werden. Lege dafür eine neue Automatisierung an.",
  "scheduled.form.next": "Nächste Läufe",
  "scheduled.form.next.none": "Dieser Zeitplan hat keine weiteren Läufe.",
  "scheduled.form.delivery": "Wohin das Ergebnis geht",
  "scheduled.form.delivery.inbox": "Meinen Posteingang",
  "scheduled.form.delivery.thread": "Einen Chat",
  "scheduled.form.delivery.none": "Nirgendwohin (keine Benachrichtigung)",
  "scheduled.form.delivery.threadPick": "Chat",
  "scheduled.form.delivery.pick": "Chat wählen",
  "scheduled.form.enabled": "Aktiviert",
  "scheduled.form.enabled.hint":
    "Ausschalten, um die Automatisierung zu behalten, ohne sie laufen zu lassen.",
  "scheduled.form.approvals":
    "Braucht ein Lauf deine Freigabe, fragt er während des Laufs nicht nach. Die Aktion wartet unter Zurückgestellt in den Freigaben, bis du sie beantwortest.",
  "scheduled.form.save": "Speichern",
  "scheduled.form.cancel": "Abbrechen",
  "scheduled.form.delete": "Löschen",
  "scheduled.form.error.prompt": "Schreib, was Psyche tun soll.",
  "scheduled.form.error.name": "Der Name darf höchstens 200 Zeichen haben.",
  "scheduled.form.error.date": "Wähle ein Datum.",
  "scheduled.form.error.time": "Wähle eine Uhrzeit.",
  "scheduled.form.error.past": "Diese Zeit ist schon vorbei. Wähle eine spätere.",
  "scheduled.form.error.days": "Wähle mindestens einen Tag.",
  "scheduled.form.error.hours": "Gib eine ganze Zahl von Stunden von 1 bis 168 ein.",
  "scheduled.form.error.switch":
    "Psyche kann eine Automatisierung nicht zwischen einmalig und wiederholt umstellen. Lege stattdessen eine neue an.",
  "scheduled.form.error.thread":
    "Wähle den Chat, an den das Ergebnis geht, oder einen anderen Ort.",
  "scheduled.form.notFound": "Diese Automatisierung gibt es nicht mehr.",
  "scheduled.form.toast.created": "{title} angelegt",
};
