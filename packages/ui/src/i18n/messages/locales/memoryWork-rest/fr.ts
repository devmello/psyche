import type { Catalogue } from "../../index.ts";

/** Completed memoryWork strings (fr); merged into `../fr.ts`. */
export const memoryWorkRest: Partial<Catalogue> = {
  "memoryWork.title": "Travail",
  "memoryWork.description":
    "Ce que {persona} suit pour vous : projets, tâches avec échéance et l’endroit où vous vous êtes arrêté.",
  "memoryWork.loadLabel": "mémoire du travail",
  "memoryWork.enabled.title": "Travail en mémoire",
  "memoryWork.enabled.label": "Suivre mon travail",
  "memoryWork.enabled.hint":
    "Tient une tâche pour tout ce qui a une échéance, son avancement et l’endroit où vous vous êtes arrêté. Désactivé tant que vous n’avez pas dit oui.",
  "memoryWork.enabled.off":
    "Activez pour choisir des listes de Rappels et des dossiers et configurer des rappels.",
  "memoryWork.consent.title": "Suivre votre travail en mémoire",
  "memoryWork.consent.body":
    "{persona} tiendra une tâche pour tout ce qui a une échéance (loyer, rapport de labo, présentation au conseil) et notera son avancement et l’endroit où vous vous êtes arrêté.",
  "memoryWork.consent.reads": "Ce qui est lu",
  "memoryWork.consent.r1": "Les listes de Rappels que vous choisissez et vos propres calendriers",
  "memoryWork.consent.r2": "Les fichiers des dossiers que vous liez à un projet",
  "memoryWork.consent.r3":
    "Vos e-mails envoyés et les e-mails des fils que vous liez, ainsi que vos discussions avec {persona}",
  "memoryWork.consent.keeps": "Ce qui reste garanti",
  "memoryWork.consent.k1":
    "Rien ne quitte ce Mac. Les dates et statuts sont déterminés par du code.",
  "memoryWork.consent.k2":
    "Le texte d’autres personnes ne modifie jamais une échéance ni un statut.",
  "memoryWork.consent.k3":
    "Le travail apparaît dans Home et dans votre résumé quotidien. Modifiez cela sous Où la mémoire s’affiche.",
  "memoryWork.consent.cancel": "Pas maintenant",
  "memoryWork.consent.confirm": "Activer",
  "memoryWork.lists.title": "Listes de Rappels",
  "memoryWork.lists.description":
    "Un rappel avec échéance dans une liste suivie devient une tâche dans le projet choisi. Les autres listes ne sont pas touchées. Seules les listes que vous marquez comme les vôtres dans Connecteurs peuvent marquer des éléments comme terminés.",
  "memoryWork.lists.none": "Non suivie",
  "memoryWork.lists.pick": "Projet pour {list}",
  "memoryWork.lists.missing": "Une liste qui n’existe plus dans Rappels",
  "memoryWork.lists.shared": "Liste partagée",
  "memoryWork.lists.empty": "Aucune liste de Rappels pour l’instant.",
  "memoryWork.lists.noProjects": "Ajoutez un projet sur la page Mémoire, puis choisissez-le ici.",
  "memoryWork.lists.openMemory": "Ouvrir Mémoire",
  "memoryWork.lists.loading": "Lecture de vos listes de Rappels…",
  "memoryWork.folders.title": "Dossiers",
  "memoryWork.folders.anchored": "Uniquement les dossiers liés à un projet",
  "memoryWork.folders.anchoredHint":
    "Liez un dossier depuis la page d’un projet. Quand le nom d’un dossier correspond à un projet, {persona} le suggère.",
  "memoryWork.folders.all": "Tout dossier que {persona} peut lire, associé par nom",
  "memoryWork.folders.allHint":
    "Un dossier dont le nom correspond à un projet est lié sans demander. Seuls les noms et les dates sont lus.",
  "memoryWork.remind.title": "Rappels pour terminer les choses",
  "memoryWork.remind.description":
    "Les notifications sont désactivées tant que vous ne les activez pas. Elles ne viennent jamais pendant les heures calmes.",
  "memoryWork.remind.enabled": "Me rappeler ce qui est à rendre demain",
  "memoryWork.remind.enabledHint":
    "Une notification par jour à l’heure du bilan, pour ce qui est à rendre dans {hours, plural, one {l’heure} other {les # prochaines heures}} à venir.",
  "memoryWork.remind.hours": "Jusqu’où chercher à l’avance",
  "memoryWork.remind.hoursOption": "{hours, plural, one {# heure} other {# heures}}",
  "memoryWork.remind.at": "Quand",
  "memoryWork.remind.atWrapup": "À l’heure de votre bilan, {time}",
  "memoryWork.remind.atHint":
    "Défini dans Quotidien. Les titres n’apparaissent que pour ce que vous avez ajouté vous-même.",
  "memoryWork.remind.openDaily": "Ouvrir Quotidien",
  "memoryWork.remind.dayOf": "Me dire aussi le matin ce qui est à rendre aujourd’hui",
  "memoryWork.remind.dayOfHint":
    "Une seconde notification après le résumé du matin : « À rendre aujourd’hui : … ».",
  "memoryWork.remind.needsWrapup":
    "Le bilan du soir est désactivé, rien ne sera donc envoyé. Activez-le pour recevoir ceci.",
  "memoryWork.remind.needsBrief":
    "Le résumé du matin est désactivé, rien ne sera donc envoyé. Activez-le pour recevoir ceci.",
  "memoryWork.remind.turnOnWrapup": "Activer le bilan du soir",
  "memoryWork.remind.turnOnBrief": "Activer le résumé du matin",
};
