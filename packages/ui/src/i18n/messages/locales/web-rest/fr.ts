import type { Catalogue } from "../../index.ts";

/** Completed web strings (fr); merged into `../fr.ts`. */
export const webRest: Partial<Catalogue> = {
  "web.remotePresence.title": "Touch ID pour les approbations",
  "web.remotePresence.description":
    "Les achats, saisies d’identifiants, commandes de l’hôte et modifications de sécurité exigent Touch ID. Configurez-le sur cet ordinateur pour y répondre ici ; d’ici là, ces cartes indiquent de répondre sur {host}. Les approbations ordinaires n’en ont jamais besoin.",
  "web.remotePresence.on": "Touch ID est activé pour les approbations depuis cet ordinateur.",
  "web.remotePresence.off": "Touch ID n’est pas configuré sur cet ordinateur.",
  "web.remotePresence.enable": "Utiliser Touch ID pour les approbations sur cet ordinateur",
  "web.remotePresence.disable": "Désactiver",
  "web.remotePresence.waiting": "En attente de Touch ID…",
  "web.remotePresence.passkeyName": "Touch ID sur cet ordinateur",
  "web.remotePresence.enabled": "Touch ID est activé pour les approbations depuis cet ordinateur.",
  "web.remotePresence.disabled": "Touch ID pour les approbations est désactivé sur cet ordinateur.",
  "web.remotePresence.approveOnHost":
    "Approuvez « Ajouter une clé d’accès » sur {host}, avec Touch ID ou une clé d’accès, puis appuyez de nouveau sur le bouton.",
  "web.remotePresence.unavailable":
    "Touch ID nécessite la Gateway de {host} à une adresse https:// (gateway.publicOrigin). D’ici là, répondez à ces cartes sur {host}.",
  "web.touchId.helperDidNotStart":
    "Psyche Helper ne s’est pas connecté. Ouvrez Réglages → Appareils pour en voir la raison, puis réessayez.",
  "web.panes.title.sidechat": "Discussion annexe",
  "web.sideChat.about": "Discussion annexe sur {parent}",
  "web.sideChat.aside": "Discussion annexe",
  "web.sideChat.expand": "Agrandir",
  "web.sideChat.expandTitle": "Ouvrir cette discussion en plein écran",
  "web.terminal.ended": "session terminée",
  "web.terminal.waitingApproval": "En attente de votre approbation…",
  "web.terminal.approvalDenied": "Le terminal n’a pas été approuvé.",
  "web.terminal.approvalTimedOut": "L’approbation n’est pas arrivée à temps. Rouvrez le terminal.",
  "web.terminal.openOnHost": "Ouvrez le terminal sur {host}.",
  "web.terminal.limit":
    "Trop de terminaux sont ouverts sur {host}. Fermez-en un pour en ouvrir un autre.",
  "web.approval.folderNone": "Aucun dossier choisi",
  "web.approval.folderChoose": "Choisir un dossier…",
  "web.approval.messageText": "Texte du message, modifiable avant l’envoi",
  "web.approval.messageWeak": "SMS/RCS : identité faible, à vérifier",
  "web.approval.messageUntrusted":
    "Ce destinataire a été suggéré par un contenu lu par Psyche, pas par vous. Vérifiez-le avant d’envoyer.",
  "web.approval.folderPath": "Chemin du dossier",
  "web.approval.folderPickTitle": "Partager un dossier",
  "web.browser.stay.question": "Rester connecté à {site} ?",
  "web.browser.stay.detail":
    "Psyche conserve cette connexion dans son profil de navigateur pour que les tâches puissent l’utiliser. Tous les autres sites restent déconnectés.",
  "web.browser.stay.yes": "Rester connecté",
  "web.browser.prompt.notNow": "Pas maintenant",
  "web.browser.vault.question": "Enregistrer l’identifiant dans le coffre de Psyche ?",
  "web.browser.vault.account": "{username} sur {origin}",
  "web.browser.vault.passwordLabel": "Mot de passe",
  "web.browser.vault.save": "Enregistrer l’identifiant",
  "web.browser.vault.never": "Jamais pour ce site",
  "web.browser.vault.error":
    "Impossible d’enregistrer l’identifiant ({code}). Déverrouillez le coffre et réessayez.",
  "web.chat.autoUnavailable":
    "Auto n’est pas disponible : {model} ne figure pas sur la liste d’autorisation du mode Auto. Choisissez un autre modèle pour l’utiliser.",
  "web.toast.threadUpdateFailed": "Psyche n’a pas pu modifier ce réglage de la discussion.",
  "web.splash.remote.finding": "Recherche de {host}…",
  "web.splash.remote.checking": "Vérification qu’il s’agit bien de {host}…",
  "web.splash.remote.waiting": "En attente d’approbation sur {host}…",
  "web.splash.remote.pairCode": "Code de jumelage {code}",
  "web.splash.remote.pairKey": "Clé de la Gateway {fingerprint}",
  "web.splash.remote.pairHint":
    "Comparez les deux avec la demande dans Réglages → Appareils sur {host}, puis approuvez-la là-bas.",
  "web.splash.remote.pairHintLan":
    "Comparez la clé complète avec celle de Réglages → Appareils sur {host}, sous la demande de cet ordinateur. Sur un réseau, la clé est la seule preuve de l’identité de celui qui a répondu. N’approuvez que si elles correspondent.",
  "web.splash.remote.unreachable": "{host} ne répond pas.",
  "web.splash.remote.unreachableReason":
    "Il est peut-être en veille ou éteint, Psyche n’y est peut-être pas lancé, ou Tailscale est peut-être désactivé sur cet ordinateur. Psyche continue d’essayer.",
  "web.splash.remote.identity": "Ce n’est pas le {host} avec lequel vous êtes jumelé.",
  "web.splash.remote.identityChanged":
    "Sa clé d’identité n’est pas celle que cet ordinateur a épinglée. Une autre machine répond peut-être à sa place, ou il a été reconfiguré.",
  "web.splash.remote.identityMissing":
    "Il n’a présenté aucune clé d’identité, Psyche ne se connectera donc pas.",
  "web.splash.remote.identityInvalid":
    "Sa preuve d’identité n’a pas été validée, Psyche ne se connectera donc pas.",
  "web.splash.remote.identityOrigin":
    "Il a répondu pour une adresse différente de celle que cet ordinateur a composée. Sur {host}, définissez l’adresse publique dans Réglages → Appareils → Serveur et accès à distance.",
  "web.splash.remote.certChanged":
    "Son certificat réseau n’est pas celui que cet ordinateur a épinglé. Une autre machine de ce réseau répond peut-être à sa place, ou son certificat a été remplacé.",
  "web.splash.remote.certMissing":
    "Il n’a pas garanti le certificat utilisé, Psyche ne se connectera donc pas.",
  "web.splash.remote.certInvalid":
    "Sa preuve pour le certificat utilisé n’a pas été validée, Psyche ne se connectera donc pas.",
  "web.splash.remote.olderHost": "{host} exécute une version plus ancienne de Psyche.",
  "web.splash.remote.olderHostReason": "Mettez Psyche à jour sur {host}, puis réessayez.",
  "web.splash.remote.olderApp": "Cette app est plus ancienne que {host}.",
  "web.splash.remote.olderAppReason": "Mettez Psyche à jour sur cet ordinateur, puis réessayez.",
  "web.splash.remote.revoked": "Cet ordinateur a été retiré de {host}.",
  "web.splash.remote.revokedReason": "Jumelez-le à nouveau pour l’utiliser d’ici, ou oubliez-le.",
  "web.splash.remote.tokenRefused": "{host} a refusé ce lien de jumelage.",
  "web.splash.remote.tokenRefusedReason":
    "Il a déjà été utilisé, a expiré ou a été révoqué. Créez-en un nouveau sur {host} et ajoutez-le à nouveau.",
  "web.splash.remote.switch": "Changer de Gateway",
  "web.splash.remote.useThisMac": "Utiliser ce Mac",
  "web.splash.remote.pairAgain": "Oublier et jumeler à nouveau",
  "web.splash.remote.forget": "Oublier {host}",
  "web.splash.remote.close": "Masquer",
  "web.remote.connectedTo": "Connecté à {host}",
  "web.remote.switch": "Changer…",
  "web.remote.thisMac": "Ce Mac",
  "web.remote.menuLabel": "Gateway",
  "web.remote.switcherLabel": "Connecté à {host}. Changer de Gateway.",
  "web.remote.manage": "Gateways…",
  "web.panes.title.terminalOn": "Terminal sur {host}",
  "web.panes.terminalRemote":
    "Le terminal s’exécute sur {host}. Cette fenêtre n’y a pas encore de shell.",
  "web.splash.remote.pinsUnreadable": "Psyche ne peut pas lire ses Gateways enregistrées.",
  "web.splash.remote.pinsUnreadableReason":
    "Le fichier qui mémorise l’identité de chaque Gateway est illisible, Psyche ne se connectera donc pas sans lui. Rien n’a été modifié.",
  "web.browser.remote": "Le navigateur s’exécute sur {host}.",
  "web.browser.remoteHint":
    "Les tâches de navigateur continuent de s’exécuter dans Psyche sur {host}, qui doit y rester ouvert.",
  "web.teach.record": "Enregistrer",
  "web.teach.recordHint": "Montrer à Psyche comment faire quelque chose dans cet onglet",
  "web.teach.agentTab": "L’agent utilise cet onglet. Ouvrez votre propre onglet pour enregistrer.",
  "web.teach.startFailed": "Psyche n’a pas pu démarrer l’enregistrement de cet onglet.",
  "web.teach.bar.title": "Enregistrement",
  "web.teach.bar.body":
    "Psyche note vos clics et saisies dans cet onglet uniquement. Les mots de passe, numéros de carte et codes ne sont jamais enregistrés, et rien ne quitte ce Mac avant que vous n’enregistriez.",
  "web.teach.bar.steps": "{count, plural, one {# étape} other {# étapes}} jusqu’ici",
  "web.teach.bar.stop": "Arrêter l’enregistrement",
  "web.teach.bar.cancel": "Abandonner",
  "web.teach.bar.endedLimit":
    "L’enregistrement s’est arrêté à la limite de 200 étapes. Vérifiez ce qui a été capturé.",
  "web.teach.bar.endedInterrupted":
    "L’enregistrement s’est terminé prématurément car l’onglet a changé ou a été fermé. Vérifiez ce qui a été capturé.",
  "web.teach.bar.review": "Vérifier",
  "web.teach.stopFailed": "Psyche n’a pas pu terminer l’enregistrement.",
  "web.teach.nothingRecorded": "Rien n’a été enregistré.",
  "web.teach.review.keepUnavailable":
    "Indisponible : le trousseau de ce Mac n’est pas disponible pour chiffrer un enregistrement conservé.",
  "web.teach.kept.title": "Enregistrements conservés",
  "web.teach.kept.open": "Ouvrir",
  "web.teach.kept.delete": "Supprimer",
  "web.teach.kept.deleted": "Enregistrement supprimé.",
  "web.teach.kept.failed": "Psyche n’a pas pu ouvrir cet enregistrement.",
  "web.teach.review.title": "Vérifier ce que vous avez montré",
  "web.teach.review.intro":
    "Voici les étapes que Psyche a capturées, en langage courant. Corrigez-les, réordonnez-les ou supprimez-les. Rien n’est enregistré tant que vous n’appuyez pas sur Enregistrer.",
  "web.teach.review.name": "Comment l’appeler ?",
  "web.teach.review.namePlaceholder": "Exporter le rapport de facturation hebdomadaire",
  "web.teach.review.skipped":
    "{count, plural, one {La page a changé d’elle-même # fois pendant l’enregistrement. Cela est ignoré.} other {La page a changé d’elle-même # fois pendant l’enregistrement. Cela est ignoré.}}",
  "web.teach.review.steps": "Étapes",
  "web.teach.review.stepNumber": "Étape {n}",
  "web.teach.review.moveUp": "Monter l’étape {n}",
  "web.teach.review.moveDown": "Descendre l’étape {n}",
  "web.teach.review.remove": "Supprimer l’étape {n}",
  "web.teach.review.empty":
    "Toutes les étapes ont été supprimées. Annulez ou enregistrez à nouveau.",
  "web.teach.review.sensitive":
    "Non enregistré. Psyche vous passera l’onglet pour que vous fassiez cette partie vous-même.",
  "web.teach.review.value": "Quoi saisir",
  "web.teach.review.value.ask": "Me demander à chaque fois",
  "web.teach.review.value.keep": "Conserver cette valeur",
  "web.teach.review.value.input": "En faire une entrée",
  "web.teach.review.valueHidden":
    "L’exemple que vous avez saisi est masqué et ne sera pas enregistré.",
  "web.teach.review.valueKept": "Enregistré avec la compétence : {value}",
  "web.teach.review.inputName": "Nom de l’entrée",
  "web.teach.review.inputDescription": "Ce que c’est",
  "web.teach.review.inputDescriptionPlaceholder": "Le premier jour de la semaine",
  "web.teach.review.keepRecording":
    "Conserver cet enregistrement sur ce Mac pour pouvoir en créer une autre version",
  "web.teach.review.keepRecordingHint":
    "Seules les étapes ci-dessus sont conservées, avec les valeurs que vous avez choisi de garder. Sinon, l’enregistrement est supprimé lors de l’enregistrement.",
  "web.teach.review.save": "Enregistrer comme compétence",
  "web.teach.review.saving": "Enregistrement",
  "web.teach.review.discard": "Abandonner l’enregistrement",
  "web.teach.review.privacy":
    "Le texte de la page dans ces étapes est traité comme des données, jamais comme des instructions. L’enregistrement vous demande d’approuver la compétence avant qu’elle puisse s’exécuter.",
  "web.teach.review.issues": "À corriger d’abord : {problems}",
  "web.teach.review.needName": "Donnez d’abord un nom.",
  "web.teach.review.saveFailed": "Psyche n’a pas pu l’enregistrer comme compétence : {reason}",
  "web.teach.done.title": "Enregistré",
  "web.teach.done.body":
    "« {title} » attend votre approbation. Lisez la carte, puis approuvez-la pour installer la compétence.",
  "web.teach.done.installed": "« {title} » est installé.",
  "web.teach.done.run": "L’exécuter une fois maintenant",
  "web.teach.done.runHint":
    "Remplit la zone de message avec la compétence. Appuyez sur Envoyer, puis observez le navigateur : chaque clic et saisie demande l’approbation comme d’habitude, et il s’arrête pour demander si la page a changé.",
  "web.teach.done.close": "Fermer",
  "web.teach.step.navigate": "Ouvrir {address}",
  "web.teach.step.click": "Cliquer sur « {name} »",
  "web.teach.step.clickRole": "Cliquer sur {role}",
  "web.teach.step.type": "Saisir dans « {name} »",
  "web.teach.step.typeKept": "Saisir {value} dans « {name} »",
  "web.teach.step.typeInput": "Saisir {input} dans « {name} »",
  "web.teach.step.typeAsk": "Saisir ce que vous indiquez dans « {name} »",
  "web.teach.step.typeSensitive": "Vous saisissez vous-même dans « {name} »",
  "web.teach.step.typeUnnamed": "un champ",
  "web.teach.step.select": "Choisir une option dans « {name} »",
  "web.teach.step.selectKept": "Choisir {value} dans « {name} »",
  "web.teach.step.selectInput": "Choisir {input} dans « {name} »",
  "web.teach.step.selectAsk": "Choisir ce que vous indiquez dans « {name} »",
  "web.teach.step.selectSensitive": "Vous choisissez vous-même dans « {name} »",
  "web.teach.step.press": "Appuyer sur {key}",
  "web.teach.step.pressIn": "Appuyer sur {key} dans « {name} »",
};
