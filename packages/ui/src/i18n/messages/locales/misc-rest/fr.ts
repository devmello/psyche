import type { Catalogue } from "../../index.ts";

/** Completed misc strings (fr); merged into `../fr.ts`. */
export const miscRest: Partial<Catalogue> = {
  "common.avatarCount":
    "{label}, {n, plural, one {# a besoin de vous} other {# ont besoin de vous}}",
  "canvas.export": "Exporter",
  "canvas.exportAs": "Exporter en tant que…",
  "canvas.exportFailed": "Échec de l’export : {message}",
  "canvas.loadingEditor": "Ouverture de l’éditeur…",
  "canvas.invalid":
    "{kind, select, slides {Cette présentation} other {Ce tableau}} n’a pas pu être lu.",
  "book.label": "Tableur : {title}",
  "book.sheets": "Feuilles",
  "book.addSheet": "Ajouter une feuille",
  "book.newSheet": "Feuille {n}",
  "book.cell": "Cellule {ref}",
  "book.formulaBar": "Valeur ou formule pour {ref}",
  "book.hint": "Commencez par = pour une formule, par exemple =SOMME(B2:B9).",
  "book.cells": "{count, plural, one {# cellule} other {# cellules}}",
  "personData.export": "Tout exporter…",
  "personData.said": "Oublier ce que cette personne a dit…",
  "personData.exclude": "Ne plus rien apprendre sur cette personne…",
  "personData.excludeForget": "Ne plus rien apprendre sur cette personne et oublier…",
  "personData.title.said": "Oublier ce que {name} a dit ?",
  "personData.title.exclude": "Ne plus rien apprendre sur {name} ?",
  "personData.title.exclude_forget": "Ne plus rien apprendre sur {name} et oublier ?",
  "personData.counts":
    "Cela supprime {facts, number} faits et {quotes, number} citations appris de ses messages, ainsi que {held, number} éléments retenus.",
  "personData.excludeOnly":
    "Ses messages ne seront pas lus et rien ne sera appris à son sujet. Ce qui est déjà connu reste jusqu’à ce que vous l’oubliiez.",
  "personData.after.said":
    "La personne, ses messages et tout ce que vous avez ajouté vous-même restent.",
  "personData.after.exclude":
    "Vous pourrez l’autoriser à nouveau dans Réglages → Mémoire → Confidentialité.",
  "personData.after.exclude_forget":
    "Vous pourrez l’autoriser à nouveau dans Réglages → Mémoire → Confidentialité, mais ce qui a été supprimé ne reviendra pas.",
  "personData.confirm.said": "Oublier ce qu’elle a dit",
  "personData.confirm.exclude": "Arrêter d’apprendre",
  "personData.confirm.exclude_forget": "Arrêter et oublier",
  "personData.done.said": "Ce que {name} a dit a été oublié.",
  "personData.done.exclude": "Plus rien n’est appris sur {name}.",
  "personData.done.exclude_forget":
    "Plus rien n’est appris sur {name}, et ce qu’elle a dit a été oublié.",
  "memoryBasics.group": "D’où il apprend",
  "memoryBasics.chats": "Vos discussions",
  "memoryBasics.chatsHint": "Retient ce qui compte dans vos conversations.",
  "memoryBasics.feedback": "Vos retours",
  "memoryBasics.feedbackHint": "Apprend des corrections, modifications et annulations.",
  "memoryBasics.everything": "E-mails, messages et notes",
  "memoryBasics.everythingHint":
    "La mémoire « Tout » les lit pendant la nuit et propose des faits à vérifier.",
  "memoryBasics.people": "Personnes et projets",
  "memoryBasics.peopleHint":
    "Tient une fiche pour chaque personne et chaque projet dont vous vous occupez.",
  "memoryBasics.paused": "La mémoire est en pause.",
  "memoryAdvanced.title": "Avancé",
  "memoryAdvanced.description": "Modèles, planning, mode de rappel, chiffrement et vos données.",
  "memoryAdvanced.recall": "Rappel",
  "memoryAdvanced.data": "Vos données",
  "memoryAdvanced.dataHint":
    "Exportez, sauvegardez ou réinitialisez tout ce dont {persona} se souvient.",
  "memoryAdvanced.dataOpen": "Ouvrir Confidentialité et données",
  "memoryAdvanced.keeping": "Durée de conservation",
  "memoryAdvanced.keepingPending": "Faits non vérifiés",
  "memoryAdvanced.keepingUntrusted": "Faits provenant d’autres personnes",
  "memoryAdvanced.keepingQuarantine": "Quarantaine",
  "memoryAdvanced.keepingDays": "{days, plural, one {# jour} other {# jours}}",
  "memoryAdvanced.keepingMonths": "{months, plural, one {# mois} other {# mois}}",
  "memoryAdvanced.encryption": "Chiffrement",
  "memoryPrivacy.title": "Confidentialité",
  "memoryPrivacy.description":
    "Sur qui {persona} peut apprendre, ce qu’il ne doit jamais conserver et comment lui faire oublier.",
  "memoryPrivacy.forget": "Oublier",
  "memoryPrivacy.forgetHint":
    "Supprimer ce qu’une source a apporté, ou tout sur les personnes et les projets.",
  "memoryPrivacy.sensitiveSummary": "{n, number} sur {total, number} autorisés",
  "memoryPrivacy.sensitiveChoose": "Choisir des sujets",
  "meetingRecord.palette": "Enregistrer la réunion…",
  "meetingRecord.title": "Enregistrer cette réunion ?",
  "meetingRecord.intro":
    "Prévenez tout le monde avant de commencer. Dites ceci à voix haute ou collez-le dans la discussion. Psyche ne rejoint jamais un appel et n’enregistre qu’après votre confirmation.",
  "meetingRecord.copy": "Copier",
  "meetingRecord.copied": "Copié",
  "meetingRecord.confirm": "J’ai prévenu tout le monde",
  "meetingRecord.cancel": "Annuler",
  "meetingRecord.privacy":
    "L’audio reste dans votre Psyche, y est transformé en notes, et n’est jamais envoyé ailleurs ni utilisé pour l’entraînement.",
  "meetingRecord.unavailable":
    "L’enregistrement nécessite un moyen de transformer l’audio en notes (l’assistant Mac), qui n’est pas connecté.",
  "meetingRecord.micDenied":
    "Psyche ne peut pas utiliser le microphone. Autorisez-le dans Réglages Système.",
  "meetingRecord.failed": "Psyche n’a pas pu enregistrer cette réunion.",
  "meetingRecord.pill": "Enregistrement de la réunion · {time}",
  "meetingRecord.stop": "Arrêter",
  "meetingRecord.stopping": "Enregistrement…",
  "meetingRecord.notes.processing": "Rédaction des notes…",
  "meetingRecord.notes.done": "Les notes sont prêtes dans Home.",
  "meetingRecord.notes.needs_permission":
    "Les notes attendent votre accord pour utiliser un modèle cloud.",
  "meetingRecord.notes.failed":
    "Psyche n’a pas pu rédiger de notes à partir de cet enregistrement.",
  "automationChat.label": "Exécutions de {title}",
  "automationChat.runs": "{n, plural, one {# exécution} other {# exécutions}}",
  "automationChat.runs.aria":
    "{title}, {n, plural, one {# exécution} other {# exécutions}}, dernière exécution : {status}",
  "automationChat.schedule": "Planifié",
  "automationChat.runNow": "Exécuter maintenant",
  "automationChat.empty":
    "Aucune exécution pour l’instant. Chaque fois que cette automatisation s’exécute, elle apparaît ici.",
  "automationChat.loading": "Chargement des exécutions",
  "automationChat.failed": "Psyche n’a pas pu charger les exécutions",
  "automationChat.more": "Afficher les exécutions plus anciennes",
  "automationChat.status.needsYou": "Vous attend",
  "automationChat.status.running": "En cours",
  "automationChat.trigger.manual": "Exécuter maintenant",
  "automationChat.trigger.event": "Sur un événement",
  "automationChat.coalesced": "{n} exécutions manquées en une",
  "automationChat.noResult": "Aucun résultat rédigé",
  "automationChat.noSteps": "Aucune étape n’a été enregistrée pour cette exécution.",
  "automationChat.stepsLoading": "Chargement des étapes",
  "automationChat.timeline": "Ouvrir dans la chronologie",
  "automationChat.approvals": "Ouvrir les approbations",
  "automationChat.waiting": "Cette exécution vous attend.",
  "automationChat.result": "Résultat",
  "automationChat.openScheduled": "Ouvrir dans Planifié",
  "automationChat.row.runs": "{n, plural, one {# exécution} other {# exécutions}}",
  "automationChat.row.last": "Dernière exécution : {status}",
};
