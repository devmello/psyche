import type { Catalogue } from "../../index.ts";

/** Mail and meeting settings and onboarding strings (fr); merged into `../fr.ts`. */
export const mailMeetings: Partial<Catalogue> = {
  "settings.nav.mail": "Mail et réunions",
  "settings.mail.title": "Mail et réunions",
  "settings.mail.description":
    "Ce que Wren fait de votre mail et de votre agenda. Il enregistre des brouillons et propose des actions ; rien n’est envoyé, partagé, accepté ou refusé sans votre accord.",
  "settings.mail.quietHours": "Les heures calmes se règlent dans Notifications.",
  "settings.mail.loadFailed": "Impossible de charger les réglages du mail et des réunions.",

  // Group titles
  "settings.mail.group.master": "Tout d’un coup",
  "settings.mail.group.accounts": "Comptes",
  "settings.mail.group.digest": "Résumé de la boîte de réception",
  "settings.mail.group.followups": "Relances",
  "settings.mail.group.style": "Style d’écriture",
  "settings.mail.group.scheduling": "Planification",
  "settings.mail.group.prep": "Préparation de réunion",
  "settings.mail.group.notes": "Notes de réunion",
  "settings.mail.group.polling": "Vérification des nouveaux mails",

  // Master switches
  "settings.mail.paused.hint":
    "Suspend toutes les tâches de mail et de réunion jusqu’à ce que vous les réactiviez.",
  "settings.mail.readOnly.hint":
    "Les résumés et les préparations continuent. Wren ne propose aucune action et ne rédige aucun brouillon.",

  // Accounts
  "settings.mail.accounts.none":
    "Aucun compte mail n’est connecté. Connectez-en un dans Connecteurs.",
  "settings.mail.accounts.use": "Utiliser {account} dans le résumé et les relances",
  "settings.mail.accounts.connect": "Ouvrir Connecteurs",

  // Inbox digest
  "settings.mail.digest.time": "Heure",
  "settings.mail.digest.days": "Jours",
  "settings.mail.digest.days.weekdays": "Jours ouvrés",
  "settings.mail.digest.days.everyday": "Tous les jours",
  "settings.mail.digest.onlyWhenNeeded.hint":
    "Les jours calmes, le résumé arrive dans le Fil sans notification.",
  "settings.mail.digest.rules": "Règles d’expéditeur",
  "settings.mail.digest.rulesHint": "Qui est toujours archivé, toujours autorisé ou filtré.",
  "settings.mail.digest.openRules": "Ouvrir",
  "settings.mail.digest.openRulesAsk": "Montre-moi mail/RULES.md.",

  // Follow-ups
  "settings.mail.followups.waitDays": "Délai avant son apparition",
  "settings.mail.followups.days": "{n, plural, one {# jour ouvré} other {# jours ouvrés}}",
  "settings.mail.followups.showTwice.hint": "Après deux résumés, il passe en silence.",

  // Writing style
  "settings.mail.voice.learn.hint":
    "Wren ne lit que ce que vous avez écrit dans vos mails envoyés, sans le texte cité ni les signatures. Le profil reste sur ce Mac dans mail/VOICE.md.",
  "settings.mail.voice.profile": "Profil de style",
  "settings.mail.voice.view": "Afficher",
  "settings.mail.voice.edit": "Modifier",
  "settings.mail.voice.reset": "Réinitialiser",
  "settings.mail.voice.viewAsk": "Montre-moi mail/VOICE.md.",
  "settings.mail.voice.editAsk": "Laisse-moi modifier mail/VOICE.md.",
  "settings.mail.voice.resetAsk":
    "Réinitialise mon profil de style d’écriture : supprime mail/VOICE.md et mail/voice-samples.jsonl.",
  "settings.mail.voice.localModel.hint":
    "Les brouillons dans votre style ne quittent jamais ce Mac.",
  "settings.mail.voice.localModel.none": "Utiliser le modèle principal",
  "settings.mail.voice.localModel.empty": "Aucun modèle local n’est configuré.",

  // Scheduling
  "settings.mail.schedule.hours": "Heures de travail",
  "settings.mail.schedule.hoursHint":
    "Tirées de USER.md. Les créneaux sont proposés dans ces heures, les jours ouvrés.",
  "settings.mail.schedule.hoursFrom": "De",
  "settings.mail.schedule.hoursTo": "À",
  "settings.mail.schedule.buffer.hint":
    "Marge gardée autour des réunions quand des horaires sont proposés.",
  "settings.mail.schedule.minutes": "{n, plural, one {# minute} other {# minutes}}",
  "settings.mail.schedule.noBuffer": "Aucune",
  "settings.mail.schedule.focusTime.hint":
    "Proposer de réserver un créneau pour le travail de fond.",
  "settings.mail.schedule.link.hint": "Facultatif. Proposé dans les réponses si vous en avez un.",

  // Meeting prep
  "settings.mail.prep.scope.hint": "Ignore les réunions qui n’impliquent que votre propre équipe.",
  "settings.mail.prep.leadMin": "Préparer en amont de la réunion",
  "settings.mail.prep.notifyMin": "Me prévenir avant le début",
  "settings.mail.prep.saveToNotes.hint":
    "Garde aussi la note de préparation dans votre app de notes.",
  "settings.mail.prep.dailyCap": "Maximum de préparations par jour",
  "settings.mail.prep.calendars":
    "La préparation couvre les agendas que vous avez connectés dans Connecteurs.",

  // Meeting notes
  "settings.mail.notes.enabled.hint":
    "Ne fait rien tant que vous n’ajoutez pas d’audio : un mémo vocal, un fichier ou un enregistrement que vous lancez.",
  "settings.mail.notes.folder": "Dossier des enregistrements",
  "settings.mail.notes.folder.hint":
    "Un dossier que Wren peut lire. Autorisez-le dans Accès aux fichiers.",
  "settings.mail.notes.folder.placeholder": "~/Documents/Recordings",
  "settings.mail.notes.tasksApp": "Ajouter les actions à",
  "settings.mail.notes.tasksApp.reminders": "Rappels",
  "settings.mail.notes.tasksApp.things": "Things",
  "settings.mail.notes.recap.hint":
    "Enregistre un mail de récapitulatif en brouillon après chaque réunion.",
  "settings.mail.notes.consent.hint":
    "Affichée avant chaque enregistrement que vous lancez. Vous la dites ou vous la collez dans l’appel.",
  "settings.mail.notes.consent.default":
    "J’enregistre ceci pour mes notes. Cela vous convient-il ?",
  "settings.mail.notes.cloud.hint":
    "Les transcriptions contiennent les paroles d’autres personnes. Désactivé, les résumés utilisent un modèle local, ou demander d’abord.",

  // Polling
  "settings.mail.poll.active": "Quand vous êtes actif",
  "settings.mail.poll.idle": "Sinon",
  "settings.mail.poll.hint":
    "À quelle fréquence Wren cherche de nouveaux mails. Plus souvent consomme plus de batterie.",

  // Setting-key labels
  "settings.key.workflows.paused": "Suspendre tous les flux de mail et de réunion",
  "settings.key.workflows.readOnly": "Lecture seule (résumés et préparation uniquement)",
  "settings.key.mail.accounts": "Utiliser {account} dans le résumé et les relances",
  "settings.key.mail.digest.enabled": "Résumé de la boîte de réception",
  "settings.key.mail.digest.time": "Heure du résumé",
  "settings.key.mail.digest.days": "Jours du résumé",
  "settings.key.mail.digest.onlyWhenNeeded": "Notifier seulement si quelque chose vous attend",
  "settings.key.mail.followups.enabled": "Suivre les réponses que vous attendez",
  "settings.key.mail.followups.waitDays": "Délai de relance",
  "settings.key.mail.followups.showTwice": "Afficher chaque relance deux fois au plus",
  "settings.key.mail.voice.enabled": "Apprendre des mails envoyés",
  "settings.key.mail.draft.localModel": "Rédiger avec un modèle local",
  "settings.key.mail.schedule.hoursStart": "Début des heures de travail",
  "settings.key.mail.schedule.hoursEnd": "Fin des heures de travail",
  "settings.key.mail.schedule.bufferMin": "Marge entre réunions",
  "settings.key.mail.schedule.focusTime": "Proposer du temps de concentration",
  "settings.key.mail.schedulingLink": "Lien de planification",
  "settings.key.mail.poll.activeMin": "Vérification du mail en activité",
  "settings.key.mail.poll.idleMin": "Vérification du mail sinon",
  "settings.key.meetings.prep.enabled": "Préparation de réunion",
  "settings.key.meetings.prep.scope":
    "Seulement les réunions avec des personnes hors de mon domaine",
  "settings.key.meetings.prep.leadMin": "Délai de préparation",
  "settings.key.meetings.prep.notifyMin": "Délai de l’avis de préparation",
  "settings.key.meetings.prep.saveToNotes": "Enregistrer aussi la préparation dans Notes",
  "settings.key.meetings.prep.dailyCap": "Maximum de préparations par jour",
  "settings.key.meetings.notes.enabled": "Notes de réunion à partir d’enregistrements",
  "settings.key.meetings.notes.folder": "Dossier des enregistrements",
  "settings.key.meetings.notes.tasksApp": "Ajouter les actions à",
  "settings.key.meetings.notes.recapDraft": "Rédiger un mail de récapitulatif",
  "settings.key.meetings.notes.consentLine": "Phrase de consentement à l’enregistrement",
  "settings.key.meetings.notes.cloudSummary": "Résumer avec un modèle cloud",

  // Onboarding decision screen
  "onboarding.step.mail": "Mail et réunions",
  "onboarding.mail.title": "{name} peut vous tenir au courant de votre mail et de vos réunions",
  "onboarding.mail.lead":
    "Choisissez ce que vous voulez. Rien ne démarre avant que vous continuiez, et tout se change dans Réglages.",
  "onboarding.mail.digest": "Résumé matinal de la boîte de réception à 7 h 30",
  "onboarding.mail.digestHint":
    "Un résumé par jour de ce qui vous attend. Il n’envoie jamais rien.",
  "onboarding.mail.prep":
    "Notes de préparation avant les réunions avec des personnes hors de votre équipe",
  "onboarding.mail.prepHint":
    "Qui elles sont, ce qui est en suspens, ce dont vous avez parlé la dernière fois.",
  "onboarding.mail.followups": "Suivre les réponses que vous attendez",
  "onboarding.mail.followupsHint":
    "Visible uniquement dans le résumé. Aucune notification séparée.",
  "onboarding.mail.voice": "Apprendre mon style d’écriture à partir des mails envoyés",
  "onboarding.mail.voiceHint":
    "Ne lit que ce que vous avez écrit, sans le texte cité ni les signatures. Cela reste sur ce Mac et vous pouvez l’afficher, le modifier ou le réinitialiser.",
  "onboarding.mail.notes": "Notes de réunion à partir d’enregistrements",
  "onboarding.mail.notesHint":
    "Ne fait rien tant que vous n’ajoutez pas d’audio. L’audio et les transcriptions ne sont jamais envoyés ni utilisés pour l’entraînement.",
  "onboarding.mail.summary":
    "{n, plural, =0 {Rien d’activé} one {# fonction activée} other {# fonctions activées}}",
  "onboarding.mail.done": "Mail et réunions",
  "onboarding.mail.doneOff": "Désactivé. Vous pouvez l’activer dans Réglages.",
  "onboarding.mail.doneOn": "{n, plural, one {# flux activé} other {# flux activés}}",
};
