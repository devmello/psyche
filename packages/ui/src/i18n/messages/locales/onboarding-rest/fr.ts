import type { Catalogue } from "../../index.ts";

/** Completed onboarding strings (fr); merged into `../fr.ts`. */
export const onboardingRest: Partial<Catalogue> = {
  "onboarding.stepCount": "{n, number} sur {total, number}",
  "onboarding.connectors.onThisMac": "Sur ce Mac",
  "onboarding.connectors.onThisMacHint":
    "Chaque app demande l’autorisation à macOS lors de sa connexion, une par une.",
  "onboarding.connectors.connectApps":
    "{n, plural, =0 {Connecter des apps} one {Connecter # app} other {Connecter # apps}}",
  "onboarding.connectors.connecting": "Connexion de {name}",
  "onboarding.connectors.accounts": "Comptes",
  "onboarding.connectors.moreAccounts": "Ajouter un compte Google, Microsoft ou e-mail",
  "onboarding.step.memory": "Mémoire et habitudes quotidiennes",
  "onboarding.about.lead":
    "Quelques informations pour que Psyche vous connaisse dès le départ. Tout ici est facultatif et se trouve dans USER.md, que vous pouvez modifier à tout moment.",
  "onboarding.about.name": "Votre nom",
  "onboarding.about.nameHint": "Comment Psyche doit-il vous appeler ?",
  "onboarding.about.timeZone": "Fuseau horaire",
  "onboarding.about.timeZoneHint": "Europe/Paris",
  "onboarding.about.work": "Travail ou études",
  "onboarding.about.workHint": "Ce que vous faites, en quelques mots",
  "onboarding.about.city": "Ville de résidence",
  "onboarding.about.cityHint": "Où vous vous trouvez habituellement",
  "onboarding.memory.lead":
    "Vous avez déjà un profil dans ChatGPT ou Claude ? Collez l’export de sa mémoire, ou la réponse à « Que sais-tu sur moi ? ». Vous vérifiez tout avant l’enregistrement.",
  "onboarding.memory.unavailable":
    "L’importation n’est pas disponible dans cette fenêtre. Vous pouvez le faire plus tard dans Personnalité.",
  "onboarding.memory.format": "D’où cela provient",
  "onboarding.memory.format.chatgpt": "ChatGPT",
  "onboarding.memory.format.claude": "Claude",
  "onboarding.memory.format.text": "Autre texte",
  "onboarding.memory.paste": "Texte de mémoire",
  "onboarding.memory.placeholder": "Collez ici, ou importez un fichier .txt, .md ou .json",
  "onboarding.memory.upload": "Importer un fichier",
  "onboarding.memory.review": "Vérifier",
  "onboarding.memory.found":
    "{n, number} éléments à vérifier trouvés ({skipped, number} ignorés). Décochez tout ce que vous ne voulez pas conserver.",
  "onboarding.memory.items": "Éléments à importer",
  "onboarding.memory.flagged": "Ressemble à une instruction",
  "onboarding.memory.edit": "Retour au texte",
  "onboarding.memory.save": "Enregistrer {n, number} en mémoire",
  "onboarding.memory.saved": "{n, number} éléments enregistrés en mémoire.",
  "onboarding.memory.failed": "Cela n’a pas fonctionné ({reason}).",
  "onboarding.habits.lead":
    "De courtes cartes dans Home, le matin et le soir. Psyche ne fait que lire ; rien n’est envoyé sans votre approbation.",
  "onboarding.habits.brief": "Résumé quotidien",
  "onboarding.habits.briefHint": "Votre journée, chaque matin en semaine.",
  "onboarding.habits.wrapup": "Bilan du soir",
  "onboarding.habits.wrapupHint": "Ce qui a été fait et ce qui passe à demain.",
  "onboarding.habits.followups": "Suivi des relances",
  "onboarding.habits.followupsHint": "Repère les réponses que vous attendez encore.",
  "onboarding.rerun.title": "Reconfigurer",
  "onboarding.rerun.description":
    "Reparcourez la configuration initiale. Les étapes déjà faites sont ignorées.",
  "onboarding.rerun.button": "Relancer la configuration",
  "onboarding.step.you": "Vous et votre agent",
  "onboarding.step.stuff": "Pour quoi puis-je vous aider ?",
  "onboarding.step.safety": "Sécurité",
  "onboarding.step.folders": "Dossiers",
  "onboarding.folders.lead":
    "Laisse {name} lire tes dossiers Documents, Bureau et Téléchargements. Lecture seule : {name} peut consulter les fichiers, jamais les modifier ni les supprimer. Rien n’est partagé sans que tu coches.",
  "onboarding.folders.group": "Dossiers à partager, en lecture seule",
  "onboarding.folders.documents": "Documents",
  "onboarding.folders.desktop": "Bureau",
  "onboarding.folders.downloads": "Téléchargements",
  "onboarding.folders.hint":
    "Tu peux le changer à tout moment dans Réglages, sous Accès aux fichiers.",
  "onboarding.folders.shareLater":
    "Tu pourras partager ces dossiers plus tard dans Réglages → Accès aux fichiers.",
  "onboarding.folders.openFileAccess": "Ouvrir Accès aux fichiers",
  "onboarding.folders.retry": "Réessayer",
  "onboarding.folders.continueWithout": "Continuer sans partager",
  "onboarding.folders.failed": "Impossible de partager ces dossiers : {reason}",
  "onboarding.you.lead":
    "Tout sur cette page est facultatif, et vous pourrez le modifier plus tard.",
  "onboarding.you.agent": "Votre agent",
  "onboarding.you.customize": "Personnaliser l’apparence",
  "onboarding.you.more": "En savoir plus sur vous",
  "onboarding.restore.title": "Restaurer depuis une sauvegarde",
  "onboarding.restore.where":
    "Les sauvegardes sont dans $PSYCHE_HOME/backups. Pour restaurer sur un nouvel ordinateur, arrête le Gateway et lance :",
  "onboarding.restore.unlock": "Déverrouille ensuite le coffre avec sa clé de récupération.",
  "onboarding.memory.habitsLead":
    "Choisissez ce que {name} fait chaque jour et ce qu’il garde en mémoire. Tout peut être modifié dans Réglages.",
  "onboarding.memory.bring": "Importer la mémoire de ChatGPT ou de Claude",
  "onboarding.habits.title": "Chaque jour",
  "onboarding.work.title": "Travail et tâches",
  "onboarding.work.hint":
    "Tient une tâche pour tout ce qui a une échéance : factures, loyer, impôts, renouvellements, échéances de travail, devoirs. {persona} ne lit que les listes et dossiers que vous choisissez. Désactivé tant que vous n’avez pas dit oui.",
  "onboarding.work.remindHint":
    "Envoyé avec votre bilan du soir. Les titres n’apparaissent que pour ce que vous avez ajouté vous-même.",
  "onboarding.work.later":
    "Choisissez les listes de Rappels et les dossiers pris en compte dans Réglages → Mémoire → Travail.",
  "onboarding.people.title": "Personnes",
  "onboarding.people.label": "Inclure des personnes dans mon résumé",
  "onboarding.people.hint":
    "Des informations sur les personnes que vous connaissez et celles avec qui rester en contact. Désactivé sauf si vous l’activez.",
  "onboarding.people.needsBrief":
    "Le résumé du matin est désactivé, les personnes n’apparaîtront donc encore nulle part. Activez-le pour les voir.",
  "onboarding.safety.lead":
    "Comment les approbations vous parviennent et ce qui s’exécute seul. L’accès à vos fichiers, apps et écran n’est pas demandé ici : {name} le demande dans la discussion la première fois qu’il en a besoin.",
  "onboarding.safety.touchId": "Touch ID pour les paiements",
  "onboarding.safety.touchId.checking": "Examen de l’assistant Mac…",
  "onboarding.safety.touchId.again": "Vérifier à nouveau",
  "onboarding.safety.touchId.set": "Configurer",
  "onboarding.safety.touchId.setHint":
    "Les paiements demandent votre empreinte digitale ou le mot de passe de votre Mac.",
  "onboarding.safety.touchId.starting":
    "L’assistant Mac démarre encore. Vérifiez à nouveau dans un instant.",
  "onboarding.safety.touchId.noKey": "L’assistant Mac n’a pas de clé Touch ID ({reason}).",
  "onboarding.safety.touchId.register": "Enregistrer cette clé",
  "onboarding.safety.touchId.hint":
    "Enregistrez une seule fois la clé de l’assistant Mac pour que Touch ID puisse confirmer les paiements.",
  "onboarding.safety.notifications": "Notifications",
  "onboarding.safety.asks":
    "Si vous autorisez {name} à exécuter des commandes sur ce Mac, celles qui ne font que lire, comme ls ou cat, s’exécutent sans carte. Tout le reste vous demande d’abord.",
  "onboarding.safety.sandbox": "Configurer un bac à sable pour les commandes",
  "onboarding.safety.optional": "Facultatif",
  "onboarding.done.on": "Activé",
  "onboarding.done.off": "Désactivé",
  "onboarding.done.daily": "Quotidien",
  "onboarding.done.work": "Suivi du travail",
  "onboarding.done.people": "Personnes dans votre résumé",
  "onboarding.done.touchId": "Touch ID",
  "onboarding.done.touchIdSet": "Clé enregistrée",
  "onboarding.done.touchIdNot": "Pas encore enregistrée",
  "onboarding.done.modelKept": "Inchangé",
  "onboarding.done.try": "À essayer ensuite",
  "onboarding.done.try.search": "Poser une question dans Recherche",
  "onboarding.done.try.home": "Rattraper le retard dans Accueil",
  "onboarding.done.try.chat": "Démarrer un nouveau chat",
};
