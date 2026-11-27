import type { Catalogue } from "../../index.ts";

/** Windows variants of the sandbox PC, voice keys and platform terms, and Mac wording (fr); merged into `../fr.ts`. */
export const windowsPlatform202611: Partial<Catalogue> = {
  "blocks.details.runsNoHostSandbox":
    "sur cet ordinateur, sans bac à sable : il n’y en a pas pour les commandes ici",
  "blocks.execHost.noHostSandbox":
    "Il n’y a pas de bac à sable pour les commandes sur cet ordinateur, donc cette commande ne peut s’exécuter que sans. Tapez {word} pour l’exécuter cette fois.",
  "blocks.execHost.mustTypeOnly": "Tapez {word} pour l’autoriser.",
  "settings.uninstall.stopSandboxPc":
    "Le service du PC bac à sable est supprimé. Windows demande une fois l’approbation de l’administrateur.",
  "settings.computerUse.tcc.microphone.name": "Microphone",
  "settings.computerUse.tcc.microphone.why":
    "permet à Psyche de vous entendre pour la dictée et les notes de réunion",
  "settings.sandbox.restart.reopen": "Quittez Psyche puis rouvrez-le.",
  "settings.sandbox.pc.title": "Activer le PC bac à sable",
  "settings.sandbox.pc.body":
    "srt, le bac à sable léger de Psyche pour les commandes, ne fonctionne pas sous Windows. Ici, les scripts, les serveurs de commandes et les connecteurs créés par Psyche s’exécutent plutôt dans le Confidentialité et sécurité → Utilisation de l’ordinateur → Mode VM : un petit ordinateur Linux à part, sans accès à vos fichiers. Activez-le dans Réglages → PC bac à sable, puis vérifiez à nouveau.",
  "settings.sandbox.pc.notReady.title": "Le PC bac à sable n’est pas encore prêt",
  "settings.sandbox.pc.notReady.body":
    "Il est activé, mais il ne tourne pas encore, ou le Psyche qu’il contient est périmé. Démarrez-le ou mettez-le à jour dans Réglages → Confidentialité et sécurité → Utilisation de l’ordinateur → Mode VM, puis vérifiez à nouveau.",
  "settings.sandbox.pc.ready":
    "Le PC bac à sable est activé : les scripts, serveurs de commandes et connecteurs créés par Psyche s’y exécutent.",
  "settings.sandbox.pc.open": "Ouvrir les réglages du PC bac à sable",
  "settings.sandbox.pc.where":
    "Il se trouve dans Réglages → Confidentialité et sécurité → Utilisation de l’ordinateur → Mode VM.",
  "settings.devices.platform.windows": "PC Windows",
  "settings.devices.nodeKind.winHelper": "Assistant Windows",
  "settings.devices.thisPcAdmin":
    "Ce PC est l’appareil administrateur. Un autre appareil administrateur peut le révoquer ici.",
  "settings.devices.presenceKey.windowsHello":
    "Clé Windows Hello ({algorithm}), telle que signalée par l’assistant",
  "settings.devices.presenceKey.windowsHelloNoAlgorithm":
    "Clé Windows Hello, telle que signalée par l’assistant",
  "settings.shortcut.reserved.windowsKey": "Windows (raccourcis avec la touche Windows)",
  "settings.shortcut.reserved.windowMenu": "le menu des fenêtres",
  "settings.shortcut.reserved.closeApp": "la fermeture des apps",
  "settings.shortcut.reserved.taskManager": "le Gestionnaire des tâches",
  "settings.shortcut.reserved.startMenu": "le menu Démarrer",
  "settings.shortcut.reserved.securityScreen": "l’écran de sécurité de Windows",
  "settings.shortcut.key.Super": "Touche Windows",
  "settings.shortcut.useDefault": "Utiliser la valeur par défaut",
  "settings.quickEntry.title": "Saisie rapide",
  "settings.key.quickEntry.shortcut": "Raccourci",
  "settings.quickEntry.shortcutHint":
    "Ouvre la fenêtre de discussion depuis n’importe quelle app. Sauf si vous choisissez d’autres touches, Psyche utilise {keys}, ou {fallback} lorsqu’une autre app les occupe.",
  "settings.voice.key.rightCtrl": "Ctrl droite",
  "settings.voice.key.rightAlt": "Alt droite",
  "settings.voice.key.rightShift": "Maj droite",
  "settings.voice.key.rightWin": "Touche Windows droite",
  "settings.voice.key.capsLock": "Verr. Maj",
  "settings.voice.key.scrollLock": "Arrêt défil.",
  "settings.voice.key.pause": "Pause",
  "settings.voice.key.menu": "Touche Menu",
  "settings.voice.key.insert": "Inser",
  "settings.voice.key.numLock": "Verr. num.",
  "settings.voice.key.other": "Une autre touche",
  "settings.voice.key.press": "Appuyez sur une touche",
  "settings.voice.key.pressNow": "Appuyez sur la touche à maintenir…",
  "settings.voice.key.cantUse":
    "Cette touche saisit du texte, elle ne peut donc pas être maintenue pour parler. Essayez Ctrl droite, Verr. Maj, Pause, la touche Menu ou F13 à F24.",
  "settings.voice.key.capsLockHint":
    "Verr. Maj garde son état activé ou désactivé : la maintenir pour parler ne le change pas, et un appui bref le bascule toujours.",
  "settings.voice.key.altGrWarning":
    "Avec votre disposition de clavier, Alt droite est AltGr, qui saisit des caractères comme @ ou €. La maintenir pour parler peut gêner leur saisie ; Ctrl droite est plus sûre.",
  "settings.voice.access.windowsWhy":
    "surveille la touche que vous maintenez et saisit le texte dans l’app active. Windows n’exige aucune autorisation pour cela ; les apps lancées en administrateur ne reçoivent pas le texte dicté.",
  "settings.voice.model.title": "Modèle vocal",
  "settings.voice.model.usingHelper":
    "La dictée utilise la reconnaissance vocale de l’assistant. Le modèle vocal transcrit mieux et fonctionne sur ce Mac.",
  "settings.voice.model.download":
    "Télécharger le modèle vocal ({mb} Mo) pour une meilleure dictée",
  "settings.voice.model.downloadHint":
    "Un téléchargement unique depuis le projet whisper.cpp, vérifié avant utilisation. L’audio ne quitte jamais ce Mac.",
  "settings.voice.model.downloading": "Téléchargement du modèle vocal : {received} sur {total} Mo",
  "settings.voice.model.ready": "Whisper ({model}) sur ce Mac",
  "settings.voice.model.readyHint":
    "La dictée et les enregistrements sont transcrits ici ; l’audio ne quitte jamais le Mac.",
  "settings.voice.model.readyNotFirst":
    "Installé. Votre ordre des moteurs place un autre moteur en premier, donc la dictée ne l’utilise pas pour l’instant.",
  "settings.voice.model.failed": "Le téléchargement a échoué : {reason}",
  "settings.voice.model.retry": "Réessayer",
  "settings.voice.model.vcredist":
    "Le modèle vocal a besoin du Microsoft Visual C++ Redistributable. Installez-le, puis dictez à nouveau.",
  "settings.voice.model.crashed":
    "Le moteur vocal s’est arrêté de façon inattendue ; la dictée utilise l’assistant jusqu’à son redémarrage.",
  "settings.sandboxPc.title": "Activer le PC bac à sable",
  "settings.sandboxPc.explain":
    "{persona} reçoit un petit PC Linux privé qui tourne dans Windows. Les tâches s’y exécutent au lieu de votre PC, et ne voient que les dossiers que vous partagez.",
  "settings.sandboxPc.oneTime":
    "Configuration unique : Windows demande une fois l’approbation de l’administrateur pour ajouter un service en arrière-plan qui fait tourner le PC. Psyche télécharge ensuite l’image du PC ({download}, {disk} sur le disque). Rien d’autre ne demande d’administrateur.",
  "settings.sandboxPc.oneTimeNoSize":
    "Configuration unique : Windows demande une fois l’approbation de l’administrateur pour ajouter un service en arrière-plan qui fait tourner le PC. Psyche télécharge ensuite l’image du PC. Rien d’autre ne demande d’administrateur.",
  "settings.sandboxPc.turnOn": "Activer le PC bac à sable",
  "settings.sandboxPc.cancelDownload": "Annuler le téléchargement",
  "settings.sandboxPc.waitingAdmin": "En attente de la demande de l’administrateur…",
  "settings.sandboxPc.restarting": "Finalisation de la configuration…",
  "settings.sandboxPc.downloading": "Téléchargement de l’image du PC : {received} sur {total}",
  "settings.sandboxPc.progressLabel": "Téléchargement de l’image du PC",
  "settings.sandboxPc.ready": "Configuré",
  "settings.sandboxPc.readyText": "Le PC bac à sable est configuré. Version {version}.",
  "settings.sandboxPc.unsupported": "Le PC bac à sable n’est pas disponible ici : {reason}.",
  "settings.sandboxPc.failed": "Le PC bac à sable n’a pas pu être activé : {reason}",
  "settings.sandboxPc.failedDid": "Rien d’autre n’a été modifié. Vous pouvez réessayer.",
  "settings.sandboxPc.gb": "{value, number} Go",
  "settings.sandboxPc.mb": "{value, number} Mo",
  "settings.sandboxPc.loadLabel": "PC bac à sable",
  "settings.sandboxPc.onboarding": "PC bac à sable",
  "settings.sandboxPc.onboardingHint":
    "Facultatif : un PC Linux privé pour les tâches qui ne doivent pas toucher à vos fichiers. Vous pouvez le configurer plus tard dans les réglages.",
  "settings.sandboxPc.update.title": "Mettre à jour le service du PC bac à sable",
  "settings.sandboxPc.update.explainCompatible":
    "Cette version de Psyche embarque un service de PC bac à sable plus récent que celui installé. Le PC bac à sable continue de fonctionner comme avant.",
  "settings.sandboxPc.update.explainRequired":
    "Cette version de Psyche ne peut pas utiliser le service de PC bac à sable installé. Le PC bac à sable reste éteint tant que vous ne le mettez pas à jour.",
  "settings.sandboxPc.update.available": "Mise à jour disponible",
  "settings.sandboxPc.update.required": "Mise à jour nécessaire",
  "settings.sandboxPc.update.versions":
    "Installée : {installed}. Cette version de Psyche : {bundled}.",
  "settings.sandboxPc.update.oneStep":
    "Windows demande une fois l’approbation de l’administrateur. Un PC bac à sable en marche est arrêté pendant le remplacement du service.",
  "settings.sandboxPc.update.button": "Mettre à jour le service du PC bac à sable",
  "settings.sandboxPc.update.failed":
    "Le service du PC bac à sable n’a pas été mis à jour : {reason}",
  "settings.sandboxPc.update.failedDid": "Rien d’autre n’a été modifié. Vous pouvez réessayer.",
  "settings.sandboxPc.controls.title": "Le PC bac à sable",
  "settings.sandboxPc.controls.hint": "Créez-le une fois, puis démarrez-le et arrêtez-le ici.",
  "settings.sandboxPc.controls.create": "Créer le PC bac à sable",
  "settings.sandboxPc.controls.start": "Démarrer",
  "settings.sandboxPc.controls.stop": "Arrêter",
  "settings.sandboxPc.controls.resume": "Reprendre",
  "settings.sandboxPc.controls.working": "En cours…",
  "settings.sandboxPc.controls.helperOffline":
    "L’assistant Windows ne tourne pas ou n’a pas encore le PC bac à sable, il ne peut donc pas le piloter. Redémarrez l’assistant dans Réglages → Appareils.",
  "settings.sandboxPc.controls.failed": "Cela n’a pas fonctionné : {reason}",
  "settings.sandboxPc.controls.waitForImage": "Terminez d’abord l’activation ci-dessus.",
  "settings.sandboxPc.snapshots.title": "Instantanés",
  "settings.sandboxPc.snapshots.hint":
    "Enregistrez le disque du PC bac à sable pour y revenir plus tard. Il doit être arrêté pour enregistrer ou restaurer.",
  "settings.sandboxPc.snapshots.none": "Aucun instantané pour l’instant.",
  "settings.sandboxPc.snapshots.save": "Enregistrer un instantané",
  "settings.sandboxPc.snapshots.saveFresh": "Enregistrer comme PC neuf",
  "settings.sandboxPc.snapshots.reset": "Revenir au PC neuf",
  "settings.sandboxPc.snapshots.restore": "Restaurer",
  "settings.sandboxPc.snapshots.delete": "Supprimer",
  "settings.sandboxPc.snapshots.fresh": "PC neuf",
  "settings.sandboxPc.snapshots.item": "{label}, {when}",
  "settings.sandboxPc.snapshots.stopFirst": "Arrêtez d’abord le PC bac à sable.",
  "onboarding.connectors.windowsHint":
    "Sous Windows, {name} lit vos e-mails, votre agenda et vos contacts via un compte Microsoft, Google ou IMAP.",
  "web.about.windowsArm": "Arm64",
  "web.about.windowsX64": "x64",
  "web.about.windowsBuild": "build {build}",
  "platform.term.os": "macOS",
  "platform.term.device": "Mac",
  "platform.term.thisDevice": "Ce Mac",
  "platform.term.thisDeviceLower": "ce Mac",
  "platform.term.presence": "Touch ID",
  "platform.term.secretStore": "Trousseau",
  "platform.term.systemSettings": "Réglages système",
  "platform.term.fileManager": "Finder",
  "platform.term.trayArea": "barre des menus",
  "platform.term.taskbar": "Dock",
  "platform.term.systemSearch": "Spotlight",
  "platform.term.helper": "assistant Mac",
  "platform.term.terminal": "Terminal",
  "platform.term.alt": "Option",
  "platform.term.mod": "Commande",
  "platform.macOnly": "Disponible sur macOS",
  "platform.macOnlyHint": "{name} nécessite un Mac. Psyche sur macOS peut l’utiliser.",
  "platform.windows.access.title": "Accès Windows",
  "platform.windows.access.hint":
    "Ce que Windows permet à Psyche de faire, et ce qu’il vous demande.",
  "platform.windows.access.noPermission": "Aucune autorisation nécessaire",
  "platform.windows.access.uiAutomation.name": "Utilisation des apps",
  "platform.windows.access.uiAutomation.why":
    "{persona} lit et utilise les fenêtres d’app via l’automatisation de l’interface Windows. Windows ne lui permet pas de contrôler les apps lancées en administrateur.",
  "platform.windows.access.screen.name": "Capture d’écran",
  "platform.windows.access.screen.why":
    "Windows n’exige aucune autorisation pour capturer l’écran. Les fenêtres de Psyche et les champs de mot de passe sont masqués dans les captures.",
  "platform.windows.access.microphone.name": "Microphone",
  "platform.windows.access.microphone.why":
    "Pour la dictée et les notes de réunion. Windows le demande dans Paramètres → Confidentialité et sécurité → Microphone, avec « Autoriser les applications de bureau à accéder au microphone » activé.",
  "platform.windows.access.openSettings": "Ouvrir les réglages",
  "platform.windows.access.openSettingsFor": "Ouvrir les paramètres Windows pour {name}",
  "platform.windows.access.state.granted": "Activé",
  "platform.windows.access.state.denied": "Désactivé dans les paramètres Windows",
  "platform.windows.access.state.not_determined": "Pas encore vérifié",
  "platform.helper.restart": "Redémarrer l’assistant",
  "platform.helper.restarting": "Redémarrage…",
  "platform.helper.restartFailed": "L’assistant n’a pas démarré ({reason}).",
};
