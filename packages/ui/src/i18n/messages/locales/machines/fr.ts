import type { Catalogue } from "../../index.ts";

/** Computers Psyche can use (fr); merged into `../fr.ts`. */
export const machines: Partial<Catalogue> = {
  "machines.title": "Ordinateurs que Psyche peut utiliser",
  "machines.description":
    "Ordinateurs Linux que tu as associés pour que Psyche y utilise des apps, des commandes et des fichiers pendant que tu continues d'utiliser celui-ci.",
  "machines.empty":
    "Donne à Psyche un ordinateur Linux pour travailler, afin qu'il y utilise des apps, des commandes et des fichiers pendant que tu continues d'utiliser celui-ci.",
  "machines.add": "Ajouter un ordinateur Linux",
  "machines.add.description":
    "Psyche travaille sur cet ordinateur pendant que tu continues d'utiliser celui-ci. Les actions là-bas suivent tes réglages d'approbation.",
  "machines.add.account": "Quel compte Psyche doit-il utiliser là-bas ?",
  "machines.add.account.own": "Ton compte (recommandé)",
  "machines.add.account.ownHint":
    "Psyche peut y utiliser tes fichiers, tes apps et tes connexions, comme toi. Il n'obtient jamais root.",
  "machines.add.account.dedicated": "Un compte psyche séparé",
  "machines.add.account.dedicatedHint":
    "Psyche ne voit que les fichiers et les apps de ce compte. Il n'a ni sudo ni mot de passe.",
  "machines.add.needsNetwork":
    "Les autres ordinateurs ne peuvent pas encore joindre celui-ci. Active d'abord l'accès à distance ou l'accès par le réseau local dans Réglages → Serveur et accès à distance.",
  "machines.add.make": "Afficher les commandes",
  "machines.add.again": "Créer de nouvelles commandes",
  "machines.add.commands": "Commandes pour l'ordinateur Linux",
  "machines.add.installStep": "1. Sur l'ordinateur Linux, installe l'assistant",
  "machines.add.pairStep": "2. Lance l'association là-bas",
  "machines.add.expires": "Le lien ne marche qu'une fois et expire {when}.",
  "machines.add.waiting": "En attente de l'association de l'ordinateur…",
  "machines.add.paired": "{name} est associé. Psyche peut l'utiliser.",
  "machines.add.pairedToast": "{name} a été ajouté",
  "machines.add.done": "Terminé",
  "machines.copy": "Copier",
  "machines.status.online": "En ligne",
  "machines.status.offline": "Hors ligne",
  "machines.status.degraded": "Demande de l'attention",
  "machines.display.headless": "Écran privé",
  "machines.display.desktopSession": "Son propre bureau",
  "machines.display.container": "Conteneur",
  "machines.thisComputer": "Cet ordinateur",
  "machines.watch": "Observer",
  "machines.watchNamed": "Observer {name}",
  "machines.apps": "Accès aux apps",
  "machines.appsNamed": "Accès aux apps sur {name}",
  "machines.folders": "Dossiers",
  "machines.foldersNamed": "Dossiers sur {name}",
  "machines.rename.action": "Renommer",
  "machines.rename.named": "Renommer {name}",
  "machines.rename.label": "Nouveau nom pour {name}",
  "machines.rename.save": "Enregistrer",
  "machines.rename.cancel": "Annuler",
  "machines.remove": "Retirer",
  "machines.removeTitle": "Retirer {name} ?",
  "machines.removeDescription":
    "Psyche cesse tout de suite d'utiliser {name} et son association est révoquée. Pour le réutiliser, associe-le de nouveau.",
  "machines.err.nameTaken":
    "Un autre ordinateur porte déjà ce nom, ou il est réservé. Choisis-en un autre.",
  "machines.err.nameInvalid":
    "Ce nom n'est pas possible. Utilise des lettres, des chiffres et des signes ordinaires, 64 caractères au plus, sans mélanger des lettres qui se ressemblent.",
  "machines.err.forbidden":
    "Renommer demande un appareil administrateur. Réessaie depuis l'un d'eux.",
  "machines.err.failed": "Cela n'a pas fonctionné ({reason}). Rien n'a changé.",
  "machines.account.own":
    "Fonctionne avec ton propre compte sur {name}. Psyche peut y utiliser tes fichiers, tes apps et tes connexions, comme toi. Si ton Psyche était un jour compromis, un attaquant le serait aussi, sauf pour root, que Psyche n'obtient jamais.",
  "machines.account.dedicated":
    "Fonctionne avec un compte séparé sur {name}. Psyche ne voit que les fichiers et les apps de ce compte.",
  "machines.account.useSeparate": "Utiliser plutôt un compte séparé…",
  "machines.account.useSeparateHint":
    "Sur {name}, relance l'installateur avec l'option de compte séparé, puis associe-le de nouveau :",
  "machines.shell.contained": "Les commandes s'exécutent dans un shell isolé",
  "machines.shell.full": "Les commandes s'exécutent dans le shell complet du compte",
  "machines.shell.off": "Les commandes sont désactivées",
  "machines.limits.folders":
    "{count, plural, =0 {Aucun dossier accordé} one {# dossier accordé} other {# dossiers accordés}}",
  "machines.helperVersion": "Assistant {version}",
  "machines.helperVersionUnknown": "Version de l'assistant inconnue",
  "machines.update":
    "Un assistant plus récent est disponible. Mets à jour l'assistant sur {name} :",
  "machines.warnings": "Avertissements pour {name}",
  "machines.warn.fullShell":
    "Shell complet du compte. Les commandes ne sont pas isolées : elles atteignent tout ce que ce compte atteint.",
  "machines.warn.userLimits":
    "Les limites appartiennent à l'utilisateur. Tout programme exécuté avec ce compte peut changer ce que Psyche peut faire sur {name}.",
  "machines.warn.sudo":
    "Ce compte a sudo sans mot de passe. Psyche ne peut pas utiliser sudo ici, mais d'autres programmes lancés avec ce compte le peuvent.",
  "machines.paired": "Associé {when}",
  "machines.line": "Sur « {name} » · Linux · {place}",
  "machines.place.screen": "écran privé",
  "machines.place.desktop": "son bureau",
  "machines.place.command": "commande",
  "machines.place.files": "fichiers",
  "machines.step.on": "{label} sur {name}",
  "machines.picker.title": "Ordinateurs",
  "machines.picker.description":
    "Choisis l'ordinateur concerné par ces réglages, et où Psyche travaille quand tu n'en observes aucun en particulier.",
  "machines.picker.show": "Afficher l'accès aux apps de",
  "machines.picker.default": "Ordinateur par défaut pour le travail en arrière-plan",
  "machines.picker.defaultHint":
    "Les tâches et automatisations s'y exécutent sauf si elles nomment un ordinateur. Choisis un ordinateur Linux pour que Psyche travaille là-bas pendant que tu travailles ici.",
  "machines.picker.appsOn": "Apps sur {name}",
  "machines.picker.appsHint":
    "Psyche les synchronise avec {name} et ne dépasse jamais les limites propres de cet ordinateur.",
  "machines.picker.noApps":
    "Psyche n'a pas encore vu d'apps sur {name}. Elles apparaîtront ici dès qu'il en aura vu.",
  "machines.picker.offline":
    "{name} est hors ligne. Les changements l'atteindront à sa reconnexion.",
  "computerWatch.titleMachine": "{name} · écran privé",
  "computerWatch.machineOffline": "Impossible de joindre {name}. Nouvel essai…",
  "computerWatch.empty.bodyMachine":
    "Quand l'agent aura besoin d'un écran sur {name}, tu pourras le regarder ici.",
  "notice.machine.working.title": "Psyche travaille sur {name}",
  "notice.machine.working.body":
    "Il utilise l'écran, les apps ou les fichiers de cet ordinateur. Observe-le depuis Réglages → Appareils.",
  "notice.machine.offline.title": "{name} est passé hors ligne",
  "notice.machine.offline.body":
    "Psyche ne peut pas l'utiliser avant sa reconnexion. Les tâches qui en ont besoin t'attendent.",
  "machines.add.linkStep": "3. Quand il demande le lien, colle celui-ci",
  "machines.add.installSource":
    "Récupère le paquet de l'assistant sur {url}, décompresse-le, puis exécute ceci sur l'ordinateur Linux.",
  "machines.reports": "{name} signale :",
  "computerWatch.machineLoading": "Chargement de l'ordinateur…",
  "computerWatch.machineMissing": "Cet ordinateur n'est pas disponible.",
  "settings.key.computerUse.defaultMachine":
    "Ordinateur par défaut pour le travail en arrière-plan",
  "settings.key.computerUse.machineApps": "Accès aux apps sur un ordinateur Linux",
  "machines.card.folder": "Dossier",
  "machines.card.runsContained":
    "isolé, dans le dossier accordé seulement : ni clés, ni profils de navigateur, ni autres dossiers",
  "machines.card.runsFullAccount":
    "avec le compte complet : il peut faire tout ce que ce compte peut faire",
  "machines.card.networkOff": "désactivé",
  "machines.card.networkOn": "activé",
  "machines.card.folderReadOnly": "{path}, lecture seule",
  "machines.card.folderReadWrite": "{path}, lecture et écriture",
  "machines.card.folderNotEnforced":
    "{path}, la lecture seule n'est pas appliquée avec le compte complet",
};
