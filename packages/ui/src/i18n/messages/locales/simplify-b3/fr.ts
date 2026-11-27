import type { Catalogue } from "../../index.ts";

/** Onboarding finish, recovery key and searchable switch (fr); merged into `../fr.ts`. */
export const simplifyB3: Partial<Catalogue> = {
  "onboarding.done.start": "Commencer à discuter",
  "onboarding.done.psycheLabel": "Psyche",
  "onboarding.done.psycheWait":
    "Impossible de joindre Psyche pour le moment. Cette fenêtre se reconnecte toute seule.",
  "onboarding.done.helperWait":
    "Psyche Helper n'est pas encore connecté. Le contrôle de l'ordinateur et les notifications démarreront dès qu'il le sera.",
  "onboarding.connectors.searchable": "Rendre ces comptes consultables",
  "onboarding.connectors.searchableHint":
    "{name} peut retrouver les e-mails, événements et notes de ces comptes dans la recherche. Vous pouvez en désactiver dans les réglages.",
  "home.recoveryKey.title": "Enregistrez votre clé de récupération",
  "home.recoveryKey.body":
    "C'est le seul moyen de retrouver votre coffre après une restauration ou si vous perdez la clé. Affichez-la, gardez-en une copie en lieu sûr, puis confirmez.",
  "settings.credentials.vault.recoveryKey.show": "Afficher la clé de récupération",
  "settings.credentials.vault.recoveryKey.hide": "Masquer",
  "settings.credentials.vault.recoveryKey.gone":
    "La clé de récupération de ce coffre n'a été affichée qu'à sa création et ne peut pas l'être à nouveau.",
  "settings.credentials.vault.recoveryKey.failed":
    "Impossible d'afficher la clé de récupération : {reason}",
  "settings.credentials.vault.recoveryKey.title": "Clé de récupération",
  "settings.credentials.vault.recoveryKey.body":
    "Le seul moyen de retrouver le coffre après une restauration ou si vous perdez la clé. Gardez-en une copie en lieu sûr.",
};
