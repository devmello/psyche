import type { Catalogue } from "../../index.ts";

/** Completed nudges strings (fr); merged into `../fr.ts`. */
export const nudgesRest: Partial<Catalogue> = {
  "nudges.kind": "Rester en contact",
  "nudges.draftReply": "Rédiger une réponse",
  "nudges.draftMessage": "Rédiger un message",
  "nudges.snooze": "Reporter",
  "nudges.snoozeWeek": "D’une semaine",
  "nudges.snoozeMonth": "D’un mois",
  "nudges.mutePerson": "Pas cette personne",
  "nudges.done": "Terminé",
  "nudges.overdue": "En retard",
  "nudges.moreActions": "Autres façons de mettre de côté : {name}",
  "nudges.result.done": "Marqué comme terminé.",
  "nudges.result.snooze_week": "Reporté d’une semaine.",
  "nudges.result.snooze_month": "Reporté d’un mois.",
  "nudges.result.mute_person":
    "Plus de rappels pour {name}. Vous pouvez les réactiver depuis sa page.",
  "nudges.gone": "Plus rien à faire ici.",
  "nudges.failed": "Cela n’a pas été enregistré : {reason}",
  "nudges.draft.unanswered":
    "Aide-moi à répondre à {name}. Son dernier {channel, select, mail {e-mail} other {message}} m’a été adressé il y a {days} jours et je n’ai pas répondu. Regarde la conversation, puis rédige une courte réponse que je pourrai relire. N’envoie rien.",
  "nudges.draft.drift":
    "Je n’ai pas parlé à {name} depuis un moment. Rédige un court message chaleureux que je pourrais envoyer pour reprendre contact. N’envoie rien.",
  "nudges.draft.birthday":
    "Le jour spécial de {name} approche ({date}). Rédige un court message chaleureux que je pourrais envoyer. N’envoie rien.",
  "nudges.draft.promise":
    "{text} Aide-moi à relancer : rédige un court message à {name} à ce sujet. N’envoie rien.",
  "nudges.starters.title": "Sujets à aborder",
  "nudges.draft.starters":
    "Sujets que je pourrais aborder, d’après ce que Psyche a en mémoire (utilise uniquement ceux-ci et n’invente rien d’autre) :",
  "nudges.settings.phrasing": "Reformuler les suggestions avec mon modèle",
  "nudges.settings.phrasingHint":
    "Utilise le modèle choisi pour la mémoire Tout afin de les formuler plus aimablement. Désactivé par défaut.",
  "nudges.person.title": "Rester en contact",
  "nudges.person.none": "Rien à relancer.",
  "nudges.person.muted": "Les rappels pour {name} sont désactivés.",
  "nudges.person.unmute": "Réactiver les rappels",
  "nudges.settings.title": "Rester en contact",
  "nudges.settings.description":
    "De doux rappels concernant les personnes avec qui vous avez perdu le contact, les anniversaires et les promesses que vous avez faites.",
  "nudges.settings.enabled": "Me rappeler de rester en contact",
  "nudges.settings.enabledHint":
    "Jusqu’à trois dans votre résumé du matin, et des cartes discrètes dans Feed. Rien n’est jamais envoyé à votre place.",
  "nudges.settings.sensitivity": "Fréquence",
  "nudges.settings.sensitivityHint":
    "Combien de temps un message attend avant que Psyche ne dise quelque chose.",
  "nudges.settings.low": "Discret",
  "nudges.settings.normal": "Normal",
  "nudges.settings.high": "Assidu",
  "nudges.settings.quietHours":
    "Les cartes attendent la fin des heures calmes définies dans Réglages → Général → Notifications.",
  "nudges.consent.title": "Activer les rappels relationnels ?",
  "nudges.consent.body":
    "Psyche examinera la date de votre dernier échange avec les personnes avec qui vous correspondez (uniquement les dates, pas le contenu), les anniversaires que vous avez confirmés et les promesses que vous avez faites dans vos propres mots.",
  "nudges.consent.rules":
    "Les personnes exclues n’apparaissent jamais, les informations sensibles ne sont jamais utilisées, et un rappel tient en une phrase simple avec un nom et un nombre de jours. Vous pouvez mettre n’importe qui en sourdine avec Pas cette personne et tout désactiver à tout moment.",
  "nudges.consent.confirm": "Activer",
  "nudges.consent.cancel": "Pas maintenant",
};
