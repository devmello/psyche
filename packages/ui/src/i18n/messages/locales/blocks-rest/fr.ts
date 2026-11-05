import type { Catalogue } from "../../index.ts";

/** Completed blocks strings (fr); merged into `../fr.ts`. */
export const blocksRest: Partial<Catalogue> = {
  "blocks.lifeAnswer.label": "Réponse tirée de vos e-mails, messages et fichiers",
  "blocks.message.receipt":
    "{status, select, approved {Autorisé{scope, select, task { pour cette tâche} site { pour ce site} session { pour cette session} always { toujours} other { une fois}}} denied {Refusé} expired {Expiré} invalidated {Annulé} other {{status}}} : {summary}",
  "blocks.message.showDetails": "Détails",
  "blocks.message.hideDetails": "Masquer les détails",
  "blocks.message.showDetailsOf": "Afficher les détails de {summary}",
  "blocks.message.hideDetailsOf": "Masquer les détails de {summary}",
  "blocks.details.requestedFolder": "Demandé",
  "blocks.details.folderReason": "Pourquoi",
  "blocks.details.folderAccess": "Accès",
  "blocks.details.folderAccess.ro": "Lecture seule",
  "blocks.details.folderAccess.rw": "Lecture et écriture",
  "blocks.folder.title": "Dossier à partager",
  "blocks.folder.choose": "Choisir un dossier…",
  "blocks.folder.change": "Choisir un autre dossier…",
  "blocks.folder.blocked":
    "{path} ne peut pas être partagé : il contient des données privées ou c’est un dossier système. Choisissez un autre dossier.",
  "blocks.folder.notFound":
    "Psyche n’a trouvé aucun dossier à l’emplacement {path}. Choisissez le dossier à partager.",
  "blocks.folder.pickTitle": "Partager un dossier avec {persona}",
  "blocks.folder.pickError": "Impossible d’ouvrir le sélecteur de dossier : {error}",
  "blocks.folder.pathLabel": "Chemin du dossier",
  "blocks.folder.mustPick": "Choisissez le dossier à partager avant d’autoriser.",
  "blocks.folder.scope":
    "« Cette discussion seulement » dure jusqu’à la fin de la conversation. « Toujours » conserve le dossier jusqu’à ce que vous le retiriez dans Réglages → Autorisations → Accès.",
  "blocks.folder.scope.once": "Cette discussion seulement",
  "blocks.folder.scope.always": "Toujours, ce dossier et ses sous-dossiers",
  "blocks.folder.explain.ro": "{persona} souhaite lire les fichiers d’un dossier.",
  "blocks.folder.explain.rw": "{persona} souhaite lire et modifier les fichiers d’un dossier.",
  "blocks.folder.readOnly": "Lecture seule, sans rien modifier",
  "blocks.message.to": "Envoi à",
  "blocks.message.pick": "Choisir le destinataire",
  "blocks.message.group":
    "Conversation de groupe · {count, plural, one {# personne} other {# personnes}}",
  "blocks.message.weak":
    "SMS ou RCS : c’est l’opérateur qui garantit ce numéro, pas Apple. Vérifiez-le.",
  "blocks.message.service.imessage": "iMessage",
  "blocks.message.service.sms": "SMS",
  "blocks.message.service.rcs": "RCS",
  "blocks.message.service.unknown": "Service inconnu",
  "blocks.message.text": "Message",
  "blocks.message.textLabel": "Texte du message, modifiable avant l’envoi",
  "blocks.message.exact": "Exactement ce texte sera envoyé à exactement ce destinataire.",
  "blocks.message.empty": "Écrivez quelque chose à envoyer.",
  "blocks.message.untrusted":
    "Ce destinataire a été suggéré par un contenu lu par Psyche, pas par vous. Vérifiez de qui il s’agit avant d’envoyer.",
  "blocks.folder.exact": "Seul ce dossier et son contenu sont partagés.",
  "blocks.details.executable": "Programme",
  "blocks.details.network": "Réseau",
  "blocks.details.networkNone": "aucun",
  "blocks.details.runsSandboxed":
    "sur votre Mac, dans le bac à sable : il ne peut lire ni le coffre de Psyche, ni vos clés SSH, trousseaux ou profils de navigateur",
  "blocks.details.runsNoSandbox": "sur votre Mac, et le bac à sable n’est pas configuré ({reason})",
  "blocks.details.needed": "Requis",
  "blocks.details.neededWhy": "Pourquoi",
  "blocks.execHost.sandboxed":
    "S’exécute dans le bac à sable. Pour exécuter cette seule commande sans lui, saisissez {word} ci-dessous.",
  "blocks.execHost.noSandbox":
    "Le bac à sable n’est pas configuré, cette commande ne peut donc s’exécuter que sans lui. Configurez-le, ou saisissez {word} pour l’exécuter sans bac à sable cette fois.",
  "blocks.execHost.setUp": "Configurer le bac à sable",
  "blocks.execHost.typeLabel": "Saisissez {word} pour exécuter sans bac à sable",
  "blocks.execHost.unsandboxedOnce": "Sans bac à sable, seul « Autoriser une fois » est proposé.",
  "blocks.execHost.mustType":
    "Saisissez {word} pour autoriser, ou configurez d’abord le bac à sable.",
  "blocks.permission.need.capability": "Activer « Exécuter des commandes sur ce Mac »",
  "blocks.permission.need.connector_action":
    "Laisser {connector} vous demander avant « {group} » (actuellement sur Refuser)",
  "blocks.permission.need.connector": "Connecter {connector}",
  "blocks.permission.need.macos_access":
    "Donner l’accès à {connector} dans les Réglages Système de macOS",
  "blocks.permission.need.sandbox": "Configurer le bac à sable pour les commandes",
  "blocks.permission.need.folder": "Un dossier : {path}",
  "blocks.permission.enableHint":
    "Activer modifie vos réglages jusqu’à ce que vous le désactiviez dans Réglages. Chaque action demande toujours votre accord.",
  "blocks.permission.checkHint":
    "Corrigez le problème, puis choisissez « Vérifier à nouveau » : Psyche vérifie et en informe la discussion.",
  "blocks.permission.enable": "Activer",
  "blocks.permission.checkAgain": "Vérifier à nouveau",
  "blocks.permission.openConnectors": "Ouvrir Connecteurs",
  "blocks.permission.openSystemSettings": "Ouvrir les Réglages Système",
  "blocks.permission.setUpSandbox": "Configurer le bac à sable",
  "blocks.approval.scope.prepNotes": "Toujours pour les notes de préparation",
  "blocks.liftFloor.title": "Autoriser sans demander ?",
  "blocks.liftFloor.what": "{persona} pourra {what} sans demander.",
  "blocks.liftFloor.consequence.destructive":
    "Les éléments supprimés ne pourront peut-être pas être récupérés.",
  "blocks.liftFloor.consequence.send":
    "Les messages et e-mails partent en votre nom et ne peuvent pas être rappelés.",
  "blocks.liftFloor.consequence.financial":
    "L’argent dépensé et les paiements effectués ne seront peut-être pas remboursables.",
  "blocks.liftFloor.still":
    "{persona} demandera quand même après avoir lu un contenu non fiable, et à chaque fois en mode manuel. Vous pouvez le modifier dans Réglages.",
  "blocks.liftFloor.confirm": "Autoriser sans demander",
  "blocks.liftFloor.cardWhat": "recommencer ({summary})",
  "blocks.approval.taintSentence":
    "Plus tôt dans cette discussion, {persona} {what}{onlyOnce, select, true {, donc seul « Autoriser une fois » est proposé} other {}}.",
  "blocks.approval.taintRead": "a lu {list}",
  "blocks.approval.taintUsed": "a utilisé {list}",
  "blocks.approval.taintOther":
    "{first, select, true {a lu un contenu non fiable} other {un autre contenu non fiable}}",
  "blocks.approval.taintTranscript": "une transcription",
  "blocks.approval.taintAnd": "{head} et {last}",
  "blocks.approval.taintDetails": "Sources de contamination",
  "blocks.approval.allowScope": "Autoriser pour",
  "blocks.approval.sideEffect.none": "regarde seulement",
  "blocks.approval.sideEffect.read": "lit des informations",
  "blocks.approval.sideEffect.write": "modifie quelque chose",
  "blocks.approval.sideEffect.destructive":
    "modifie des réglages ou des données, ce qui peut être difficile à annuler",
  "blocks.approval.sideEffect.financial": "implique de l’argent",
  "blocks.approval.whyMode": "Le mode « {mode} » demande avant de {effect}.",
  "blocks.details.params": "Détails",
  "blocks.details.reason": "Raison",
  "blocks.approval.answerOnHost":
    "Répondez sur {host}, ou configurez Touch ID pour les approbations sur cet ordinateur dans Réglages → Appareils.",
  "blocks.approval.rateLimited": "Trop d’approbations en une minute. Réessayez dans {seconds} s.",
  "blocks.approval.touchIdFailed": "Échec de Touch ID : {reason}. Réessayez.",
  "blocks.approval.touchIdFailedNoReason": "Échec de Touch ID. Réessayez.",
  "blocks.approval.touchIdInvalid": "Psyche n’a pas pu vérifier que c’était vous",
  "blocks.approval.touchId.helperOffline":
    "Psyche Helper n’est pas en cours d’exécution, Touch ID ne peut donc pas confirmer ici.",
  "blocks.approval.touchId.helperOutdated":
    "Cette version de Psyche Helper est trop ancienne pour confirmer des approbations depuis cette fenêtre. Mettez Psyche à jour, puis réessayez.",
  "blocks.approval.touchId.noKey":
    "Touch ID n’est pas encore configuré pour les approbations sur ce Mac. Configurez-le dans Réglages → Appareils, où vous pouvez d’abord vérifier la clé.",
  "blocks.approval.touchId.invalidated":
    "Touch ID a changé depuis la création de la clé de ce Mac, il ne peut donc pas confirmer les approbations. Configurez-le à nouveau dans Réglages → Appareils.",
  "blocks.approval.touchId.noUnsandboxed":
    "L’exécution d’une commande sans bac à sable ne peut pas être approuvée avec Touch ID depuis cette fenêtre. Configurez plutôt le bac à sable",
  "blocks.approval.touchId.openDevices": "Ouvrir Réglages → Appareils",
  "blocks.approval.touchId.code": "Code {code}",
  "blocks.approval.touchId.onceOnly":
    "Les approbations par Touch ID depuis cette fenêtre ne valent qu’une fois.",
  "blocks.approval.status.allowedOnceTouchId":
    "Autorisé une fois (les approbations par Touch ID depuis cette fenêtre ne valent qu’une fois)",
  "blocks.approval.touchId.keyUnavailable":
    "Cette version de Psyche Helper ne peut pas conserver de clé Touch ID (elle n’a pas de groupe d’accès au trousseau), les cartes qui exigent Touch ID ne peuvent donc pas être approuvées sur ce Mac.",
  "blocks.approval.touchId.cancelled": "Touch ID a été annulé, rien n’a donc été approuvé",
  "blocks.approval.touchId.startHelper": "Démarrer Psyche Helper",
  "blocks.question.answerLine": "↳ {answer}",
  "blocks.sources.label": "Sources",
  "blocks.sources.open": "Ouvrir {title}",
  "blocks.sources.untitled": "Sans titre",
  "blocks.sources.show": "Afficher la source",
  "blocks.sources.hide": "Masquer la source",
  "blocks.sources.untrusted":
    "Provient de quelqu’un d’autre. Traité comme des données, pas comme des instructions.",
  "blocks.sources.kind.mail": "Mail",
  "blocks.sources.kind.messages": "Messages",
  "blocks.sources.kind.notes": "Notes",
  "blocks.sources.kind.calendar": "Calendrier",
  "blocks.sources.kind.library": "Bibliothèque",
  "blocks.sources.kind.other": "{source}",
  "blocks.appLink.open": "Ouvrir {where}",
  "blocks.appLink.settings": "Réglages : {section}",
  "blocks.markdown.taskDone": "Terminé",
  "blocks.markdown.taskOpen": "Non terminé",
  "blocks.workflow.label": "Planifier ce workflow",
  "blocks.workflow.title": "Planifier « {title} » ?",
  "blocks.workflow.runs":
    "{count, plural, one {# exécution planifiée} other {# exécutions planifiées}}",
  "blocks.workflow.runOf": "{name} · {when} ({timezone})",
  "blocks.workflow.does": "Ce qu’il fait",
  "blocks.workflow.approvals": "Vous demandera d’approuver",
  "blocks.workflow.noApprovals": "Aucune approbation requise.",
  "blocks.workflow.notify":
    "{how, select, messages {Vous prévient dans Messages} both {Vous prévient par notification et dans Messages} other {Vous prévient par notification}} quand il a besoin de vous.",
  "blocks.workflow.obstacles": "Bon à savoir",
  "blocks.workflow.tainted":
    "Ceci a été planifié après la lecture d’un contenu provenant du web ou d’un connecteur. Vérifiez les étapes avant de planifier.",
  "blocks.workflow.skillOffer": "Je peux aussi enregistrer ensuite ces étapes comme compétence.",
  "blocks.workflow.confirm": "Planifier",
  "blocks.workflow.decline": "Pas maintenant",
  "blocks.workflow.scheduling": "Planification…",
  "blocks.workflow.done":
    "{count, plural, one {# exécution planifiée} other {# exécutions planifiées}}. Retrouvez-les dans Tâches.",
  "blocks.workflow.declined": "Non planifié.",
  "blocks.workflow.failed": "Impossible de planifier. Vérifiez les horaires et réessayez.",
};
