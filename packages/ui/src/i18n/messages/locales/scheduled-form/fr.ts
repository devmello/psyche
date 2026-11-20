import type { Catalogue } from "../../index.ts";

/** Automation form strings (fr); merged into `../fr.ts`. */
export const scheduledForm: Partial<Catalogue> = {
  "scheduled.form.edit.title": "Modifier l'automatisation",
  "scheduled.form.prompt": "Que doit faire Psyche ?",
  "scheduled.form.prompt.hint":
    "Formule-le comme tu le demanderais à Psyche. Elle s'exécute sans surveillance, donc elle ne peut pas te poser de questions.",
  "scheduled.form.name": "Nom (facultatif)",
  "scheduled.form.name.hint": "Laisse vide pour utiliser la première ligne des instructions.",
  "scheduled.form.when": "Quand",
  "scheduled.form.zone": "Heures en {zone}.",
  "scheduled.form.when.kind": "Répétition",
  "scheduled.form.when.once": "Une fois, à une date et une heure",
  "scheduled.form.when.daily": "Chaque jour, à une heure",
  "scheduled.form.when.weekdays": "Jours ouvrés, à une heure",
  "scheduled.form.when.weekly": "Chaque semaine, les jours choisis",
  "scheduled.form.when.interval": "Toutes les quelques heures",
  "scheduled.form.when.custom": "Programme actuel : {schedule}",
  "scheduled.form.date": "Date",
  "scheduled.form.time": "Heure",
  "scheduled.form.days": "Ces jours-là",
  "scheduled.form.hours": "Heures entre deux exécutions",
  "scheduled.form.custom.hint":
    "Psyche garde ce programme tel quel. Choisis une autre option pour le modifier.",
  "scheduled.form.switch.hint":
    "Une automatisation ponctuelle ne peut pas se répéter, et une récurrente ne peut pas devenir ponctuelle. Crée une nouvelle automatisation pour cela.",
  "scheduled.form.next": "Prochaines exécutions",
  "scheduled.form.next.none": "Ce programme n'a plus d'exécutions.",
  "scheduled.form.delivery": "Où va le résultat",
  "scheduled.form.delivery.inbox": "Ma boîte de réception",
  "scheduled.form.delivery.thread": "Une conversation",
  "scheduled.form.delivery.none": "Nulle part (sans notification)",
  "scheduled.form.delivery.threadPick": "Conversation",
  "scheduled.form.delivery.pick": "Choisir une conversation",
  "scheduled.form.enabled": "Activée",
  "scheduled.form.enabled.hint": "Désactive-la pour la garder sans l'exécuter.",
  "scheduled.form.approvals":
    "Si une exécution a besoin de ton accord, elle ne demande rien pendant le run. L'action attend dans Reportées, dans Approbations, jusqu'à ta réponse.",
  "scheduled.form.save": "Enregistrer",
  "scheduled.form.cancel": "Annuler",
  "scheduled.form.delete": "Supprimer",
  "scheduled.form.error.prompt": "Écris ce que Psyche doit faire.",
  "scheduled.form.error.name": "Le nom doit faire moins de 200 caractères.",
  "scheduled.form.error.date": "Choisis une date.",
  "scheduled.form.error.time": "Choisis une heure.",
  "scheduled.form.error.past": "Cette heure est déjà passée. Choisis-en une plus tard.",
  "scheduled.form.error.days": "Choisis au moins un jour.",
  "scheduled.form.error.hours": "Saisis un nombre entier d'heures, de 1 à 168.",
  "scheduled.form.error.switch":
    "Psyche ne peut pas faire passer une automatisation de ponctuelle à récurrente, ou l'inverse. Crée-en une nouvelle.",
  "scheduled.form.error.thread":
    "Choisis la conversation où va le résultat, ou un autre emplacement.",
  "scheduled.form.notFound": "Cette automatisation n'existe plus.",
  "scheduled.form.toast.created": "{title} créée",
};
