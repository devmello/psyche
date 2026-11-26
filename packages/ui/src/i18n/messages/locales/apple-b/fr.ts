import type { Catalogue } from "../../index.ts";

/** Apple-design batch B (fr): plain approval cards and tool rows; merged into `../fr.ts`. */
export const appleB: Partial<Catalogue> = {
  "approvals.plain.run":
    "{who} veut exécuter `{command}`{hasFolder, select, true { dans {folder}} other {}}.",
  "approvals.plain.save":
    "{who} veut {mode, select, create {enregistrer} other {modifier}} {file}{hasFolder, select, true { dans {folder}} other {}}.",
  "approvals.plainWhy.commands":
    "Vous avez demandé à approuver les commandes avant leur exécution.",
  "approvals.plainWhy.yourRule": "Vous avez défini une règle pour demander d’abord.",
  "approvals.plainWhy.noSandbox": "Le bac à sable sécurisé n’est pas encore configuré.",
  "approvals.plainWhy.protectedFiles": "Ces fichiers sont protégés, donc Psyche demande toujours.",
  "approvals.plainWhy.push": "Publier votre travail demande toujours votre accord.",
  "approvals.plainWhy.machineFiles":
    "Modifier des fichiers sur un autre ordinateur demande toujours votre accord.",
  "approvals.plainWhy.unknownTool":
    "Cet outil vient d’un connecteur que vous n’avez pas encore approuvé.",
  "approvals.plainWhy.connector": "Ce connecteur demande avant d’agir.",
  "approvals.plainWhy.outsideNew":
    "Psyche a lu quelque chose venant de l’extérieur, et ceci est nouveau.",
  "approvals.plainWhy.outsideCommand":
    "Psyche a lu quelque chose venant de l’extérieur, et cette commande pourrait sortir de son dossier.",
  "blocks.toolRun.familyName":
    "{kind, select, command {commandes} file {fichiers} web {le web} mail {e-mail} calendar {calendrier} drive {Drive} memory {mémoire} task {tâches} other {{name}}}",
  "blocks.toolRun.spoken":
    "{kind, select, command {Commande exécutée} write {Fichier enregistré} edit {Fichier modifié} read {Fichier lu} web {Recherche sur le web} mail {E-mail utilisé} calendar {Calendrier utilisé} memory {Mémoire utilisée} other {Outil utilisé}}",
  "blocks.toolRun.line.save":
    "Enregistrer {file}{hasFolder, select, true { dans {folder}} other {}}",
};
