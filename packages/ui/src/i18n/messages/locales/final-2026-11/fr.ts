import type { Catalogue } from "../../index.ts";

/** Signed connector bundles and teach-by-showing in Mac apps (fr); merged into `../fr.ts`. */
export const final202611: Partial<Catalogue> = {
  "settings.connectorBundle.title": "Connecteur partagé {name}",
  "settings.connectorBundle.intro":
    "Quelqu’un a partagé ce connecteur sous forme de fichier. Rien n’est encore installé. Vérifiez qui l’a créé et ce qu’il demande, puis décidez.",
  "settings.connectorBundle.update": "Il s’agit d’une mise à jour du connecteur que vous avez.",
  "settings.connectorBundle.signer.title": "Qui l’a créé",
  "settings.connectorBundle.signer.unsigned":
    "Ce fichier n’est pas signé : impossible de savoir qui l’a créé.",
  "settings.connectorBundle.signer.dropped":
    "La version installée était signée. Celle-ci ne l’est pas.",
  "settings.connectorBundle.signer.new": "Signé par {name}. Vous n’avez jamais vu cette clé.",
  "settings.connectorBundle.signer.seen":
    "Signé par {name}, avec une clé que vous avez déjà vue mais en laquelle vous n’avez pas confiance.",
  "settings.connectorBundle.signer.trusted": "Signé par {name}, un auteur de confiance.",
  "settings.connectorBundle.signer.own": "Signé par vous.",
  "settings.connectorBundle.signer.changed":
    "Signé par {name}, mais pas avec la clé vue précédemment. Vérifiez qu’il s’agit de la même personne.",
  "settings.connectorBundle.signer.impersonates":
    "Signé sous un nom qui ressemble au vôtre, avec une clé qui n’est pas la vôtre.",
  "settings.connectorBundle.signer.nameChanged":
    "Une clé en laquelle vous avez confiance signe sous un nom qu’elle n’a pas utilisé auparavant : {name}.",
  "settings.connectorBundle.signer.revoked": "Signé par une clé que vous avez révoquée.",
  "settings.connectorBundle.signer.rotated":
    "Signé par {name} : même auteur, nouvelle clé (signée par l’ancienne). La nouvelle clé n’est pas approuvée tant que vous ne lui faites pas confiance.",
  "settings.connectorBundle.signer.claim":
    "Le nom est une déclaration de l’auteur. Seule la clé l’identifie.",
  "settings.connectorBundle.signer.key": "Clé de l’auteur",
  "settings.connectorBundle.signer.trust": "Faire confiance à {name} en tant qu’auteur",
  "settings.connectorBundle.signer.trustHint":
    "Cela ne change que l’étiquette et les avertissements des fichiers suivants. Cela ne saute jamais cette carte.",
  "settings.connectorBundle.command": "Commande qu’il exécute",
  "settings.connectorBundle.commandHint":
    "D’abord le programme, puis chaque argument sur sa propre ligne. Elle n’est pas exécutée via un shell.",
  "settings.connectorBundle.network": "Réseau demandé",
  "settings.connectorBundle.noNetwork": "Aucun réseau",
  "settings.connectorBundle.networkHint":
    "Seul le bac à sable peut l’imposer. La liste correspond à ce que dit l’auteur.",
  "settings.connectorBundle.env": "Variables lues",
  "settings.connectorBundle.noEnv": "Aucune",
  "settings.connectorBundle.envHint":
    "Les noms seulement. Vous leur donnez des valeurs après l’installation.",
  "settings.connectorBundle.secrets": "Secrets nécessaires",
  "settings.connectorBundle.noSecrets": "Aucun",
  "settings.connectorBundle.secretsHint":
    "Les noms seulement. Le fichier ne contient aucun secret. Après l’installation, vous donnez une valeur à chacun, et elle est conservée dans votre coffre.",
  "settings.connectorBundle.tools": "Outils que l’auteur dit proposer",
  "settings.connectorBundle.toolsCount": "{n, plural, one {# outil} other {# outils}}",
  "settings.connectorBundle.toolsHint":
    "Psyche le démarre dans le bac à sable et liste ce qu’il propose réellement. Ce sont ces outils qui comptent.",
  "settings.connectorBundle.toolsUndeclared":
    "Le serveur a listé des outils que le fichier n’avait pas déclarés : {names}",
  "settings.connectorBundle.toolsMissing":
    "Le fichier a déclaré des outils que le serveur n’a pas listés : {names}",
  "settings.connectorBundle.files": "Scripts fournis avec lui ({n})",
  "settings.connectorBundle.file": "{path} · {bytes} o",
  "settings.connectorBundle.fileBinary": "Ce n’est pas du texte : il ne peut pas être affiché ici.",
  "settings.connectorBundle.findings": "Ce que les vérifications ont trouvé",
  "settings.connectorBundle.finding.high": "Bloque l’installation : {message}",
  "settings.connectorBundle.finding.warn": "À vérifier : {message}",
  "settings.connectorBundle.finding.info": "{message}",
  "settings.connectorBundle.sandbox.srt":
    "Le premier lancement a lieu dans le bac à sable. Psyche le démarre là pour lister ses outils, et il continue d’y tourner.",
  "settings.connectorBundle.sandbox.container":
    "Le premier lancement a lieu dans un conteneur bac à sable. Psyche le démarre là pour lister ses outils, et il continue d’y tourner.",
  "settings.connectorBundle.sandbox.none":
    "Ce Mac n’a pas de bac à sable pour les connecteurs de commande, et Psyche n’en exécute jamais en dehors. Ce connecteur ne peut pas être installé ici. Rien n’a été démarré ni enregistré.",
  "settings.connectorBundle.blocker.scan":
    "Les vérifications ont trouvé quelque chose qui bloque l’installation. Rien n’a été démarré ni enregistré.",
  "settings.connectorBundle.blocker.probe_failed":
    "Le premier lancement, sans réseau et sans secrets, n’a pas pu le démarrer. Rien n’a été enregistré.",
  "settings.connectorBundle.signer.ownRetired":
    "Signé avec une de vos clés que vous avez remplacée. Elle n’est plus considérée comme la vôtre.",
  "settings.connectorBundle.signer.retired":
    "Signé par {name}, avec une clé remplacée par une rotation que vous avez vue. Un nouveau fichier signé ainsi est suspect.",
  "settings.connectorBundle.carry.kept":
    "Valeurs que vous avez données et qui sont conservées : {names}",
  "settings.connectorBundle.carry.cleared":
    "Valeurs que vous avez données et qui ne sont pas reprises, car le signataire ou la commande a changé. Saisissez-les à nouveau : {names}",
  "settings.connectorBundle.carry.vault":
    "Les secrets que vous avez stockés auparavant restent dans votre coffre, mais ne sont pas transmis à cette version.",
  "settings.connectorBundle.reset.title": "Si le registre des connecteurs partagés est endommagé",
  "settings.connectorBundle.reset.hint":
    "Les connecteurs issus d’un fichier restent désactivés tant que leur registre est illisible. Cela met de côté le registre endommagé (en restaurant la dernière bonne copie s’il y en a une) ; ces connecteurs restent désactivés jusqu’à ce que vous les supprimiez ou les importiez à nouveau.",
  "settings.connectorBundle.reset.go": "Réinitialiser le registre…",
  "settings.connectorBundle.reset.confirm": "Oui, réinitialiser",
  "settings.connectorBundle.reset.done":
    "Le registre a été réinitialisé. {restored, select, true {La dernière bonne copie a été restaurée.} other {Il repart de zéro.}}",
  "settings.connectorBundle.reset.failed": "Impossible de réinitialiser le registre : {reason}",
  "settings.connectorBundle.hash": "Identifiant du bundle",
  "settings.connectorBundle.close": "Fermer",
  "settings.connectorBundle.widened.title": "Demande plus que la version que vous avez",
  "settings.connectorBundle.widened.hint":
    "Approuver cette carte lui donne tout cela. Une carte pour la version plus restreinte ne l’aurait pas couvert.",
  "settings.connectorBundle.widened.command": "Une autre commande",
  "settings.connectorBundle.widened.commandValue": "Maintenant {now}. Avant : {before}",
  "settings.connectorBundle.widened.env": "Plus de variables",
  "settings.connectorBundle.widened.secrets": "Plus de secrets",
  "settings.connectorBundle.widened.network": "Plus de réseau",
  "settings.connectorBundle.widened.tools": "Plus d’outils, ou des outils qui peuvent faire plus",
  "settings.connectorBundle.widened.payload": "Des scripts différents",
  "settings.connectorBundle.widened.payloadValue": "Les fichiers fournis ont changé",
  "settings.connectorBundle.diff": "Ce qui a changé",
  "settings.connectorBundle.noChanges": "Rien d’autre n’a changé.",
  "settings.connectorBundle.import.title": "Connecteurs partagés",
  "settings.connectorBundle.import.hint":
    "Importez un connecteur que quelqu’un vous a envoyé sous forme de fichier ou de lien. Vous voyez tout ce qu’il demande avant que quoi que ce soit soit installé.",
  "settings.connectorBundle.import.file": "Importer un fichier de connecteur",
  "settings.connectorBundle.import.linkLabel": "Ou collez un lien vers un connecteur",
  "settings.connectorBundle.import.linkPlaceholder": "https://example.com/notes.psyche-connector",
  "settings.connectorBundle.import.review": "Examiner",
  "settings.connectorBundle.import.checking": "Vérification…",
  "settings.connectorBundle.import.failed": "Impossible d’importer le connecteur : {reason}",
  "settings.connectorBundle.import.tooBig":
    "Ce fichier est trop volumineux pour être un connecteur.",
  "settings.connectorBundle.import.denied": "{name} n’a pas été installé.",
  "settings.connectorBundle.import.lapsed":
    "{expired, select, true {La carte de {name} a expiré.} other {La carte de {name} ne s’applique plus.}} Importez-le à nouveau pour l’examiner.",
  "settings.connectorBundle.import.added":
    "{name} a été ajouté. Donnez-lui ci-dessous les secrets dont il a besoin, et il pourra les utiliser.",
  "settings.connectorBundle.import.addedNoSecrets": "{name} a été ajouté.",
  "settings.connectorBundle.import.addFailed": "Impossible d’ajouter {name} : {reason}",
  "settings.connectorBundle.import.secretsTitle": "Secrets pour {name}",
  "settings.connectorBundle.share.title": "Partager ce connecteur",
  "settings.connectorBundle.share.hint":
    "Crée un fichier signé contenant la commande, les noms de ses variables et de ses secrets, le réseau qu’il atteint et ses outils. Aucune valeur n’est jamais incluse. Vous confirmez d’abord ce qui y figure.",
  "settings.connectorBundle.share.go": "Partager…",
  "settings.connectorBundle.share.nameLabel": "Votre nom sur les connecteurs partagés",
  "settings.connectorBundle.share.nameHint":
    "Toute personne qui importe un fichier de vous voit ce nom. Il n’est demandé qu’une fois ; votre clé de signature est créée maintenant.",
  "settings.connectorBundle.share.make": "Créer le fichier",
  "settings.connectorBundle.share.label": "Partager {name}",
  "settings.connectorBundle.share.done":
    "{file} enregistré, signé en tant que {author}. Il ne contient que des noms : aucune valeur de variable ni de secret.",
  "settings.connectorBundle.share.failed": "Impossible de partager le connecteur : {reason}",
  "settings.connectorBundle.share.unavailable":
    "Seul Psyche sur le Mac qui l’exécute peut signer un connecteur.",
  "settings.skills.signer.ownRetired":
    "Signé avec une de vos clés que vous avez remplacée. Elle n’est plus considérée comme la vôtre.",
  "settings.skills.signer.retired":
    "Signé par {name}, avec une clé remplacée par une rotation que vous avez vue. Un nouveau fichier signé ainsi est suspect.",
  "settings.skills.signer.rotated":
    "Signé par {name} : même auteur, nouvelle clé (signée par l’ancienne). La nouvelle clé n’est pas approuvée tant que vous ne lui faites pas confiance.",
  "settings.skills.author.state.seen": "Vue, non approuvée",
  "settings.skills.author.state.trusted": "Approuvée",
  "settings.skills.author.state.revoked": "Révoquée",
  "settings.skills.keys.title": "Votre clé d’auteur et vos avis",
  "settings.skills.keys.hint":
    "La clé qui signe les compétences et les connecteurs que vous partagez. Vous pouvez la remplacer et publier un avis lorsqu’une clé ou un fichier ne doit plus être approuvé.",
  "settings.skills.keys.none":
    "Vous n’avez encore rien signé. Votre clé est créée la première fois que vous partagez une compétence ou un connecteur.",
  "settings.skills.keys.own": "Signature au nom de {name}",
  "settings.skills.keys.fingerprint": "Clé",
  "settings.skills.keys.rotate": "Remplacer ma clé…",
  "settings.skills.keys.rotateHint":
    "Crée une nouvelle clé sous le même nom. L’ancienne clé signe une déclaration qui nomme la nouvelle, de sorte que les personnes qui vous faisaient confiance voient le même auteur avec une nouvelle clé. Elles doivent encore lui faire confiance elles-mêmes. Vous confirmez d’abord.",
  "settings.skills.keys.rotateLabel": "Remplacer votre clé d’auteur",
  "settings.skills.keys.rotated": "Votre clé a été remplacée. La nouvelle clé est {key}.",
  "settings.skills.keys.rotateFailed": "Impossible de remplacer la clé : {reason}",
  "settings.skills.keys.notice.title": "Publier un avis",
  "settings.skills.keys.notice.hint":
    "Un avis est un petit fichier signé. Envoyez-le ou hébergez-le, et toute personne qui a déjà rencontré votre clé peut l’importer pour bloquer une clé ou un fichier.",
  "settings.skills.keys.notice.kindKey": "Ma clé (la clé actuelle)",
  "settings.skills.keys.notice.kindBundle":
    "Un fichier que j’ai partagé, par son identifiant de bundle",
  "settings.skills.keys.notice.kind": "Ce qui pose problème",
  "settings.skills.keys.notice.hash": "Identifiant du bundle (sha256:…)",
  "settings.skills.keys.notice.reason": "Pourquoi (toute personne qui l’importe le voit)",
  "settings.skills.keys.notice.make": "Créer l’avis",
  "settings.skills.keys.notice.label": "Signer un avis de révocation",
  "settings.skills.keys.notice.done": "{file} enregistré. Publiez-le comme vous voulez.",
  "settings.skills.keys.notice.failed": "Impossible de créer l’avis : {reason}",
  "settings.skills.keys.import.title": "Importer un avis de révocation",
  "settings.skills.keys.import.hint":
    "Appliqué seulement s’il est signé par un auteur que vous avez rencontré. Il ne peut que bloquer : il n’accorde jamais confiance à quoi que ce soit.",
  "settings.skills.keys.import.file": "Importer un fichier d’avis",
  "settings.skills.keys.import.linkLabel": "Ou collez un lien",
  "settings.skills.keys.import.linkPlaceholder": "https://example.com/revoke.psyche-notice",
  "settings.skills.keys.import.go": "Importer",
  "settings.skills.keys.import.key": "Clé {key} bloquée. Motif indiqué : {reason}",
  "settings.skills.keys.import.bundle": "Fichier {hash} bloqué. Motif indiqué : {reason}",
  "settings.skills.keys.import.previewKey":
    "Cela révoquera la clé {key}{names, select, none {} other { (connue sous le nom {names})}}. Motif indiqué par le signataire : {reason}",
  "settings.skills.keys.import.previewBundle":
    "Cela bloquera le fichier {hash}. Motif indiqué par le signataire : {reason}",
  "settings.skills.keys.import.already": "Il est déjà en vigueur.",
  "settings.skills.keys.import.apply": "L’appliquer",
  "settings.skills.keys.import.signedBy": "Signé par {name}.",
  "settings.skills.keys.import.failed": "Impossible d’utiliser l’avis : {reason}",
  "web.teach.app.record": "Enregistrer dans une app",
  "web.teach.app.recordHint":
    "Montrer à Psyche comment faire quelque chose dans une app Mac que vous avez déjà autorisée",
  "web.teach.app.pickTitle": "Enregistrer dans quelle app ?",
  "web.teach.app.pickLabel": "App",
  "web.teach.app.pickHint":
    "Seules les apps que vous avez autorisées pour l’utilisation de l’ordinateur sont listées. Ouvrez d’abord l’app. Les mots de passe, numéros de carte et codes ne sont jamais enregistrés, pas plus que les fenêtres de Psyche elle-même ni les invites de connexion et de sécurité.",
  "web.teach.app.none":
    "Aucune app n’est prête à être enregistrée. Activez l’utilisation de l’ordinateur dans les Réglages et donnez d’abord à une app le niveau Cliquer ou Interagir.",
  "web.teach.app.start": "Démarrer l’enregistrement",
  "web.teach.app.cancelPick": "Pas maintenant",
  "web.teach.app.startFailed":
    "Psyche n’a pas pu démarrer l’enregistrement de cette app. Ouvrez-la d’abord et vérifiez que Psyche a l’accès Accessibilité.",
  "web.teach.app.bar.title": "Enregistrement de {app}",
  "web.teach.app.bar.body":
    "Psyche note vos clics, vos choix de menu et votre saisie dans {app} uniquement. Les champs sécurisés ne sont jamais enregistrés, aucune capture d’écran n’est faite, et rien ne quitte ce Mac avant que vous n’enregistriez. La barre des menus propose aussi un bouton Arrêter.",
  "web.teach.app.bar.endedLimit":
    "L’enregistrement s’est arrêté à la limite de 200 étapes. Vérifiez ce qui a été capturé.",
  "web.teach.app.bar.endedTimeout":
    "L’enregistrement s’est arrêté à sa limite de durée. Vérifiez ce qui a été capturé.",
  "web.teach.app.bar.endedInterrupted":
    "L’enregistrement s’est terminé prématurément car l’app a été fermée. Vérifiez ce qui a été capturé.",
  "web.teach.app.stopFailed": "Psyche n’a pas pu terminer l’enregistrement.",
  "web.teach.app.skipped":
    "{count, plural, one {# élément a été laissé de côté : un champ sécurisé, ou un contrôle sans nom permettant de le retrouver.} other {# éléments ont été laissés de côté : des champs sécurisés, ou des contrôles sans nom permettant de les retrouver.}}",
  "web.teach.app.privacy":
    "Le texte de ces étapes provient des fenêtres et des menus de l’app. Il est traité comme des données, jamais comme des instructions. Lors de l’enregistrement, vous devez approuver la compétence avant qu’elle puisse s’exécuter.",
  "web.teach.app.sensitive":
    "Non enregistré. Psyche vous demandera de faire cette partie vous-même.",
  "web.teach.app.runHint":
    "Remplit la zone de message avec la compétence. Appuyez sur Envoyer, puis regardez l’app : chaque clic et chaque saisie demande votre approbation comme d’habitude, et Psyche s’arrête et demande si quelque chose n’est plus là où il était.",
  "web.teach.step.app.click": "Dans {app}, cliquer sur « {name} »",
  "web.teach.step.app.clickRole": "Dans {app}, cliquer sur {role}",
  "web.teach.step.app.menu": "Dans {app}, choisir {path}",
  "web.teach.step.app.type": "Dans {app}, saisir dans « {name} »",
  "web.teach.step.app.typeKept": "Dans {app}, saisir {value} dans « {name} »",
  "web.teach.step.app.typeInput": "Dans {app}, saisir {input} dans « {name} »",
  "web.teach.step.app.typeAsk": "Dans {app}, saisir ce que vous indiquez dans « {name} »",
  "web.teach.step.app.typeSensitive": "Dans {app}, vous saisissez vous-même dans « {name} »",
};
