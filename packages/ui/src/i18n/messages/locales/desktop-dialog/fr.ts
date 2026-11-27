import type { Catalogue } from "../../index.ts";

/** Native dialogs and notifications (fr); merged into `../fr.ts`. */
export const desktopDialog: Partial<Catalogue> = {
  "desktop.dialog.notificationsOn": "Les notifications sont activées.",
  "desktop.dialog.anotherCopyTitle": "Une autre copie de Psyche est déjà en cours d’exécution",
  "desktop.dialog.anotherCopyDetail":
    "Elle s’exécute depuis {path}. Utiliser cette copie fait basculer Psyche vers cette app ; l’autre copie se connectera alors à celle-ci.",
  "desktop.dialog.keepOtherCopy": "Garder l’autre copie",
  "desktop.dialog.useThisCopy": "Utiliser cette copie",
  "desktop.dialog.cancel": "Annuler",
  "desktop.dialog.ok": "OK",
  "desktop.dialog.shareFolderTitle": "Partager un dossier avec Psyche",
  "desktop.dialog.share": "Partager",
  "desktop.dialog.gatewaysFileTitle": "Psyche ne peut pas lire ses Gateways enregistrés",
  "desktop.dialog.gatewaysFileDetail":
    "{problem}. Psyche démarre sur {os, select, macos {ce Mac} windows {ce PC} other {cet ordinateur}} et laisse le fichier intact, pour qu’aucune identité épinglée ne soit perdue. Corrigez ou supprimez le fichier dans le dossier de données de Psyche pour utiliser le Gateway d’un autre ordinateur.",
  "desktop.dialog.stillRunningTitle": "Psyche est toujours en cours d’exécution",
  "desktop.dialog.stillRunningBody":
    "Les tâches et les automatisations continuent. Ouvrez Psyche depuis son icône dans la zone de notification ; faites un clic droit dessus pour quitter.",
  "desktop.dialog.manualStepsTitle": "Une étape de plus pour finir de supprimer Psyche",
  "desktop.dialog.uninstallTitle": "Désinstaller Psyche ?",
  "desktop.dialog.uninstall": "Désinstaller",
  "desktop.dialog.uninstallAndDelete": "Supprimer les données et désinstaller",
  "desktop.dialog.uninstallItems":
    "{count, plural, one {# élément sera déplacé} other {# éléments seront déplacés}} dans la corbeille, y compris Psyche.app.",
  "desktop.dialog.uninstallDataFolder":
    "Votre dossier de données {folder} sera aussi déplacé dans la corbeille.",
  "desktop.dialog.uninstallDataKept": "Votre dossier de données est conservé.",
  "desktop.dialog.uninstallKeychain":
    "Les éléments du trousseau que Psyche conserve seront supprimés.",
  "desktop.dialog.uninstallKeychainKept":
    "Les éléments du trousseau restent ; supprimez-les dans Accès aux trousseaux si vous le souhaitez.",
  "desktop.dialog.stopTitle":
    "Arrêter Psyche sur {os, select, macos {ce Mac} windows {ce PC} other {cet ordinateur}} ?",
  "desktop.dialog.stopDetail":
    "Ses automatisations et tâches planifiées s’arrêtent jusqu’à ce que vous reveniez. Laissez-le tourner pour qu’elles continuent.",
  "desktop.dialog.stopButton":
    "Arrêter Psyche sur {os, select, macos {ce Mac} windows {ce PC} other {cet ordinateur}}",
  "desktop.dialog.keepRunning": "Le laisser tourner",
  "desktop.dialog.forgetTitle": "Oublier {name} ?",
  "desktop.dialog.forgetDetail":
    "{origin}\n\nCela supprime la clé de cet ordinateur pour ce Gateway et tout ce que Psyche y a stocké. {name} affiche encore cet ordinateur tant que quelqu’un ne l’a pas retiré là-bas.",
  "desktop.dialog.forgetButton": "Oublier",
  "desktop.dialog.repairTitle": "Rejumeler avec {name} ?",
  "desktop.dialog.repairDetail":
    "{origin}\n\nCela oublie l’identité que Psyche avait épinglée pour lui et la clé de cet ordinateur ; la prochaine connexion épingle donc ce qui répond à cette adresse et demande un appairage comme nouvel ordinateur. Ne faites cela que si vous savez pourquoi son identité a changé.",
  "desktop.dialog.repairButton": "Rejumeler",
  "desktop.dialog.claimTitle": "Configurer le serveur Psyche sur {origin} ?",
  "desktop.dialog.claimDetail":
    "Psyche vérifie que le serveur connaît le code de configuration que vous avez saisi avant de lui faire confiance, et le serveur vérifie que cet ordinateur le connaît avant d’en faire l’administrateur. Continuez seulement si vous venez d’installer ce serveur vous-même.",
  "desktop.dialog.setUp": "Configurer",
  "desktop.dialog.addLanTitle": "{origin} est-il un Psyche de ce réseau ?",
  "desktop.dialog.addLanDetail":
    "Nom : {name}\n\nUn Psyche de ce réseau utilise son propre certificat, que Psyche épingle au lieu de faire confiance à celui du système : il vérifie le certificat et la clé du Gateway à la première connexion, puis refuse tout autre. Choisissez « Https simple » seulement pour un serveur avec un certificat ordinaire (par exemple un proxy inverse avec votre propre autorité). Rien n’est partagé tant que son propriétaire n’a pas approuvé cet ordinateur là-bas.",
  "desktop.dialog.psycheOnNetwork": "Psyche de ce réseau",
  "desktop.dialog.plainHttps": "Https simple",
  "desktop.dialog.addLinkTitleLan": "Connecter Psyche à {origin} sur ce réseau ?",
  "desktop.dialog.addLinkTitle": "Connecter Psyche à {origin} ?",
  "desktop.dialog.addLinkDetail":
    "{external, select, yes {Ce lien a été ouvert par une autre app ou un site web, il n’a pas été collé par vous. Continuez seulement si vous l’avez créé vous-même sur {os, select, macos {le Mac} windows {le PC} other {l’ordinateur}} qui fait tourner Psyche.\n\n} other {}}Psyche ne se connectera que si ce Gateway prouve cette identité :\n{fingerprint}\n\n{lan, select, yes {Il utilise son propre certificat, et non un certificat approuvé par le système. Psyche le maintient à celui que ce lien indique ({pin}…) avant d’envoyer quoi que ce soit, et refuse tout autre. Continuez seulement si le lien vient de votre propre {os, select, macos {Mac} windows {PC} other {ordinateur}} sur ce réseau.\n\n} other {}}Le code à usage unique du lien permet ensuite à ce Gateway d’approuver cet ordinateur sans redemander, avec l’accès choisi par son propriétaire à sa création.",
  "desktop.dialog.addDetailKey":
    "Nom : {name}\nClé annoncée : {key}…\n\nCet ordinateur demandera à ce Gateway de s’appairer. Rien n’est partagé tant que son propriétaire n’a pas approuvé cet ordinateur là-bas, et Psyche épingle l’identité du Gateway à la première connexion.",
  "desktop.dialog.addDetailPlain":
    "Nom : {name}\n\nCet ordinateur demandera à ce Gateway de s’appairer. Rien n’est partagé tant que son propriétaire n’a pas approuvé cet ordinateur là-bas, et Psyche épingle l’identité du Gateway à la première connexion.",
  "desktop.dialog.addGatewayButton": "Ajouter le Gateway",
};
