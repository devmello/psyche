import type { Catalogue } from "../../index.ts";

/** Completed settings strings (fr); merged into `../fr.ts`. */
export const settingsRest: Partial<Catalogue> = {
  "settings.appearance.accent.ink": "Encre",
  "settings.appearance.gray.paper": "Papier",
  "settings.nav.daily": "Quotidien",
  "settings.daily.title": "Quotidien",
  "settings.daily.description":
    "Un court résumé le matin et un bilan le soir, dans Home. Psyche ne fait que lire ; rien n’est envoyé sans votre approbation.",
  "settings.daily.loadFailed": "Impossible de charger les réglages Quotidien.",
  "settings.daily.group.brief": "Résumé du matin",
  "settings.daily.group.wrapup": "Bilan du soir",
  "settings.daily.group.delivery": "Où cela s’affiche",
  "settings.daily.group.followups": "Réglages des relances",
  "settings.daily.group.automations": "Automatisations",
  "settings.key.daily.brief.enabled": "Résumé du matin",
  "settings.key.daily.wrapup.enabled": "Bilan du soir",
  "settings.key.daily.notify": "Me notifier",
  "settings.key.daily.messages": "Envoyer aussi par Messages",
  "settings.key.daily.followups.enabled": "Suivre les relances",
  "settings.key.daily.brief.time": "Heure du résumé du matin",
  "settings.key.daily.wrapup.time": "Heure du bilan du soir",
  "settings.key.daily.followups.sensitivity": "Niveau de suivi",
  "settings.daily.time": "Heure",
  "settings.daily.notify.hint":
    "Une notification avec la carte. Les heures calmes la retiennent jusqu’à leur fin.",
  "settings.daily.messages.hint": "Nécessite le canal Messages. Envoyé uniquement à vous.",
  "settings.daily.sensitivity": "Niveau de suivi",
  "settings.daily.sensitivity.low": "Seulement les engagements clairs avec une date",
  "settings.daily.sensitivity.normal": "Engagements et demandes (recommandé)",
  "settings.daily.sensitivity.high": "Tout ce que je dis que je ferai",
  "settings.daily.runNow": "Aperçu maintenant",
  "settings.daily.runFailed": "Impossible de créer la carte.",
  "settings.key.nudges.enabled": "Rappels relationnels",
  "settings.key.nudges.consentedAt": "Consentement aux rappels relationnels",
  "settings.key.nudges.sensitivity": "Fréquence des rappels",
  "settings.key.nudges.phrasing": "Reformuler les suggestions de rappel",
  "settings.shared.advanced": "Avancé",
  "settings.nav.inPage": "Dans {page}",
  "settings.nav.essentials": "L’essentiel",
  "settings.nav.learning": "Bases",
  "settings.search.count": "{count, plural, one {# résultat} other {# résultats}}",
  "settings.search.result.page": "Page",
  "settings.page.essentials": "L’essentiel",
  "settings.page.essentials.description":
    "Les quelques choix que fait la plupart des gens. Chacun a une valeur par défaut sûre, et les pages ci-dessous contiennent le reste.",
  "settings.page.general.description":
    "L’apparence de {persona}, son identité, quand il peut vous interrompre et comment vous lui parlez.",
  "settings.page.model.description":
    "Les modèles avec lesquels {persona} réfléchit, les clés qu’ils utilisent et leur coût.",
  "settings.page.connectors.description":
    "Les apps et comptes auxquels {persona} peut accéder, et lesquels il explore.",
  "settings.page.memory.description":
    "Ce dont {persona} se souvient, d’où il apprend et comment vous le contrôlez.",
  "settings.page.daily.description":
    "Votre résumé du matin et votre bilan du soir, les automatisations, les compétences et les spécialistes que {persona} peut appeler.",
  "settings.page.permissions.description":
    "Ce que {persona} peut faire sur ce Mac sans demander, et les cas où il vous demande toujours.",
  "settings.page.data.description":
    "Ce qui reste sur ce Mac, combien de temps c’est conservé, les exports, les sauvegardes et la réinitialisation.",
  "settings.page.devices.description":
    "Vos autres appareils, le serveur Gateway et le moyen de joindre {persona} quand vous êtes absent.",
  "settings.page.about.description": "Versions, vérifications d’état et journaux.",
  "settings.essentials.title": "L’essentiel",
  "settings.essentials.description":
    "Les quelques choix que fait la plupart des gens, chacun avec une valeur par défaut sûre. {persona} demande quand il a besoin de plus.",
  "settings.essentials.more": "Plus",
  "settings.essentials.moreIn": "Plus dans {place}",
  "settings.essentials.model.title": "Modèle",
  "settings.essentials.model.thinksWith": "{persona} réfléchit avec",
  "settings.essentials.model.ready": "Prêt",
  "settings.essentials.model.noKey": "Clé requise",
  "settings.essentials.model.none": "Pas encore de modèle",
  "settings.essentials.model.noneHint":
    "{persona} a besoin d’un modèle avant de pouvoir répondre. Ajoutez une clé ou utilisez un modèle sur ce Mac.",
  "settings.essentials.model.setUp": "Configurer un modèle",
  "settings.essentials.read.title": "Ce que {persona} peut lire",
  "settings.essentials.read.hint":
    "Désactivé tant que vous n’en activez pas un. Ce qui est lu est indexé sur ce Mac pour retrouver des éléments pour vous, et la mémoire en tire aussi des enseignements, sauf si vous refusez dans Mémoire → Sources.",
  "settings.essentials.asks.title": "À quelle fréquence {persona} demande d’abord",
  "settings.essentials.interrupt.title": "Quand {persona} peut vous interrompre",
  "settings.essentials.interrupt.quietHint":
    "De {from} à {until}, les notifications attendent dans la boîte de réception.",
  "settings.essentials.interrupt.briefHint": "Un court résumé dans Feed à {time}.",
  "settings.essentials.memory.title": "Mémoire",
  "settings.essentials.memory.remember": "Laisser {persona} se souvenir de nos discussions",
  "settings.essentials.memory.rememberHint":
    "Désactivé, la mémoire est suspendue : rien de nouveau n’est mémorisé ni indexé à partir des discussions tant que vous ne la réactivez pas.",
  "settings.essentials.rest":
    "Tout le reste, ainsi qu’un contrôle plus fin de chacun de ces points, se trouve dans les pages ci-dessous. La recherche dans les réglages permet de tout trouver.",
  "settings.searchModel.title": "Modèle pour la recherche",
  "settings.searchModel.description":
    "Quel modèle lit les questions, rédige les cartes de contexte et réordonne les résultats.",
  "settings.searchModel.utility": "Votre modèle utilitaire",
  "settings.searchModel.utilityHint":
    "Le petit modèle défini dans Modèles. S’il s’agit d’un modèle cloud, le texte qu’il lit est envoyé à ce fournisseur.",
  "settings.searchModel.apple":
    "Utiliser le modèle Apple sur l’appareil pour les tâches de recherche privées",
  "settings.searchModel.appleName": "Modèle Apple sur l’appareil",
  "settings.searchModel.appleHint":
    "Le texte reste sur ce Mac : rien à télécharger, aucune clé, rien n’est envoyé dans le cloud. Il lit environ {k}k jetons à la fois, les textes longs sont donc ignorés. S’il ne peut pas répondre, la tâche est ignorée. Il ne bascule jamais vers un modèle cloud.",
  "settings.searchModel.apple.why.off":
    "Apple Intelligence est désactivé. Activez-le dans Réglages Système, sous Apple Intelligence et Siri.",
  "settings.searchModel.apple.why.os": "Ce Mac nécessite macOS 26 ou version ultérieure.",
  "settings.searchModel.apple.why.device":
    "Ce Mac ou cette région ne prend pas en charge Apple Intelligence.",
  "settings.searchModel.apple.why.notReady":
    "Apple prépare encore le modèle. Réessayez dans un moment.",
  "settings.searchModel.apple.why.unknown": "Le modèle n’est pas disponible pour le moment.",
  "settings.searchModel.apple.whySkipped": "D’ici là, ces tâches sont ignorées.",
  "settings.searchModel.apple.host":
    "Il s’agit du réglage de {host}. Le modèle s’exécute sur {host}, pas sur cet ordinateur, et la modification s’applique à toutes les fenêtres.",
  "settings.searchModel.apple.ready": "Prêt sur ce Mac",
  "settings.searchModel.apple.needsAi": "Nécessite Apple Intelligence",
  "settings.searchModel.apple.notReady": "En préparation",
  "settings.searchModel.apple.notOnThisMac": "Indisponible sur ce Mac",
  "settings.searchModel.apple.unavailable": "Indisponible pour le moment",
  "settings.search.advancedHint": "Quel modèle lit vos questions",
  "settings.search.description":
    "Ce que Psyche indexe pour retrouver des éléments pour vous, et le moteur qu’il utilise sur le web.",
  "settings.nav.specialists": "Spécialistes",
  "settings.nav.notifications": "Notifications",
  "settings.nav.people": "Personnes et confidentialité",
  "settings.key.appearance.showInDock": "Afficher dans le Dock quand aucune fenêtre n’est ouverte",
  "settings.key.appearance.openAtLogin": "Ouvrir Psyche à l’ouverture de session",
  "settings.key.browser.useSignedInSessions": "Utiliser mes sessions connectées",
  "settings.key.exec.srtPath": "Emplacement de srt",
  "settings.key.search.model.engine": "Modèle pour la recherche",
  "settings.key.search.semantic.enabled": "Recherche sémantique (sur l’appareil)",
  "settings.key.search.cards.enabled": "Cartes de contexte pour la recherche",
  "settings.semanticSearch.cardsHint":
    "Un petit modèle cloud rédige un court résumé de chaque élément enregistré. Limité à environ 200 000 jetons par jour.",
  "settings.key.search.encrypt": "Chiffrer l’index de recherche",
  "settings.semanticSearch.encryptHint":
    "Rend l’index de recherche illisible sans une clé stockée séparément. S’applique au prochain démarrage et reconstruit l’index une fois.",
  "settings.semanticSearch.encrypt.on": "Index chiffré",
  "settings.semanticSearch.encrypt.pending":
    "En attente de l’ouverture de l’index chiffré par l’assistant Mac",
  "settings.semanticSearch.encrypt.unavailable": "Non chiffré : {why}",
  "settings.key.search.rerank.enabled":
    "Réordonner les meilleurs résultats avec un petit modèle cloud",
  "settings.semanticSearch.rerankHint":
    "Un petit modèle cloud place les meilleurs résultats en premier. Les 20 premiers extraits quittent ce Mac. Désactivé par défaut.",
  "settings.key.search.runOnBattery": "Indexer sur batterie",
  "settings.key.search.queryModel.enabled": "Lire les questions avec un petit modèle",
  "settings.semanticSearch.queryModelHint":
    "Un petit modèle cloud détermine les filtres de date, de personne et de source. Seule la question est envoyée, jamais vos éléments.",
  "settings.key.search.semantic.engine": "Moteur d’embedding",
  "settings.key.search.semantic.allowCloud": "Autoriser un service d’embedding cloud",
  "settings.key.memory.recall.mode": "Mode de rappel de la mémoire",
  "settings.key.widgets.remoteImages": "Images distantes dans les widgets",
  "settings.key.ui.map.tiles": "Tuiles de carte",
  "settings.key.ui.map.styleUrl": "URL du style de carte",
  "settings.key.ui.map.styleUrlDark": "URL du style de carte (sombre)",
  "settings.key.teaching.enabled": "Apprendre de vos retours",
  "settings.key.teaching.implicit": "Remarquer les modifications, annulations et rejets",
  "settings.key.teaching.paused": "Suspendre l’apprentissage",
  "settings.key.teaching.weeklyCard": "Carte hebdomadaire « Ce que j’ai appris »",
  "settings.key.memory.graph": "Personnes et projets",
  "settings.key.memory.everything": "Mémoire en arrière-plan",
  "settings.key.agent.showReasoning": "Afficher la réflexion pendant le travail",
  "settings.key.data.reasoningRetentionDays": "Conserver la réflexion pendant",
  "settings.key.notifications.quietHours.enabled": "Heures calmes",
  "settings.key.notifications.quietHours.start": "Calme à partir de",
  "settings.key.notifications.quietHours.end": "Calme jusqu’à",
  "settings.notifications.title": "Notifications",
  "settings.notifications.description": "Quand Psyche peut vous interrompre.",
  "settings.notifications.group.quietHours": "Heures calmes",
  "settings.notifications.quietHours.hint":
    "Retient les notifications jusqu’à la fin de la plage. Les approbations urgentes passent quand même.",
  "settings.key.ui.onboarding.progress": "Progression de l’intégration",
  "settings.key.permissions.liftedFloors": "Actions autorisées sans demander pour {id}",
  "settings.key.specialists.maxConcurrent": "Spécialistes simultanés",
  "settings.key.specialists.monthlyCapUsd": "Dépenses mensuelles des spécialistes",
  "settings.key.specialists.showInFeed": "Afficher les résultats des spécialistes dans Feed",
  "settings.key.specialists.enabled": "{role} activé",
  "settings.key.specialists.model": "Modèle de {role}",
  "settings.key.specialists.budget": "Budget de {role}",
  "settings.key.specialists.maxMode": "Mode d’autorisation de {role}",
  "settings.credentials.payments.description":
    "Une carte à usage unique, après votre approbation de chaque achat. Les numéros de carte n’atteignent jamais Psyche.",
  "settings.approval.presenceUnavailable":
    "Cette fenêtre ne peut pas confirmer que c’est vous. Approuvez la modification dans l’app Psyche sur votre Mac (Touch ID) ou depuis un appareil avec une clé d’accès. Rien ne change d’ici là.",
  "settings.doctor.gateway": "Gateway",
  "settings.doctor.gatewayOk": "Répond.",
  "settings.doctor.model": "Modèle",
  "settings.doctor.noModel":
    "Aucun modèle n’est encore choisi. Ajoutez-en un dans Réglages → Modèles.",
  "settings.doctor.sandbox": "Bac à sable",
  "settings.doctor.noSandbox":
    "Aucun bac à sable n’est disponible, les commandes restent donc bloquées.",
  "settings.doctor.memory": "Mémoire",
  "settings.doctor.memoryPaused": "La mémoire est en pause : rien de nouveau n’est mémorisé.",
  "settings.doctor.memoryOk": "{files, plural, one {# fichier} other {# fichiers}} en mémoire.",
  "settings.appearance.description": "S’applique à chaque appareil associé.",
  "settings.appearance.colors": "Couleurs",
  "settings.appearance.colorsHint": "Clair ou sombre, et votre couleur d’accentuation.",
  "settings.appearance.comfort": "Confort",
  "settings.appearance.comfortHint": "Plus reposant pour les yeux et pour les animations.",
  "settings.appearance.backgroundHint": "Si Psyche reste actif lorsque vous fermez la fenêtre.",
  "settings.appearance.advancedHint":
    "Ton de gris, couleur personnalisée, sens du texte, vérification du contraste",
  "settings.appearance.fineTune": "Affiner les couleurs",
  "settings.appearance.fineTuneHint": "Pour ceux qui veulent un rendu précis.",
  "settings.appearance.contrastCheck": "Vérification du contraste",
  "settings.appearance.contrastCheckHint": "La lisibilité de chaque thème, étape par étape.",
  "settings.appearance.background": "Arrière-plan",
  "settings.appearance.showInDockHint":
    "Désactivé, Psyche reste actif dans la barre des menus quand sa dernière fenêtre se ferme.",
  "settings.appearance.openAtLoginHint":
    "Lance Psyche dans la barre des menus à l’ouverture de session, afin que les automatisations planifiées puissent toujours s’exécuter.",
  "settings.appearance.glass.hint":
    "Laisse transparaître le contenu à travers les menus, les popovers et la zone de saisie.",
  "settings.browser.description":
    "{persona} navigue dans sa propre fenêtre. Le mode Chrome réel utilise un profil séparé dans lequel vous vous connectez une seule fois.",
  "settings.browser.signedIn.title": "Sites connectés",
  "settings.browser.signedIn.description":
    "Sites sur lesquels vous êtes connecté dans le navigateur de Psyche. Les tâches réutilisent ces connexions.",
  "settings.browser.signedIn.auto": "détecté automatiquement",
  "settings.browser.useSignedIn.title": "Sessions connectées",
  "settings.browser.useSignedIn.description":
    "{persona} continue d’utiliser votre connexion sur le même site. Les écritures, achats et envois demandent toujours votre accord d’abord.",
  "settings.browser.useSignedIn.label": "Laisser Psyche utiliser mes sessions connectées",
  "settings.browser.useSignedIn.hint":
    "Activé par défaut. Désactivé, chaque site s’ouvre déconnecté, sauf ceux sur lesquels vous avez choisi de rester connecté.",
  "settings.browser.signedIn.none": "Aucun site connecté pour l’instant.",
  "settings.browser.signedIn.viaHosts": "Également connecté via {hosts}",
  "settings.browser.signedIn.forget": "Se déconnecter / oublier",
  "settings.browser.signedIn.loadFailed":
    "Psyche n’a pas pu lister les sites connectés ({reason}).",
  "settings.browser.signedIn.forgetFailed": "Psyche n’a pas pu déconnecter {site} ({reason}).",
  "settings.computerUse.appsHint": "Jusqu’où Psyche peut aller dans chaque app.",
  "settings.connectors.catalog.appleShortcuts": "Raccourcis",
  "settings.connectors.catalog.obsidian": "Obsidian",
  "settings.connectors.trust.verified": "vérifié",
  "settings.connectors.filter.label": "Afficher",
  "settings.connectors.filter.all": "Tout",
  "settings.connectors.filter.apps": "Apps",
  "settings.connectors.filter.mcp": "Serveurs MCP",
  "settings.connectors.configureFailed":
    "Psyche n’a pas pu enregistrer les réglages de {name} : {reason}",
  "settings.shortcuts.title": "Vos raccourcis",
  "settings.shortcuts.loading": "Lecture de vos raccourcis depuis ce Mac…",
  "settings.shortcuts.none": "Aucun raccourci dans l’app Raccourcis pour l’instant.",
  "settings.shortcuts.noHelper":
    "Ouvrez Psyche sur votre Mac pour lister vos raccourcis : l’assistant les lit.",
  "settings.shortcuts.failed": "Psyche n’a pas pu lire vos raccourcis.",
  "settings.shortcuts.hint":
    "Désactivé : ne jamais exécuter. Demander : une carte à chaque fois. Autoriser : s’exécute sans demander, uniquement pour les raccourcis qui ne font que lire.",
  "settings.shortcuts.rule.off": "Désactivé",
  "settings.shortcuts.rule.ask": "Demander",
  "settings.shortcuts.rule.allow": "Autoriser",
  "settings.shortcuts.actions": "Actions Psyche",
  "settings.shortcuts.install": "Installer",
  "settings.shortcuts.installNamed": "Installer {name}",
  "settings.shortcuts.installed": "Installé",
  "settings.trusted.title.reminders": "Vos listes de Rappels",
  "settings.trusted.title.notes": "Vos dossiers Notes",
  "settings.trusted.title.calendar": "Vos calendriers",
  "settings.trusted.none.reminders": "Aucune liste de Rappels pour l’instant.",
  "settings.trusted.none.notes": "Aucun dossier dans Notes pour l’instant.",
  "settings.trusted.none.calendar": "Aucun calendrier pour l’instant.",
  "settings.trusted.loading": "Lecture depuis ce Mac…",
  "settings.trusted.noHelper": "Ouvrez Psyche sur votre Mac pour les lister : l’assistant les lit.",
  "settings.trusted.failed": "Psyche n’a pas pu les lire depuis ce Mac.",
  "settings.trusted.toggle": "À moi — considérer comme fiable",
  "settings.trusted.shared": "Partagé",
  "settings.trusted.hint":
    "Le fait d’y lire ne fera pas redemander la discussion. Activez-le uniquement pour les listes que personne d’autre ne peut modifier.",
  "settings.obsidian.vault": "Dossier du coffre",
  "settings.obsidian.newVault": "Nouveau dossier de coffre",
  "settings.obsidian.noVault": "Aucun coffre choisi",
  "settings.obsidian.vaultHint":
    "Psyche lit le coffre via un dossier partagé (Réglages → Autorisations → Accès) : partagez-le, puis utilisez-le.",
  "settings.obsidian.share": "Partager ce dossier",
  "settings.obsidian.shared": "Partagé",
  "settings.obsidian.useVault": "Utiliser ce coffre",
  "settings.obsidian.change": "Changer de coffre…",
  "settings.obsidian.daily": "Dossier des notes quotidiennes",
  "settings.obsidian.dailyPlaceholder": "Depuis les réglages des notes quotidiennes d’Obsidian",
  "settings.connectors.can.title": "Ce que {persona} peut faire",
  "settings.connectors.can.label": "Ce que {persona} peut faire avec {name}",
  "settings.connectors.can.alwaysAsks": "Demande toujours d’abord",
  "settings.connectors.can.asksByDefault": "Demande d’abord, sauf si vous l’autorisez",
  "settings.connectors.can.lifted": "S’exécute sans demander",
  "settings.connectors.can.liftWhat": "{action} dans {name}",
  "settings.connectors.can.readOnly": "Désactivé tant que {name} est connecté en lecture seule",
  "settings.connectors.can.mail.read.title": "Lire les e-mails",
  "settings.connectors.can.mail.read.lines":
    "Lire et rechercher les e-mails, y compris non lus · Voir le nombre de non lus par boîte · Utiliser l’e-mail sélectionné",
  "settings.connectors.can.mail.draft.title": "Rédiger des e-mails",
  "settings.connectors.can.mail.draft.lines":
    "Rédiger de nouveaux e-mails, réponses et transferts (enregistrés, non envoyés)",
  "settings.connectors.can.mail.organize.title": "Organiser les e-mails",
  "settings.connectors.can.mail.organize.lines":
    "Marquer comme lu, marquer d’un drapeau, classer et archiver · Enregistrer les pièces jointes",
  "settings.connectors.can.mail.send.title": "Envoyer des e-mails",
  "settings.connectors.can.mail.send.lines": "Envoyer des e-mails et des brouillons enregistrés",
  "settings.connectors.can.notes.read.title": "Lire les notes",
  "settings.connectors.can.notes.read.lines": "Trouver, lister et lire les notes et dossiers",
  "settings.connectors.can.notes.create.title": "Écrire des notes",
  "settings.connectors.can.notes.create.lines": "Créer des notes et y ajouter du contenu",
  "settings.connectors.can.reminders.read.title": "Lire les rappels",
  "settings.connectors.can.reminders.read.lines": "Voir ce qui est dû, en retard et marqué",
  "settings.connectors.can.reminders.write.title": "Modifier les rappels",
  "settings.connectors.can.reminders.write.lines": "Ajouter, terminer et marquer des rappels",
  "settings.connectors.can.calendar.read.title": "Lire votre calendrier",
  "settings.connectors.can.calendar.read.lines":
    "Voir les événements, les participants et les liens de réunion · Trouver du temps libre",
  "settings.connectors.can.calendar.write.title": "Modifier votre calendrier",
  "settings.connectors.can.calendar.write.lines": "Ajouter, déplacer et modifier des événements",
  "settings.connectors.grant.allowed":
    "Autorisé dans Réglages Système → Confidentialité et sécurité → {grant}",
  "settings.connectors.grant.automation": "Automatisation → {app}",
  "settings.connectors.grant.calendars": "Calendriers",
  "settings.connectors.grant.reminders": "Rappels",
  "settings.connectors.grant.contacts": "Contacts",
  "settings.connectors.grant.photos": "Photos",
  "settings.connectors.app.mail": "Mail",
  "settings.connectors.app.notes": "Notes",
  "settings.connectors.app.music": "Musique",
  "settings.connectors.app.safari": "Safari",
  "settings.connectors.app.chrome": "Google Chrome",
  "settings.connectors.app.things": "Things",
  "settings.connectors.app.shortcuts": "Raccourcis",
  "settings.connectors.try.title": "Essayer",
  "settings.connectors.try.mail.unread": "Qu’est-ce qui n’est pas lu aujourd’hui ?",
  "settings.connectors.try.mail.reminder": "Créer un rappel à partir de l’e-mail sélectionné",
  "settings.connectors.try.mail.reply": "Rédiger une réponse au dernier e-mail de Dana",
  "settings.connectors.try.notes.find": "Trouver ma note sur le séminaire",
  "settings.connectors.try.notes.append":
    "Ajouter les décisions d’aujourd’hui à ma note sur le séminaire",
  "settings.connectors.try.reminders.due": "Qu’est-ce qui est dû aujourd’hui ?",
  "settings.connectors.try.reminders.add": "Rappelle-moi d’appeler le dentiste demain à 9 h",
  "settings.connectors.try.calendar.today": "Qu’y a-t-il dans mon calendrier aujourd’hui ?",
  "settings.connectors.try.calendar.focus": "Bloquer deux heures demain matin pour me concentrer",
  "settings.connectors.actionFailed":
    "Psyche n’a pas pu modifier {name} ({reason}). Rien n’a changé.",
  "settings.mcp.badge": "MCP",
  "settings.mcp.showDetails": "Afficher les détails",
  "settings.mcp.hideDetails": "Masquer les détails",
  "settings.sandbox.setUp": "Configurer le bac à sable",
  "settings.mcp.sandboxHelp": "Les serveurs de commandes nécessitent un bac à sable sur ce Mac.",
  "settings.sandbox.title": "Configurer le bac à sable",
  "settings.sandbox.why":
    "Les commandes s’exécutent sur votre Mac avec vos fichiers, mais ne peuvent lire ni votre coffre, ni vos clés, ni les données privées de Psyche.",
  "settings.sandbox.whyHow":
    "Utilise srt, l’environnement d’exécution sandbox d’Anthropic, sous le bac à sable propre à macOS. Aucune machine virtuelle requise.",
  "settings.sandbox.privacy":
    "Psyche n’installe rien de lui-même. Vous exécutez chaque étape ci-dessous, ou ouvrez vous-même le téléchargement.",
  "settings.sandbox.checking": "Examen de ce Mac…",
  "settings.sandbox.checkAgain": "Vérifier à nouveau",
  "settings.sandbox.done": "Terminé",
  "settings.sandbox.copy": "Copier",
  "settings.sandbox.copied": "Copié",
  "settings.sandbox.ready": "Prêt",
  "settings.sandbox.srt.ready":
    "srt est configuré à l’emplacement {path}. Des serveurs de commandes peuvent être ajoutés.",
  "settings.sandbox.srt.missing.title": "Installer srt",
  "settings.sandbox.srt.missing.body":
    "srt provient de npm. Si la commande demande l’autorisation d’écrire, exécutez-la avec les droits de votre propre compte ; Psyche ne l’exécute jamais à votre place.",
  "settings.sandbox.srt.install": "L’installer avec npm",
  "settings.sandbox.srt.link": "En savoir plus sur srt sur GitHub",
  "settings.sandbox.srt.thenCheck": "Puis vérifiez à nouveau",
  "settings.sandbox.srt.thenCheckBody":
    "Psyche trouve srt dans votre PATH ainsi que dans les dossiers de Homebrew et de npm, sans redémarrage.",
  "settings.sandbox.srt.broken":
    "Le srt à l’emplacement {path} est inutilisable : {problem, select, not_absolute {le chemin doit commencer par /} not_executable {il n’y a pas de programme exécutable à cet endroit} other {il est introuvable}}.",
  "settings.sandbox.srt.fromEnv":
    "PSYCHE_SRT_PATH définit cet emplacement, il ne peut donc pas être modifié ici.",
  "settings.sandbox.srt.installButton": "Installer avec Psyche",
  "settings.sandbox.srt.reinstallButton": "Réinstaller",
  "settings.sandbox.srt.updateButton": "Mettre à jour srt",
  "settings.sandbox.srt.installOr": "Ou laissez Psyche l’installer pour vous",
  "settings.sandbox.srt.installConfirm.title": "Installer srt {version} ?",
  "settings.sandbox.srt.installConfirm.body":
    "Psyche téléchargera {package} {version} et ses dépendances depuis le registre npm (registry.npmjs.org), vérifiera chaque fichier à l’aide d’une somme de contrôle intégrée à cette version de Psyche, puis les décompressera avec son propre Node. Rien n’est installé à l’échelle du système, aucun script d’installation ne s’exécute et aucun mot de passe n’est requis.",
  "settings.sandbox.srt.installConfirm.where": "Il sera placé dans {dir}",
  "settings.sandbox.srt.installConfirm.go": "Installer",
  "settings.sandbox.srt.installConfirm.cancel": "Annuler",
  "settings.sandbox.srt.installing": "Installation de srt…",
  "settings.sandbox.srt.installed": "Installé par Psyche : srt {version}.",
  "settings.sandbox.srt.installFailed": "Impossible d’installer srt : {reason}",
  "settings.sandbox.srt.updateAvailable":
    "Cette version de Psyche inclut un srt plus récent ({version}) ; {installed} est installé.",
  "settings.sandbox.srt.choose": "srt se trouve ailleurs",
  "settings.sandbox.srt.path": "Chemin complet vers srt",
  "settings.sandbox.srt.use": "Utiliser ce srt",
  "settings.sandbox.srt.useHint":
    "L’enregistrement demande une confirmation sur cet appareil, car cela détermine ce qui exécute vos commandes.",
  "settings.sandbox.containers.title": "Isolation renforcée (facultatif)",
  "settings.sandbox.containers.body":
    "Un environnement d’exécution de conteneurs exécute le code dans sa propre machine Linux sans accès aux fichiers de votre Mac : pour le code exécuté par l’agent et certaines conversions de fichiers. Les serveurs de commandes continuent d’utiliser srt, sauf si la Gateway est configurée pour utiliser des conteneurs.",
  "settings.sandbox.containers.ready": "{runtime} est en cours d’exécution.",
  "settings.sandbox.runtime.appleContainer": "Apple container",
  "settings.sandbox.runtime.docker": "Docker",
  "settings.sandbox.runtime.podman": "Podman",
  "settings.sandbox.missing.title": "Installer {runtime}",
  "settings.sandbox.missing.appleContainer":
    "L’environnement de conteneurs d’Apple donne à chaque bac à sable sa propre VM légère. Il nécessite macOS 26 sur Apple Silicon et un programme d’installation que vous approuvez avec le mot de passe de votre Mac.",
  "settings.sandbox.missing.docker":
    "Docker via Colima est gratuit et léger ; Docker Desktop est le choix du tout-en-clics.",
  "settings.sandbox.step.download": "Télécharger et ouvrir le programme d’installation",
  "settings.sandbox.step.downloadLink": "Ouvrir les versions d’Apple container",
  "settings.sandbox.step.start": "Le démarrer",
  "settings.sandbox.step.install": "L’installer avec Homebrew",
  "settings.sandbox.step.orDesktop": "Ou téléchargez Docker Desktop et ouvrez-le une fois",
  "settings.sandbox.step.desktopLink": "Ouvrir le téléchargement de Docker Desktop",
  "settings.sandbox.stopped.title": "{runtime} est installé mais ne fonctionne pas",
  "settings.sandbox.stopped.appleContainer":
    "Démarrez son service système, puis vérifiez à nouveau.",
  "settings.sandbox.stopped.docker":
    "Démarrez le démon Docker (ouvrez Docker Desktop ou exécutez la commande ci-dessous), puis vérifiez à nouveau.",
  "settings.sandbox.stopped.podman": "Démarrez la machine Podman, puis vérifiez à nouveau.",
  "settings.sandbox.restart.title": "{runtime} fonctionne. Redémarrez la Gateway pour l’utiliser",
  "settings.sandbox.restart.body":
    "La Gateway a cherché un environnement de conteneurs au démarrage et n’en a trouvé aucun. Redémarrez-la pour qu’elle détecte {runtime}.",
  "settings.sandbox.restart.step": "Redémarrer la Gateway",
  "settings.sandbox.without":
    "Sans srt, Psyche peut toujours utiliser les serveurs par URL et vos connecteurs, mais ne peut pas exécuter de serveurs de commandes MCP locaux.",
  "settings.mcp.off": "Désactivé",
  "settings.mcp.turnedOn": "{name} est activé.",
  "settings.mcp.turnedOff": "{name} est désactivé.",
  "settings.mcp.tools.title": "Outils",
  "settings.mcp.tools.hint":
    "{off, plural, =0 {Psyche peut utiliser tous les outils.} one {# outil est retenu à Psyche.} other {# outils sont retenus à Psyche.}} Désactiver un outil ne redémarre pas le serveur.",
  "settings.mcp.tools.loadFailed": "Impossible de charger les outils : {reason}",
  "settings.mcp.tools.off": "Ce serveur est désactivé. Activez-le pour voir ses outils.",
  "settings.mcp.tools.notConnected": "Ce serveur n’est pas connecté et ne liste donc aucun outil.",
  "settings.mcp.tools.none": "Ce serveur n’a aucun outil.",
  "settings.mcp.secrets.title": "Secrets",
  "settings.mcp.secrets.intro":
    "Clés avec lesquelles ce serveur démarre. Elles restent dans votre coffre ; Psyche indique seulement si chacune est définie.",
  "settings.mcp.secrets.loadFailed": "Impossible de charger les secrets : {reason}",
  "settings.mcp.secrets.set": "Défini",
  "settings.mcp.secrets.unset": "Non défini",
  "settings.mcp.secrets.replace": "Remplacer",
  "settings.mcp.secrets.setIt": "Définir une valeur",
  "settings.mcp.secrets.replaceFor": "Remplacer {name}",
  "settings.mcp.secrets.plain":
    "Conservé dans les réglages du serveur, pas dans le coffre. Le remplacer le déplace dans le coffre.",
  "settings.mcp.secrets.newValue": "Nouvelle valeur pour {name}",
  "settings.mcp.secrets.hint":
    "Enregistré dans votre coffre, puis le serveur redémarre avec cette valeur.",
  "settings.mcp.secrets.replaced":
    "{name} a été remplacé. Le serveur redémarre avec la nouvelle valeur.",
  "settings.mcp.danger.title": "Zone de danger",
  "settings.mcp.danger.disable": "Désactiver ce serveur",
  "settings.mcp.danger.disableHint":
    "Conserve ses réglages mais l’arrête. Ses outils disparaissent et les autorisations qui leur ont été accordées prennent fin.",
  "settings.mcp.danger.disableAction": "Désactiver",
  "settings.mcp.danger.enable": "Activer ce serveur",
  "settings.mcp.danger.enableHint": "Le redémarre. Ses secrets demandent votre approbation.",
  "settings.mcp.danger.enableAction": "Activer",
  "settings.mcp.danger.remove": "Supprimer ce serveur",
  "settings.mcp.danger.removeHint": "Supprime ses réglages. Les secrets de votre coffre y restent.",
  "settings.mcp.json.toggle": "Coller du JSON",
  "settings.mcp.json.label": "JSON du serveur",
  "settings.mcp.json.hint":
    "Le format mcpServers habituel. Les clés et jetons vont dans votre coffre, pas dans les réglages.",
  "settings.mcp.json.fill": "Remplir le formulaire",
  "settings.mcp.json.choose": "Quel serveur ?",
  "settings.mcp.json.empty": "Collez d’abord le JSON d’un serveur.",
  "settings.mcp.json.invalid": "Ce n’est pas du JSON valide.",
  "settings.mcp.json.shape": "Un objet JSON avec une entrée mcpServers était attendu.",
  "settings.mcp.json.noServers": "Aucun serveur avec une commande ou une URL dans ce JSON.",
  "settings.mcp.json.secrets":
    "{n, plural, one {# secret} other {# secrets}} du JSON {n, plural, one {sera enregistré} other {seront enregistrés}} dans votre coffre : {names}.",
  "settings.mcp.json.ignored": "Non repris : {names}.",
  "settings.searchSources.title": "Sources de recherche",
  "settings.searchSources.description":
    "Ce que Psyche lit dans votre index de recherche. Tout est désactivé tant que vous ne l’activez pas ; l’index reste sur ce Mac. Activer une source permet aussi à la mémoire d’en tirer des enseignements, sauf si vous refusez dans Mémoire → Sources (Mémoire et Contacts font exception : aucun n’est utilisé pour apprendre).",
  "settings.searchSources.hint.mail":
    "Objet, expéditeur, destinataires, date et texte de vos e-mails dans Apple Mail. Les réponses citées sont ignorées.",
  "settings.searchSources.hint.messages":
    "Vos conversations iMessage, par discussion et par jour. Les messages d’autres personnes ne sont jamais traités comme des instructions.",
  "settings.searchSources.hint.notes": "Titre et texte de vos Notes Apple.",
  "settings.searchSources.hint.calendar":
    "Événements des trois dernières années et des douze prochains mois : titre, heure, lieu, participants et notes.",
  "settings.searchSources.hint.reminders": "Rappels et leurs listes, échéances et notes.",
  "settings.searchSources.hint.contacts":
    "Vos Contacts Apple : nom, surnom, société, poste, e-mails, numéros de téléphone, ville et pays de chaque adresse, et anniversaire. Les adresses postales, notes et groupes ne sont jamais lus. L’agent ne peut pas les rechercher tant que vous ne l’autorisez pas, et ce réglage ne concerne que cet index : ce que la mémoire a appris sur les personnes, et leurs pages avec e-mails ou numéros, suivent l’accès agent propre à la mémoire.",
  "settings.searchSources.hint.files":
    "Fichiers texte, code, PDF, Word et Excel dans les dossiers que vous avez partagés. Les images sont indexées par nom.",
  "settings.searchSources.hint.browser":
    "Pages que le navigateur de Psyche lit pour vous, conservées 90 jours. Les pages privées, de connexion et de paiement ne sont jamais conservées.",
  "settings.searchSources.hint.transcripts":
    "Mémos vocaux et réunions, séparés par intervenant. Les paroles des autres ne sont jamais traitées comme des instructions.",
  "settings.searchSources.hint.memory":
    "Ce dont Psyche se souvient : vos personnes, projets, travaux à rendre et événements, et les faits que Psyche a acceptés. Tout ce qui est sensible, en attente de vérification, appris d’une source que l’agent ne peut pas rechercher ou gardé privé est exclu. La mémoire n’apprend pas de cet index et doit être activée.",
  "settings.searchSources.runOnBatteryHint":
    "Permet à l’indexation, à la reconstruction et à la lecture du texte dans les images de se poursuivre sur batterie, à un rythme plus doux. Cela consomme plus de batterie. Le mode économie d’énergie suspend toujours l’indexation.",
  "settings.searchSources.cannotEnable": "Impossible de l’activer pour l’instant : {why}",
  "settings.searchSources.cannotAgent": "L’agent ne peut pas encore rechercher ici : {why}",
  "settings.searchSources.state.off": "Désactivé : non lu",
  "settings.searchSources.state.unavailable": "Activé, mais indisponible : {why}",
  "settings.searchSources.state.error": "Problème : {why}",
  "settings.searchSources.state.indexing":
    "Indexation : {n, plural, one {# élément} other {# éléments}} jusqu’ici",
  "settings.searchSources.state.idle": "À jour : {n, plural, one {# élément} other {# éléments}}",
  "settings.searchSources.neverIndexed": "Pas encore indexé",
  "settings.searchSources.lastIndexed": "Dernière indexation {when}",
  "settings.searchSources.rebuild": "Reconstruire",
  "settings.searchSources.rebuildLabel": "Reconstruire {source}",
  "settings.searchSources.rebuilding": "Reconstruction…",
  "settings.searchSources.rebuild.turnOnFirst": "Activez d’abord {source}",
  "settings.searchSources.rebuild.starting": "Reconstruction de {source}…",
  "settings.searchSources.rebuild.progress":
    "Reconstruction de {source} : {n, plural, one {# élément lu} other {# éléments lus}} jusqu’ici. Le processus se poursuit en arrière-plan.",
  "settings.searchSources.rebuild.done":
    "{source} reconstruit : {n, plural, one {# élément} other {# éléments}}.",
  "settings.searchSources.rebuild.failed": "Impossible de reconstruire {source} : {why}",
  "settings.searchSources.agent": "Laisser l’agent de Psyche rechercher ici",
  "settings.searchSources.agentLabel": "Recherche de l’agent pour {source}",
  "settings.searchSources.ocr": "Lire le texte dans les images (OCR)",
  "settings.searchSources.ocrHint":
    "Lit les captures d’écran et les PDF numérisés avec Apple Vision, page par page, sur secteur (ou sur batterie si Indexer sur batterie est activé). Rien ne quitte votre Mac.",
  "settings.searchSources.ocrLabel": "Lire le texte dans les images pour {source}",
  "settings.searchSources.processing": "Traitement",
  "settings.searchSources.processingLabel": "Traitement pour {source}",
  "settings.searchSources.processing.cloud": "Modèle cloud (actuel)",
  "settings.searchSources.processing.local": "Modèle local",
  "settings.searchSources.processing.none": "Aucun : pas de résumés",
  "settings.searchSources.excludeContacts": "Ne jamais indexer ces contacts",
  "settings.searchSources.excludeContactsHint":
    "Adresses e-mail, numéros de téléphone ou noms, séparés par des virgules",
  "settings.searchSources.excludeFolders": "Ne jamais indexer ces dossiers",
  "settings.searchSources.excludeFoldersPlaceholder": "~/Documents/Private",
  "settings.searchSources.indexSize": "Taille de l’index de recherche : {size}",
  "settings.semanticSearch.title": "Recherche par sens",
  "settings.semanticSearch.description":
    "Retrouvez des éléments par leur sens autant que par leurs mots, le tout sur ce Mac.",
  "settings.semanticSearch.enabledHint":
    "Télécharge un modèle de 118 Mo la première fois. La désactivation supprime l’index des sens.",
  "settings.semanticSearch.engine.builtin": "Modèle intégré",
  "settings.semanticSearch.engine.builtinHint":
    "Multilingual E5 small, environ 100 langues, s’exécute sur le processeur de ce Mac.",
  "settings.semanticSearch.engine.router": "Mon serveur de modèles local",
  "settings.semanticSearch.engine.routerHint":
    "Utilise le modèle d’embedding défini dans Rôles, par exemple Ollama ou LM Studio sur ce Mac.",
  "settings.semanticSearch.state.off": "Désactivé : la recherche fait correspondre les mots",
  "settings.semanticSearch.state.starting": "Démarrage…",
  "settings.semanticSearch.state.downloading":
    "Téléchargement du modèle : {received} sur {total} Mo",
  "settings.semanticSearch.state.indexing": "Indexation des sens : {done} sur {total}",
  "settings.semanticSearch.state.ready":
    "Activé : {n, plural, one {# passage indexé} other {# passages indexés}}",
  "settings.semanticSearch.state.readyCloud":
    "Activé, avec un service cloud : {n, plural, one {# passage indexé} other {# passages indexés}}",
  "settings.semanticSearch.allowCloudHint":
    "Uniquement si le modèle d’embedding est un service cloud. Vos discussions, tâches et le texte de la Bibliothèque lui sont envoyés. Désactivé, tout reste sur ce Mac.",
  "settings.semanticSearch.state.noModel":
    "Aucun modèle d’embedding n’est défini dans Rôles. Choisissez-en un ou utilisez le modèle intégré.",
  "settings.semanticSearch.state.cloudBlocked":
    "Le modèle d’embedding défini dans Rôles est un service cloud. La recherche sémantique n’utilise que des modèles présents sur ce Mac.",
  "settings.semanticSearch.state.error": "Arrêté : {reason}",
  "settings.webSearch.description":
    "Comment l’agent effectue ses recherches sur le web. Les pages web ne sont jamais traitées comme vos instructions.",
  "settings.data.description":
    "Tout ce que {persona} conserve reste sur cet appareil. Rien n’est envoyé pour l’entraînement.",
  "settings.data.advancedHint": "Cartes et images dans les widgets",
  "settings.data.keep": "Durée de conservation",
  "settings.data.keepHint":
    "Les anciennes réflexions et relectures de tâches sont supprimées automatiquement.",
  "settings.data.danger": "Supprimer et repartir de zéro",
  "settings.memoryControls.title": "Bases",
  "settings.memoryControls.description":
    "Choisissez ce dont {persona} se souvient et d’où il apprend. Chaque option peut être désactivée à tout moment.",
  "settings.learning.title": "Apprendre des retours",
  "settings.learning.implicit": "Remarquer les modifications, annulations et rejets",
  "settings.learning.implicitHint":
    "Envoyer un brouillon modifié ou annuler une action compte comme un retour.",
  "settings.learning.signals": "Signaux",
  "settings.learning.signal.draftEdits": "Modifications de brouillons",
  "settings.learning.signal.undo": "Annulations",
  "settings.learning.signal.approvalEdits": "Modifications d’approbations",
  "settings.learning.signal.dismissals": "Rejets",
  "settings.learning.paused": "Suspendre l’apprentissage",
  "settings.learning.pausedHint":
    "Tant que c’est activé, rien n’est lu ni écrit, et rien n’est rattrapé ensuite.",
  "settings.learning.weeklyCard": "Carte hebdomadaire « Ce que j’ai appris »",
  "settings.learning.weeklyCardHint":
    "Une publication dans Feed le dimanche, uniquement s’il y a quelque chose à vérifier.",
  "settings.learning.open": "Ce que {persona} a appris",
  "settings.learning.openButton": "Ouvrir Progression",
  "settings.learning.forgetAll": "Oublier tout ce que {persona} a appris",
  "settings.learning.forgetAllTitle": "Oublier tout ce que {persona} a appris de vous ?",
  "settings.learning.forgetAllBody":
    "Ses notes, son Âme et ses compétences reviennent à ce que vous avez écrit. Saisissez « {phrase} » pour confirmer.",
  "settings.learning.forgetPhrase": "oublier",
  "settings.learning.forgetAllGo": "Tout oublier",
  "settings.learning.forgotAll":
    "{lessons, plural, one {# leçon} other {# leçons}} et {events, plural, one {# retour} other {# retours}} oubliés.",
  "settings.data.reasoningRetentionHint":
    "Durée de conservation de la réflexion complète de chaque étape. Désactivé, un résumé d’une ligne est conservé.",
  "settings.data.recallModeHint":
    "Vos fichiers de mémoire Markdown restent la source de référence. Les embeddings permettent à chaque tour de retrouver des souvenirs par leur sens.",
  "settings.data.recallMode.markdown": "Markdown seul",
  "settings.data.recallMode.markdownHint":
    "Lit les fichiers et fait correspondre les mots. Rien de plus à exécuter.",
  "settings.data.recallMode.embeddings": "Markdown plus embeddings",
  "settings.data.recallMode.embeddingsHint":
    "Utilise le même choix d’embedding que la recherche. Le modèle se charge au besoin et est libéré au repos.",
  "settings.data.recallState.off": "Markdown seul.",
  "settings.data.encryptMemory": "Chiffrer la mémoire sur le disque",
  "settings.data.encryptMemoryHint":
    "Conserve ce que {persona} sait sur les personnes dans un fichier chiffré, avec la clé dans votre coffre. La désactivation recopie d’abord tout.",
  "settings.data.encryptMemory.restart": "S’activera au prochain démarrage de Psyche.",
  "settings.data.encryptMemory.on": "Chiffrée.",
  "settings.data.encryptMemory.pending": "En attente de la clé de l’assistant Mac.",
  "settings.data.encryptMemory.unavailable": "Indisponible : {why}",
  "settings.data.encryptMemory.offDone":
    "La mémoire est de retour dans la base principale ; le fichier chiffré a été supprimé.",
  "settings.data.recallState.semantic":
    "Rappel par le sens et par les mots : {vectors} passages de mémoire sur {chunks} indexés.",
  "settings.data.recallState.modelMissing":
    "Le modèle d’embedding n’est pas encore téléchargé, le rappel ne fait donc correspondre que les mots. Activez la recherche sémantique dans Réglages → Connecteurs et sources → Recherche pour le télécharger.",
  "settings.data.recallState.cloudBlocked":
    "Le service d’embedding n’est pas autorisé à recevoir votre mémoire, le rappel ne fait donc correspondre que les mots.",
  "settings.data.recallState.textOnly":
    "Aucun modèle d’embedding n’est disponible, le rappel ne fait donc correspondre que les mots.",
  "settings.data.replayRetentionHint":
    "Les écrans que {persona} a regardés pendant son travail, pour la chronologie. Désactivé, aucun n’est conservé.",
  "settings.devices.presenceKey.keychain": "Clé Touch ID (trousseau), signalée par l’assistant",
  "settings.devices.presenceKey.enclaveKeychainAcl":
    "Clé Touch ID (Secure Enclave, lisible sans invite macOS uniquement par l’assistant Psyche), signalée par l’assistant",
  "settings.devices.presenceKey.enclaveFile":
    "Clé Touch ID (fichier Secure Enclave, cette version n’a pas de profil de provisionnement), signalée par l’assistant",
  "settings.devices.presenceKey.unknown": "Clé Touch ID (type non signalé par l’assistant)",
  "settings.devices.touchId.none":
    "Pas encore de clé Touch ID. Les cartes qui exigent Touch ID ne peuvent pas être approuvées tant qu’aucune n’est enregistrée.",
  "settings.devices.touchId.bundled": "Le Psyche Helper de cette app affiche la clé",
  "settings.devices.touchId.notBundled":
    "Cet assistant n’est pas celui fourni avec cette app, sa clé ne peut donc pas être enregistrée ici.",
  "settings.devices.touchId.untrusted":
    "La clé Touch ID du trousseau n’a pas été utilisée, car rien ne prouve qu’elle appartient à l’assistant Psyche. Une cause bénigne : Psyche a été déplacé ou réinstallé ailleurs, remettez-le dans /Applications et rouvrez-le. Sinon, quittez d’abord l’assistant Psyche, lancez /Applications/Psyche.app/Contents/Resources/PsycheHelper.app/Contents/MacOS/psyche-helper --reset-presence-key dans le Terminal, puis enregistrez la nouvelle clé.",
  "settings.devices.touchId.accessDenied":
    "macOS n’a pas autorisé l’assistant Psyche à utiliser sa clé Touch ID du trousseau. Relancez Psyche et choisissez Toujours autoriser seulement si la fenêtre nomme psyche-helper (jamais pour un autre programme).",
  "settings.devices.touchId.wrongLocation":
    "L’assistant Psyche n’a pas créé de clé Touch ID, car il s’exécute depuis une image disque, Téléchargements ou un autre dossier. Déplacez Psyche dans /Applications, éjectez toute image disque et ouvrez-le depuis là.",
  "settings.devices.touchId.keyMismatch":
    "L’assistant Psyche de cette app affiche maintenant la clé {shown}, et non celle enregistrée {registered}. Si vous n’avez pas réinitialisé la clé vous-même, considérez cela comme suspect et ne l’enregistrez pas.",
  "settings.devices.touchId.confirmReplace":
    "Cela remplace la clé Touch ID {previous} enregistrée pour ce Mac. Ne la remplacez que si vous avez réinitialisé la clé vous-même.",
  "settings.devices.touchId.confirmReplaceButton": "Remplacer la clé",
  "settings.devices.touchId.interactionNotAllowed":
    "Le trousseau ne peut pas demander l’autorisation pour le moment. Déverrouillez le Mac et réessayez.",
  "settings.devices.touchId.changed":
    "La clé Touch ID a changé pendant l’exécution de l’assistant Psyche. Quittez l’assistant Psyche et relancez-le.",
  "settings.devices.touchId.aclUnavailable":
    "Le trousseau n’a pas conservé la liste d’accès de la clé Touch ID sur ce Mac. Relancez l’assistant Psyche pour réessayer.",
  "settings.devices.touchId.noBundledKey":
    "Le Psyche Helper de cette app n’a pas de clé Touch ID ({reason}).",
  "settings.devices.touchId.register": "Enregistrer cette clé",
  "settings.devices.touchId.remove": "Supprimer la clé",
  "settings.devices.touchId.manualLabel": "ID de la clé",
  "settings.devices.touchId.manualHint":
    "Exécutez psyche-helper --print-identity sur le Mac et collez la presenceKeyId affichée.",
  "settings.devices.touchId.allowDevFileKey": "Autoriser une clé Touch ID de développement",
  "settings.devices.touchId.devFileKey":
    "Cette version n’a pas de profil de provisionnement, sa clé est donc un fichier Secure Enclave. Toute app exécutée sous votre identité pourrait lui demander de signer derrière sa propre invite Touch ID. Pour le développement uniquement.",
  "settings.files.execHost": "Exécuter des commandes sur ce Mac",
  "settings.files.execHostHint":
    "Permet à {persona} d’exécuter des commandes dans vos dossiers partagés, dans le bac à sable. Les commandes susceptibles de modifier des fichiers demandent d’abord votre accord.",
  "settings.files.execHostSwitch": "Autoriser les commandes sur ce Mac",
  "settings.files.readOnlyQuiet": "Exécuter les commandes en lecture seule sans demander",
  "settings.files.readOnlyQuietHint":
    "Les commandes de base sur les fichiers et les informations qui ne font que lire, comme ls, cat ou wc, s’exécutent dans le bac à sable sans carte. Tout le reste demande, git compris, de même que chaque commande après que {persona} a lu quelque chose venant de l’extérieur.",
  "settings.files.revoke": "Révoquer",
  "settings.files.description":
    "{persona} n’accède qu’à ce que vous autorisez et demande dans la discussion quand il a besoin de plus.",
  "settings.files.foldersHint":
    "Lecture seule permet à {persona} d’ouvrir et de rechercher dans un dossier ; lecture et écriture lui permet d’enregistrer des modifications. La révocation prend effet immédiatement.",
  "settings.files.addYourself": "Ajouter un dossier vous-même",
  "settings.files.addYourselfHint":
    "Généralement inutile : {persona} demande quand une tâche nécessite un dossier. Les dossiers ajoutés commencent en lecture seule.",
  "settings.access.title": "Ce à quoi {persona} peut accéder",
  "settings.access.listLabel": "Ce à quoi {persona} peut accéder",
  "settings.access.empty":
    "Rien pour l’instant. Quand {persona} a besoin d’un dossier ou d’une app, il vous le demande dans la discussion, et ce que vous autorisez apparaît ici.",
  "settings.access.scope.always": "Toujours",
  "settings.access.scope.conversation": "Cette discussion",
  "settings.access.scope.limited": "Pour l’instant",
  "settings.access.used": "utilisé {when}",
  "settings.access.revokeNamed": "Révoquer {name}",
  "settings.access.loadLabel": "ce à quoi Psyche peut accéder",
  "settings.access.loadFailed": "Psyche n’a pas pu charger ce à quoi il peut accéder ({reason}).",
  "settings.access.unchanged": "L’accès est inchangé.",
  "settings.model.advancedHint": "Limites de contexte, modèles locaux",
  "settings.permissions.subject.prepNotes": "Notes intitulées « Prep: » (préparation de réunion)",
  "settings.permissions.specificConnectors":
    "Les autorisations d’un connecteur précis se définissent sur sa page dans Connecteurs.",
  "settings.permissions.openConnectors": "Ouvrir Connecteurs",
  "settings.persona.description": "L’apparence de {name} et sa façon de se présenter.",
  "settings.persona.whileWorking": "Pendant le travail",
  "settings.persona.showReasoningHint":
    "Affiche le raisonnement de {persona} pendant son travail. Jamais enregistré.",
  "settings.connectors.page.onHost": "Sur {host}",
  "settings.connectors.page.row.onHost": "Sur {host}",
  "settings.computerUse.remote":
    "L’utilisation de l’ordinateur fonctionne chez {host}. Demandez depuis là-bas, ou utilisez le navigateur.",
  "settings.gateways.title": "Gateways sur cet ordinateur",
  "settings.gateways.description":
    "Utilisez Psyche depuis cet ordinateur avec la Gateway d’un autre, par exemple votre Mac à la maison. Une seule Gateway est active à la fois, et en changer redémarre Psyche.",
  "settings.gateways.loadLabel": "Gateways enregistrées",
  "settings.gateways.thisMac": "Ce Mac",
  "settings.gateways.active": "Connectée",
  "settings.gateways.pinned": "Identité épinglée",
  "settings.gateways.notPinned": "Épingle son identité lors de la première connexion",
  "settings.gateways.switch": "Changer",
  "settings.gateways.switchTo": "Passer à {name}",
  "settings.gateways.switchTitle": "Passer à {name} ?",
  "settings.gateways.switchKeep":
    "Psyche redémarre sur {name}. Psyche continue de fonctionner sur ce Mac, ses automatisations se poursuivent donc.",
  "settings.gateways.switchOnly": "Changer",
  "settings.gateways.switchAndStop": "Changer et arrêter Psyche sur ce Mac",
  "settings.gateways.pairAgain": "Jumeler à nouveau",
  "settings.gateways.pairAgainNamed": "Jumeler à nouveau avec {name}",
  "settings.gateways.forget": "Oublier",
  "settings.gateways.forgetNamed": "Oublier {name}",
  "settings.gateways.add": "Ajouter une Gateway",
  "settings.gateways.addressLabel": "Lien de jumelage ou adresse",
  "settings.gateways.addressPlaceholder": "studio-mac.your-tailnet.ts.net",
  "settings.gateways.nameLabel": "Nom (facultatif)",
  "settings.gateways.addHint":
    "Collez le lien de jumelage du Mac qui exécute Psyche (Réglages, Serveur et accès à distance, Jumeler un autre ordinateur). Sans lien, saisissez son adresse Tailscale, https://<host>.<tailnet>.ts.net ; cet ordinateur demande alors le jumelage, et le propriétaire l’approuve là-bas.",
  "settings.gateways.newLink": "Un nouveau lien de jumelage est arrivé. L’utiliser ?",
  "settings.gateways.useNewLink": "Utiliser",
  "settings.gateways.ignoreNewLink": "Ignorer",
  "settings.gateways.fromLink":
    "Ouvert depuis un lien de jumelage. Vérifiez-le, puis appuyez sur Ajouter une Gateway. Psyche vous demande de confirmer l’adresse avant de se connecter.",
  "settings.gateways.adding": "Ajouter une Gateway",
  "settings.gateways.problem.empty": "Saisissez l’adresse de la Gateway.",
  "settings.gateways.problem.invalid": "Cette adresse n’est pas utilisable par Psyche.",
  "settings.gateways.problem.needs_full_name":
    "Utilisez le nom complet, par exemple studio-mac.your-tailnet.ts.net. Un nom court ne peut pas être vérifié.",
  "settings.gateways.problem.needs_https":
    "Utilisez une adresse https://. Le http simple ne fonctionne que via un tunnel SSH sur cet ordinateur.",
  "settings.gateways.problem.has_path": "Indiquez uniquement l’adresse, sans chemin.",
  "settings.gateways.problem.has_credentials": "Omettez tout nom d’utilisateur ou mot de passe.",
  "settings.gateways.problem.link_not_a_pairing_link": "Ce n’est pas un lien de jumelage.",
  "settings.gateways.problem.link_unsupported_version":
    "Ce lien de jumelage provient d’une version plus récente de Psyche. Mettez à jour Psyche sur cet ordinateur, puis réessayez.",
  "settings.gateways.problem.link_malformed":
    "Ce lien de jumelage est endommagé. Copiez-le à nouveau depuis le Mac qui l’a créé.",
  "settings.gateways.problem.link_extra_fields":
    "Ce lien de jumelage contient quelque chose que Psyche ne comprend pas, il n’est donc pas utilisé.",
  "settings.gateways.problem.link_bad_field":
    "Ce lien de jumelage est endommagé. Copiez-le à nouveau depuis le Mac qui l’a créé.",
  "settings.gateways.problem.link_lan":
    "Ce lien de jumelage concerne un ordinateur de votre réseau local mais ne contient pas son certificat, il n’est donc pas utilisé. Sur ce Mac, créez-en un nouveau : Jumeler un autre ordinateur, Depuis ce réseau.",
  "settings.gateways.problem.link_not_lan":
    "Ce lien de jumelage indique une adresse qui n’est pas sur un réseau local, il n’est donc pas utilisé.",
  "settings.gateways.problem.link_pin_mismatch":
    "Cette Gateway est déjà enregistrée avec une autre identité. Utilisez d’abord Jumeler à nouveau, puis ajoutez le lien.",
  "settings.gateways.problem.failed": "Impossible d’ajouter la Gateway. Rien n’a changé.",
  "settings.gateways.problem.declined": "L’ajout de la Gateway a été annulé.",
  "settings.gateways.problem.actionFailed": "Cela n’a pas fonctionné. Rien n’a changé.",
  "settings.remote.title": "Autoriser d’autres ordinateurs",
  "settings.remote.description":
    "Permettez à Psyche sur un autre ordinateur d’utiliser la Gateway de ce Mac via Tailscale. La Gateway reste sur ce Mac et n’écoute que Tailscale, et Tailscale Serve est la seule voie d’accès.",
  "settings.remote.step1":
    "Installez Tailscale sur ce Mac et sur l’autre ordinateur, et connectez les deux au même tailnet.",
  "settings.remote.step2":
    "Dans Terminal sur ce Mac, publiez la Gateway sur votre tailnet. Il s’agit de Serve, pas de Funnel.",
  "settings.remote.copyCommand": "Copier la commande",
  "settings.remote.copied": "Copié",
  "settings.remote.step3":
    "Indiquez son adresse à la Gateway. Dans config.json, dans le dossier de données de Psyche, définissez :",
  "settings.remote.step4":
    "Redémarrez Psyche. Puis, sur l’autre ordinateur, ajoutez ce Mac comme Gateway. Il affiche un code de jumelage et une empreinte de clé : comparez-les avec la demande sous En attente de jumelage ici, puis approuvez-la.",
  "settings.remote.funnel":
    "N’activez jamais Tailscale Funnel pour cela. Cela exposerait la Gateway sur l’internet public.",
  "settings.remote.configWarnings":
    "config.json contient des réglages que cette version de Psyche ne connaît pas et qu’elle ignore : {keys}. Si vous visiez l’un d’eux, vérifiez l’orthographe.",
  "settings.uninstall.group": "Désinstaller Psyche",
  "settings.uninstall.groupHint":
    "Arrête le Gateway et l’assistant, et place l’app dans la Corbeille. Vos données restent, sauf si vous choisissez autrement.",
  "settings.uninstall.open": "Désinstaller Psyche…",
  "settings.uninstall.title": "Désinstaller Psyche",
  "settings.uninstall.description":
    "Tout ce qui suit est placé dans la Corbeille, vous pouvez donc le récupérer. Rien n’est supprimé définitivement.",
  "settings.uninstall.dataChoice": "Vos données",
  "settings.uninstall.keep": "Conserver mes données",
  "settings.uninstall.keepHint":
    "Les discussions, la mémoire, le coffre et les sauvegardes restent dans le dossier de données.",
  "settings.uninstall.delete": "Supprimer mes données",
  "settings.uninstall.deleteHint":
    "Place aussi le dossier de données dans la Corbeille : discussions, mémoire, coffre et sauvegardes.",
  "settings.uninstall.willDo": "Ce qui va se passer",
  "settings.uninstall.stopAgent": "Le LaunchAgent du Gateway est arrêté et supprimé.",
  "settings.uninstall.stopHelper":
    "Psyche Helper est arrêté et « Ouvrir à la connexion » est désactivé.",
  "settings.uninstall.trash": "Placé dans la Corbeille",
  "settings.uninstall.kind.agent": "LaunchAgent du Gateway",
  "settings.uninstall.kind.support": "Application Support",
  "settings.uninstall.kind.cache": "Caches, journaux, préférences et état enregistré",
  "settings.uninstall.kind.data": "Vos données",
  "settings.uninstall.kind.app": "L’app",
  "settings.uninstall.agentOther":
    "L’agent du Gateway appartient à une autre copie de Psyche ou à l’outil en ligne de commande ; il est donc laissé tel quel.",
  "settings.uninstall.blocked":
    "{path} ne peut pas être placé dans la Corbeille depuis ici : {reason}",
  "settings.uninstall.keychainStays":
    "Les éléments du trousseau restent (la clé du coffre et ceux de l’assistant). Supprimez-les dans Trousseau d’accès si vous le souhaitez.",
  "settings.uninstall.keychainGoes":
    "Les éléments du trousseau pour le coffre et l’assistant sont aussi supprimés.",
  "settings.uninstall.removeKeychain":
    "Supprimer aussi mes éléments du trousseau (com.psyche.vault et ceux de l’assistant). Sans vos données, ils sont inutiles.",
  "settings.uninstall.kind.state": "État enregistré des fenêtres",
  "settings.uninstall.dataStays": "Votre dossier de données n’est pas touché.",
  "settings.uninstall.typeWord": "Saisissez {word} pour confirmer",
  "settings.uninstall.presence":
    "Il vous sera ensuite demandé de confirmer avec Touch ID ou sur cet appareil, car cela supprime vos données.",
  "settings.uninstall.approvalLabel": "Désinstaller Psyche et supprimer les données",
  "settings.uninstall.failed":
    "Psyche n’a pas pu se désinstaller ({reason}). Rien d’autre n’a été modifié.",
  "settings.uninstall.cancel": "Annuler",
  "settings.uninstall.go": "Désinstaller et quitter",
  "settings.uninstall.goDelete": "Supprimer les données et désinstaller",
  "settings.remote.admin":
    "Un ordinateur jumelé obtient la lecture, l’écriture et les approbations. Admin reste désactivé sauf si vous le cochez lors de l’approbation, et chaque modification d’admin exige toujours votre Touch ID ici.",
  "settings.remote.address": "Adresse publique",
  "settings.remote.addressUnset": "Non définie",
  "settings.remote.proxy": "Proxy de confiance",
  "settings.remote.on": "Activé",
  "settings.remote.off": "Désactivé",
  "settings.remote.fingerprint": "Clé de cette Gateway",
  "settings.remote.fingerprintHint":
    "Comparez-la avec l’empreinte que l’autre ordinateur affiche lors de la première connexion.",
  "settings.remote.loadLabel": "Identité de la Gateway",
  "settings.remote.clientNote":
    "Cet ordinateur est un client de {host}. L’accès à distance se configure sur {host}.",
  "settings.pair.title": "Jumeler un autre ordinateur",
  "settings.pair.description":
    "Créez un lien de jumelage, ou un code QR, pour Psyche sur un autre ordinateur. Il fonctionne une seule fois, pendant dix minutes, et l’ordinateur qui l’utilise est jumelé avec les accès que vous cochez ici, sans seconde approbation.",
  "settings.pair.needsAddress":
    "Définissez d’abord l’adresse publique de ce Mac (étape 3 ci-dessus), puis créez un lien de jumelage.",
  "settings.pair.scopes": "Ce que l’autre ordinateur peut faire",
  "settings.pair.adminHint":
    "Admin lui permet de modifier les réglages de sécurité, les appareils et le coffre, et reste désactivé sauf si vous le cochez. Chaque modification d’admin exige toujours votre Touch ID ici.",
  "settings.pair.make": "Créer un lien de jumelage",
  "settings.pair.resultRegion": "Lien de jumelage et code QR",
  "settings.pair.qrLabel": "Code QR du lien de jumelage pour {host}",
  "settings.pair.scan":
    "Sur l’autre ordinateur, choisissez Ajouter une Gateway et collez ce lien pour {host}.",
  "settings.pair.expires": "Expire {when}.",
  "settings.pair.linkLabel": "Lien de jumelage",
  "settings.pair.copy": "Copier le lien",
  "settings.pair.gives": "Une fois utilisé, cet ordinateur obtient : {scopes}.",
  "settings.pair.compare":
    "Il vérifie la clé de ce Mac avant d’utiliser le lien : {fingerprint}. Vous pouvez comparer.",
  "settings.pair.secret":
    "Quiconque possède ce lien dans les dix prochaines minutes peut jumeler un ordinateur. Ne le publiez pas et ne l’envoyez à personne à qui vous ne confieriez pas ce Mac.",
  "settings.pair.live": "Liens de jumelage inutilisés",
  "settings.pair.unused": "Pas encore utilisé",
  "settings.pair.revoke": "Révoquer",
  "settings.pair.revokeNamed": "Révoquer le lien de jumelage créé {when}",
  "settings.pair.madeToast": "Lien de jumelage créé. Il fonctionne une fois, pendant dix minutes.",
  "settings.pair.usedToast": "Un ordinateur s’est jumelé avec votre lien.",
  "settings.pair.gone": "Le lien de jumelage n’est plus valide et n’est donc plus affiché.",
  "settings.pair.err.noAddress":
    "Ce Mac n’a pas encore d’adresse publique, il n’y a donc rien à mettre dans un lien.",
  "settings.pair.err.tooMany":
    "Il y a déjà trois liens de jumelage inutilisés. Révoquez-en un ou attendez qu’il expire.",
  "settings.pair.err.forbidden":
    "Seul Psyche sur l’hôte lui-même, jumelé comme administrateur, peut créer un lien de jumelage.",
  "settings.pair.err.failed": "Impossible de créer le lien de jumelage ({reason}).",
  "settings.pair.via": "D’où l’autre ordinateur se connectera-t-il ?",
  "settings.pair.viaAddress": "Via Tailscale, à l’adresse de ce Mac",
  "settings.pair.viaLan": "Depuis ce réseau",
  "settings.pair.viaLanHint":
    "Un lien pour ce réseau contient la clé et le certificat de ce Mac, et ne fonctionne donc que pour les ordinateurs sur le même Wi-Fi ou Ethernet.",
  "settings.pair.lanNote":
    "Ce lien est destiné aux ordinateurs du même réseau que ce Mac. Il nomme la clé et le certificat que Psyche exigera.",
  "settings.pair.err.noLan":
    "Activez Autoriser les ordinateurs de ce réseau et attendez que la Gateway soit à l’écoute pour créer un lien pour ce réseau.",
  "settings.key.gateway.lan": "Autoriser les ordinateurs de ce réseau",
  "settings.key.gateway.lan.rotateCert": "Le certificat réseau",
  "settings.lan.title": "Autoriser les ordinateurs de ce réseau",
  "settings.lan.description":
    "Permettez à Psyche sur un autre ordinateur du même Wi-Fi ou Ethernet d’accéder à la Gateway de ce Mac, sans Tailscale. C’est désactivé tant que vous ne l’activez pas.",
  "settings.lan.loadLabel": "Accès réseau",
  "settings.lan.unsupported": "Cette Gateway est trop ancienne pour écouter sur le réseau.",
  "settings.lan.toggle": "Autoriser les ordinateurs de ce réseau",
  "settings.lan.toggleHint":
    "Psyche écoute sur un réseau, via une connexion chiffrée avec son propre certificat. Un ordinateur qui se connecte doit tout de même être approuvé ici avec Touch ID.",
  "settings.lan.ipv6": "Utiliser aussi les adresses IPv6 de ce réseau",
  "settings.lan.ipv6Hint":
    "Ajoute les adresses IPv6 privées (elles commencent par fd ou fc) du réseau choisi. Les adresses IPv6 publiques et les adresses fe80 ne sont jamais utilisées.",
  "settings.lan.problem.ipv6Off":
    "{address} est une adresse IPv6 et IPv6 est désactivé, Psyche n’y écoute donc pas. Activez IPv6 ci-dessus, ou supprimez-la.",
  "settings.lan.problem.ipv6NeedsIpv4":
    "Psyche n’écoute pas sur {address}. IPv6 n’est utilisé qu’avec l’adresse IPv4 de ce réseau, que vous devez d’abord autoriser ici.",
  "settings.lan.interface": "Réseau",
  "settings.lan.interfaceDefault": "Réseau principal",
  "settings.lan.interfaceOption": "{name} ({address})",
  "settings.lan.noInterface": "Aucune connexion Wi-Fi ou Ethernet n’a été trouvée sur ce Mac.",
  "settings.lan.trustedOnly":
    "N’activez ceci que sur un réseau de confiance. Sur un Wi-Fi partagé ou invité, toute personne connectée peut accéder à l’écran de jumelage.",
  "settings.lan.status": "Statut",
  "settings.lan.listening": "À l’écoute sur {addresses}",
  "settings.lan.notListening": "N’écoute pas",
  "settings.lan.address": "Adresse",
  "settings.lan.discovery": "Détection",
  "settings.lan.advertised": "Visible pour Psyche sur ce réseau",
  "settings.lan.notAdvertised": "Non visible. Ajoutez ce Mac par son adresse.",
  "settings.lan.certificate": "Certificat",
  "settings.lan.certificateHint":
    "Les ordinateurs qui se jumèlent s’en souviennent. Si vous remplacez le certificat, ils doivent tous se jumeler à nouveau.",
  "settings.lan.rotate": "Remplacer le certificat",
  "settings.lan.rotateTitle": "Remplacer le certificat réseau ?",
  "settings.lan.rotateBody":
    "Les ordinateurs déjà jumelés via le réseau ne se connecteront plus tant qu’ils ne se seront pas jumelés à nouveau. Utilisez ceci si vous pensez que le certificat a été copié.",
  "settings.lan.rotateConfirm": "Remplacer et déconnecter",
  "settings.lan.rotateFailed": "Impossible de remplacer le certificat ({reason}). Rien n’a changé.",
  "settings.lan.problem.unknownInterface": "{name} n’est pas un réseau de ce Mac.",
  "settings.lan.problem.noInterface":
    "Il n’y a aucun réseau sur lequel écouter, rien n’est donc à l’écoute.",
  "settings.lan.problem.bindFailed":
    "Impossible d’écouter sur {address}. Un autre programme utilise peut-être le port.",
  "settings.lan.problem.paused":
    "L’accès LAN est suspendu sur ce réseau. Vous l’avez activé pour un autre.",
  "settings.lan.allowHere": "Autoriser sur ce réseau",
  "settings.lan.problem.cert":
    "Psyche n’a pas pu créer ni lire son certificat réseau et n’écoute donc pas.",
  "settings.lan.problem.cloudflare":
    "Cette Gateway est configurée pour n’être joignable que via Cloudflare Access et n’écoute donc pas en plus sur le réseau.",
  "settings.gateways.discoverConflict":
    "Plusieurs ordinateurs ont annoncé ce nom avec des clés différentes, Psyche ne l’ajoute donc pas. Ajoutez le bon par son adresse.",
  "settings.lan.problem.container":
    "Une Gateway dans un conteneur n’écoute pas sur le réseau de cette façon.",
  "settings.lan.problem.advertise":
    "Psyche n’a pas pu s’annoncer sur le réseau. Les ordinateurs peuvent toujours ajouter ce Mac par son adresse.",
  "settings.gateways.discover": "Rechercher sur ce réseau",
  "settings.gateways.discovering": "Recherche…",
  "settings.gateways.discoverTitle": "Sur ce réseau",
  "settings.gateways.discoverNone":
    "Aucun Psyche trouvé. Sur cet ordinateur, activez Autoriser les ordinateurs de ce réseau.",
  "settings.gateways.discoverFailed":
    "Impossible de rechercher sur le réseau. Ajoutez-le plutôt par son adresse.",
  "settings.gateways.discoverKey": "Clé {fingerprint}",
  "settings.gateways.discoverHint":
    "Ce qu’un ordinateur annonce sur le réseau n’est qu’une affirmation. L’écran de jumelage affiche sa clé : comparez-la avec celle de l’hôte avant d’approuver.",
  "settings.gateways.discoverAdd": "Ajouter {name}",
  "settings.gateways.discoverSaved": "Enregistrée",
  "settings.devices.gatewayKey": "Clé de cette Gateway {fingerprint}",
  "settings.devices.fromAddress": "Depuis {address}",
  "settings.devices.fromLan":
    "Depuis {address}, sur votre réseau. Vérifiez la clé complète ci-dessous.",
  "settings.devices.adminOptIn":
    "Admin permet à cet ordinateur de modifier les réglages de sécurité, les appareils et le coffre. Laissez-le désactivé sauf si nécessaire.",
  "settings.skills.signer.title": "Qui l’a créé",
  "settings.skills.signer.unsigned":
    "Non signé. Rien n’indique qui l’a créé ni qu’il n’a pas été modifié en chemin ; il s’installe donc comme provenant d’un éditeur inconnu.",
  "settings.skills.signer.new": "Signé par {name}. Vous n’avez jamais vu cette clé.",
  "settings.skills.signer.seen":
    "Signé par {name}, avec une clé que vous avez déjà vue mais en laquelle vous n’avez pas confiance.",
  "settings.skills.signer.trusted": "Signé par {name}, un auteur de confiance.",
  "settings.skills.signer.own": "Signé par vous.",
  "settings.skills.signer.changed":
    "Signé par {name}, mais pas avec la clé vue précédemment. Vérifiez qu’il s’agit de la même personne avant de l’installer.",
  "settings.skills.signer.changedUpdate":
    "Signé par {name}, avec une clé différente de celle de la version installée. Vérifiez qu’il s’agit de la même personne avant de mettre à jour.",
  "settings.skills.signer.dropped":
    "La version installée a été signée par {name}. Celle-ci n’est pas signée du tout.",
  "settings.skills.signer.impersonates":
    "Signé par {name}, ce qui ressemble au nom avec lequel vous signez vos propres compétences, mais la clé n’est pas la vôtre. Ne l’installez que si vous savez d’où il vient.",
  "settings.skills.signer.nameChanged":
    "Signé avec une clé de confiance, mais sous un nom qu’elle n’a pas utilisé auparavant : {name}. Vérifiez qu’il s’agit toujours de la même personne.",
  "settings.skills.signer.originAgent":
    "Rédigé par un assistant sur le Mac de l’expéditeur. Lisez-le comme un texte non vérifié, quel que soit le signataire.",
  "settings.skills.widened.specialist": "Rôle en arrière-plan",
  "settings.skills.bundleOriginAgent": "Rédigé par un assistant ailleurs",
  "settings.skills.export.label": "Signature de « {name} »",
  "settings.skills.author.label": "Confiance envers les auteurs",
  "settings.skills.signer.claim":
    "Le nom est une déclaration de l’auteur. C’est la clé qui relie les versions entre elles.",
  "settings.skills.signer.key": "Clé de l’auteur",
  "settings.skills.signer.trust": "Faire confiance à {name} en tant qu’auteur",
  "settings.skills.signer.trustHint":
    "Les versions ultérieures signées avec cette clé seront marquées comme provenant d’un auteur de confiance. Chaque installation demande toujours votre accord d’abord.",
  "settings.skills.widened.title": "Demande plus que la version installée",
  "settings.skills.widened.hint":
    "L’approuver n’accorde aucune autorisation en soi, mais cela entraînera désormais aussi ces questions.",
  "settings.skills.widened.permissions": "Nouvelles autorisations",
  "settings.skills.widened.tools": "Nouveaux outils",
  "settings.skills.widened.prompts": "Nouveaux fichiers de prompt",
  "settings.skills.import.file": "Importer un fichier…",
  "settings.skills.import.hint":
    "Un fichier .psyche-skill d’une autre personne, ou un lien https vers celui-ci. Il est vérifié et vous est présenté avant toute installation.",
  "settings.skills.import.failed": "Psyche n’a pas pu lire ce fichier ({reason}).",
  "settings.skills.import.tooBig": "ce fichier dépasse 8 Mo",
  "settings.skills.signedBy": "Signé par {name}",
  "settings.skills.signedState":
    "{state, select, own {vous} trusted {de confiance} revoked {révoqué} other {non fiable}}",
  "settings.skills.export": "Exporter…",
  "settings.skills.export.title": "Exporter « {name} »",
  "settings.skills.export.hint":
    "Le fichier est signé avec votre clé d’auteur, afin que ceux qui le reçoivent puissent voir qu’il vient de vous et qu’il n’a pas été modifié. La clé reste sur ce Mac.",
  "settings.skills.export.nameLabel": "Nom pour la signature",
  "settings.skills.export.nameHint":
    "Défini une seule fois. Toute personne qui importe vos compétences le voit.",
  "settings.skills.export.go": "Exporter et signer",
  "settings.skills.exported":
    "« {name} » exporté sous {file}, signé en tant que {author}.{created, select, true { Votre clé d’auteur a été créée : {key}.} other {}}",
  "settings.skills.author.trust": "Faire confiance à cet auteur",
  "settings.skills.author.untrust": "Ne plus faire confiance à cet auteur",
  "settings.skills.author.revoke": "Révoquer cet auteur",
  "settings.skills.author.revokeTitle": "Révoquer la clé de {name} ?",
  "settings.skills.author.revokeDescription":
    "Les compétences signées avec elle ne se chargent plus, et les nouveaux fichiers signés avec elle sont refusés. Vous pourrez lui refaire confiance plus tard.",
  "settings.skills.author.revokeConfirm": "Révoquer",
  "settings.usage.unavailable": "L’utilisation n’est pas encore disponible depuis cette Gateway.",
  "settings.usage.thisMonth": "Ce mois-ci",
  "settings.usage.monthLine":
    "{cost} et {tokens} jetons sur {turns, plural, one {# tour} other {# tours}}. Aujourd’hui jusqu’ici : {today}.",
  "settings.usage.noBudget": "Aucun budget mensuel n’est défini.",
  "settings.usage.byModel": "7 derniers jours par modèle",
  "settings.usage.model": "Modèle",
  "settings.usage.turns": "{n, plural, one {# tour} other {# tours}}",
  "settings.usage.planWindow":
    "{model} : {pct} % de la fenêtre du forfait utilisés, réinitialisation {when}.",
  "settings.vm.enabledHint":
    "Les tâches qui l’exigent s’exécutent dans l’invité, avec uniquement les dossiers que vous partagez.",
  "settings.vm.credentialsHint":
    "Avec le coffre de l’hôte, les valeurs restent sur votre Mac. Un coffre invité conserve sa propre copie.",
  "settings.voice.anyAppHint":
    "partout où vous saisissez du texte. Le texte va à votre curseur, jamais à l’agent ni à un champ de mot de passe.",
  "settings.voice.talkHint":
    "Un bouton Voix dans la zone de saisie lance une conversation orale. La voix n’approuve jamais rien.",
  "settings.people.title": "Personnes et projets",
  "settings.people.description":
    "Les fiches que {persona} tient pour les personnes et les projets de votre vie. Elles restent sur ce Mac, et chaque fait indique sa provenance.",
  "settings.people.loadLabel": "Chargement des réglages Personnes et projets",
  "settings.people.off":
    "Désactivé. {persona} ne tient aucune fiche pour les personnes et projets de votre vie.",
  "settings.people.turnOn": "Activer",
  "settings.people.graph": "Apprendre les personnes à partir de",
  "settings.people.entityRecall": "Utiliser les noms dans les réponses",
  "settings.people.entityRecallHint":
    "Quand vous nommez quelqu’un dans une discussion privée, {persona} ajoute une ligne sur cette personne. Jamais dans les groupes ni les canaux.",
  "settings.people.sources": "Apprendre les personnes à partir de",
  "settings.people.sourcesHint":
    "Chaque source est désactivée tant que vous ne l’activez pas. La désactiver en arrête la lecture.",
  "settings.people.source.contacts": "Contacts",
  "settings.people.source.mail": "Mail",
  "settings.people.source.calendar": "Calendrier",
  "settings.people.source.messages": "Messages",
  "settings.people.source.messagesHint":
    "Utilise à qui vous écrivez et quand, jamais le texte des messages.",
  "settings.people.source.notes": "Notes",
  "settings.people.source.chats": "Vos discussions",
  "settings.people.sourceOff": "Désactivé",
  "settings.people.sourceCounts":
    "{entities, plural, one {# personne ou projet} other {# personnes et projets}} · {interactions, plural, one {# interaction} other {# interactions}} · {read, select, none {pas encore lu} other {lu à {read}}}",
  "settings.people.retention": "Durée de conservation des interactions",
  "settings.people.retentionLabel": "Conserver les interactions pendant",
  "settings.people.retentionHint":
    "Les anciens en-têtes et liens sont supprimés chaque nuit. Les fiches, faits et points ouverts restent jusqu’à ce que vous les oubliiez.",
  "settings.people.months": "{n, plural, one {# mois} other {# mois}}",
  "settings.people.learning": "Comment les fiches sont tenues",
  "settings.people.learningHint":
    "Les résumés, rôles et points ouverts proviennent du modèle utilitaire, local par défaut.",
  "settings.people.budget":
    "Cette nuit : {tokens, number} jetons sur {maxTokens, number}, {entities, number} personnes et projets sur {maxEntities, number}. Les résumés, rôles et points ouverts proviennent du modèle utilitaire, local par défaut.",
  "settings.people.nightly": "Chaque nuit",
  "settings.people.nightlyHint":
    "Actualise les résumés et trouve les points ouverts pendant que vous dormez.",
  "settings.people.afterRun": "Après chaque tâche",
  "settings.people.afterRunHint":
    "Met à jour les quelques personnes et projets concernés par une tâche.",
  "settings.people.precision": "Points ouverts suggérés que vous avez conservés : {list}.",
  "settings.people.precisionItem": "{source} {confirmed, number} sur {total, number}",
  "settings.people.aboutYou": "À propos de vous",
  "settings.people.aboutYouHint":
    "Votre propre fiche : chaque fait que {persona} a appris sur vous, avec sa source.",
  "settings.people.openOwnCard": "Ouvrir votre fiche",
  "settings.people.ownCardHint":
    "Faits vous concernant issus de votre profil, de vos discussions et de vos apps connectées.",
  "settings.people.editUserMd": "Modifier USER.md",
  "settings.people.blocked": "Bloqués dans Personnes",
  "settings.people.blockedHint":
    "Plus rien n’est jamais appris à leur sujet. Un domaine bloqué couvre toutes ses adresses.",
  "settings.people.noneBlocked": "Personne n’est bloqué.",
  "settings.people.blockedOn": "{kind} · bloqué le {date}",
  "settings.people.unblock": "Débloquer",
  "settings.people.unblockLabel": "Débloquer {hint}",
  "settings.people.block": "Bloquer",
  "settings.people.blockKindLabel": "Quoi bloquer",
  "settings.people.blockValue": "Adresse, téléphone ou domaine",
  "settings.people.blockKind.email": "Adresse e-mail",
  "settings.people.blockKind.phone": "Numéro de téléphone",
  "settings.people.blockKind.domain": "Domaine",
  "settings.people.blockKind.contact": "Contact",
  "settings.people.blockKind.channel": "Canal",
  "settings.people.blockKind.calendar": "Calendrier",
  "settings.people.blockKind.url": "Adresse web",
  "settings.people.blockPlaceholder.email": "name@example.com",
  "settings.people.blockPlaceholder.phone": "+33 1 23 45 67 89",
  "settings.people.blockPlaceholder.domain": "example.com",
  "settings.people.nothingStored": "Rien n’est encore stocké depuis aucune source.",
  "settings.people.sourceStored":
    "{entities, plural, one {# personne ou projet} other {# personnes et projets}} · {interactions, plural, one {# interaction} other {# interactions}}",
  "settings.people.deleteSource": "Supprimer…",
  "settings.people.deleteSourceLabel": "Supprimer ce qu’a apporté {source}",
  "settings.people.deleteSourceTitle": "Supprimer ce qu’a apporté {source} ?",
  "settings.people.deleteSourceAfter":
    "{source} est désactivé pour que la prochaine synchronisation ne le ramène pas. Les faits que vous avez ajoutés vous-même restent.",
  "settings.people.deleteSourceConfirm": "Supprimer",
  "settings.people.deletedSource": "Ce qu’a apporté {source} a été supprimé.",
  "settings.people.forgetAll": "Tout sur les personnes et les projets",
  "settings.people.forgetAllHint":
    "Supprime chaque personne, projet, fiche et point ouvert, et désactive Personnes et projets. Vos propres fichiers de mémoire restent.",
  "settings.people.forgetAllButton": "Oublier…",
  "settings.people.forgetAllTitle": "Oublier tout sur les personnes et les projets ?",
  "settings.people.forgetAllAfter":
    "Cette action est irréversible. Personnes et projets se désactive ; réactivez-le pour repartir de zéro.",
  "settings.people.typeToConfirm": "Saisissez « {phrase} » pour confirmer",
  "settings.people.forgetAllConfirm": "Tout oublier",
  "settings.people.forgotAll": "Tout sur les personnes et les projets a été oublié.",
  "settings.people.counting": "Vérification de ce qui serait supprimé…",
  "settings.people.previewFailed": "Psyche n’a pas pu compter ce qu’il supprimerait ({reason}).",
  "settings.people.removeCounts":
    "Psyche supprime {entities, plural, one {# personne ou projet} other {# personnes et projets}}, {facts, plural, one {# fait} other {# faits}}, {interactions, plural, one {# interaction} other {# interactions}}, {loops, plural, one {# point ouvert} other {# points ouverts}} et {identifiers, plural, one {# adresse} other {# adresses}}.",
  "settings.specialists.title": "Spécialistes",
  "settings.specialists.description":
    "Tâches en arrière-plan avec un rôle nommé, chacune dans son budget, qui livrent un résultat dans votre boîte de réception.",
  "settings.specialists.all": "Tous les spécialistes",
  "settings.specialists.concurrent": "Spécialistes simultanés",
  "settings.specialists.concurrentHint":
    "Davantage s’exécutent en parallèle ; les autres attendent dans la file.",
  "settings.specialists.monthlyCap": "Dépenses mensuelles",
  "settings.specialists.monthlyCapHint":
    "Les nouvelles tâches attendent du budget une fois la limite atteinte. Vide, la moitié de votre budget mensuel est utilisée{budget, select, none {} other { ({budget})}}.",
  "settings.specialists.monthlyCapNone": "Aucun plafond",
  "settings.specialists.showInFeed": "Afficher les résultats dans Feed",
  "settings.specialists.showInFeedHint":
    "Votre boîte de réception reçoit de toute façon chaque résultat.",
  "settings.specialists.roles": "Rôles",
  "settings.specialists.rolesHint":
    "Un rôle provient d’une compétence. Un rôle que vous avez installé reste désactivé tant que vous ne l’activez pas.",
  "settings.specialists.turnOn": "{role} activé",
  "settings.specialists.summary": "{model} · {budget} · {mode}",
  "settings.specialists.budgetLine": "{tokens} jetons · {cost} · {minutes} min",
  "settings.specialists.edit": "Modifier",
  "settings.specialists.done": "Terminé",
  "settings.specialists.editLabel": "Modifier {role}",
  "settings.specialists.model": "Modèle",
  "settings.specialists.modelDefault": "Par défaut : {class}",
  "settings.specialists.class.utility": "modèle utilitaire",
  "settings.specialists.class.primary": "modèle principal",
  "settings.specialists.class.harness": "harnais de code",
  "settings.specialists.class.vision": "modèle principal avec vision",
  "settings.specialists.budget": "Budget par tâche",
  "settings.specialists.budgetTokens": "Jetons",
  "settings.specialists.budgetCost": "Coût (USD)",
  "settings.specialists.budgetMinutes": "Minutes",
  "settings.specialists.budgetCaps":
    "Jusqu’à {tokens} jetons · {cost} · {minutes} min. Une tâche peut en demander plus, jamais au-delà.",
  "settings.specialists.maxMode": "Le maximum qu’il peut faire sans demander",
  "settings.specialists.mode.plan": "Plan",
  "settings.specialists.mode.manual": "Manuel",
  "settings.specialists.mode.balanced": "Équilibré",
  "settings.specialists.mode.auto": "Auto",
  "settings.specialists.installed": "Depuis {skill}",
  "settings.specialists.empty": "Aucune compétence ne définit encore de spécialiste.",
  "settings.language.description": "Langue du texte et format des dates et des nombres.",
  "settings.language.languageHint": "Tout ce qui n’est pas encore traduit s’affiche en anglais.",
  "settings.persona.identityHint": "Nom et slogan.",
  "settings.persona.avatarHint": "Choisissez une créature ou décrivez une modification.",
  "settings.persona.whileWorkingHint": "Ce que vous voyez pendant l’exécution d’une tâche.",
  "settings.daily.group.briefHint": "Un court résumé pour bien démarrer la journée.",
  "settings.daily.group.wrapupHint": "Un retour sur ce qui a été fait.",
  "settings.daily.group.deliveryHint": "Comment ils vous parviennent.",
  "settings.daily.group.automationsHint": "Tâches récurrentes que Psyche exécute pour vous.",
  "settings.voice.dictationHint": "Parler au lieu de taper.",
  "settings.usage.byThreadHint": "Où sont passés les jetons et les coûts.",
  "settings.skills.installedHint": "Compétences que Psyche peut utiliser maintenant.",
  "settings.about.versionsHint": "Ce qui s’exécute sur ce Mac.",
  "settings.specialists.allHint": "Activez ou désactivez des rôles et définissez leurs budgets.",
  "settings.vm.sandboxMacHint": "Où les commandes s’exécutent.",
  "settings.computerUse.macPermissionsHint": "Ce que macOS a autorisé.",
  "settings.voice.advancedHint": "Moteur vocal",
  "settings.files.advancedHint": "Laisser Psyche exécuter des commandes dans les dossiers partagés",
  "settings.browser.advancedHint": "Signer les requêtes web de Psyche",
  "settings.skills.advancedHint": "Compétences fournies avec Psyche",
  "settings.skills.madeByAgent": "Créé par {persona}",
  "settings.skills.history":
    "{n, plural, one {# version antérieure} other {# versions antérieures}}",
  "settings.skills.historyItem":
    "v{version} · approuvée {approved} · {retiredBy, select, delete {supprimée} other {remplacée}} {retired}",
  "settings.skills.historyHint":
    "Conservées à titre de référence. Ces versions ne sont jamais chargées.",
  "settings.mcp.madeBy": "Créé par Psyche",
  "settings.mcp.madeByHint":
    "Psyche a rédigé le code de ce connecteur. Il ne s’exécute que dans le bac à sable, uniquement avec le code que vous avez approuvé, et ses outils demandent avant de modifier quoi que ce soit.",
  "settings.mcp.code.title": "Code",
  "settings.mcp.code.view": "Voir le code",
  "settings.mcp.code.hide": "Masquer le code",
  "settings.mcp.code.loading": "Chargement du code…",
  "settings.mcp.code.version": "Version {version} · {runtime} · démarre {entry}",
  "settings.mcp.code.modified":
    "Le code sur le disque n’est pas la version que vous avez approuvée ; ce connecteur reste donc arrêté jusqu’à ce que vous approuviez la modification.",
  "settings.mcp.code.file": "{path} · {bytes} o",
  "settings.mcp.code.edit": "Modifier {file}",
  "settings.mcp.code.editing": "Modification de {file}",
  "settings.mcp.code.save": "Enregistrer pour vérification",
  "settings.mcp.code.saving": "Enregistrement…",
  "settings.mcp.code.cancel": "Annuler la modification",
  "settings.mcp.code.provided": "Fourni par Psyche, identique pour chaque connecteur",
  "settings.mcp.code.approved": "{name} mis à jour.",
  "settings.mcp.code.denied":
    "Modification de {name} non approuvée. Il reste arrêté jusqu’à ce que vous en approuviez une.",
  "settings.deviceAccess.files.title": "Fichiers sur ce Mac",
  "settings.deviceAccess.files.hint":
    "Les dossiers que {persona} peut lire, et modifier là où vous l’autorisez. Vous les partagez dans Autorisations → Accès.",
  "settings.deviceAccess.files.more": "{count, plural, one {et 1 autre} other {et # autres}}",
  "settings.deviceAccess.open": "Ouvrir Accès",
  "settings.deviceAccess.terminal.title": "Terminal",
  "settings.deviceAccess.terminal.hint":
    "{persona} peut exécuter des commandes de terminal sur ce Mac lorsque Exécuter des commandes sur ce Mac est activé dans Autorisations → Accès.",
  "settings.deviceAccess.terminal.where":
    "Les commandes s’exécutent sur votre Mac, dans les dossiers que vous avez partagés, et ne peuvent écrire que dans un dossier partagé en lecture et écriture.",
  "settings.deviceAccess.terminal.asks":
    "Les commandes susceptibles de modifier des fichiers demandent d’abord, sauf si vous choisissez d’autoriser toujours cette commande exacte. Les commandes de base en lecture seule comme ls, cat ou wc s’exécutent sans demander, sauf si vous le désactivez.",
  "settings.deviceAccess.terminal.sandbox":
    "Les commandes s’exécutent dans le bac à sable. Une exécution approuvée n’en sort que si vous saisissez UNSANDBOXED sur sa carte.",
  "settings.deviceAccess.terminal.on": "L’exécution de commandes est activée",
  "settings.deviceAccess.terminal.off": "L’exécution de commandes est désactivée",
  "settings.deviceAccess.terminal.folders":
    "{count, plural, =0 {Aucun dossier partagé pour l’instant : les commandes n’ont nulle part où s’exécuter.} one {1 dossier partagé.} other {# dossiers partagés.}}",
  "settings.mcp.needs.title": "Ce dont cela a besoin sur votre Mac",
  "settings.mcp.needs.srt": "Bac à sable (srt)",
  "settings.mcp.needs.srt.fix": "Tient le serveur à l’écart des données privées de Psyche.",
  "settings.mcp.needs.node": "Outils Node.js (npm)",
  "settings.mcp.needs.node.fix":
    "S’exécute sur le propre Node de Psyche ; nécessite npm sur ce Mac. Installez Node.js depuis nodejs.org, ou exécutez brew install node.",
  "settings.mcp.needs.uv": "uv (uvx)",
  "settings.mcp.needs.uv.fix":
    "Un serveur Python. Installez uv avec brew install uv ou depuis docs.astral.sh/uv.",
  "settings.mcp.needs.network": "Réseau",
  "settings.mcp.needs.network.fix": "Accède à l’adresse propre du serveur.",
  "settings.mcp.needs.networkHosts":
    "N’accède qu’à {hosts} pour télécharger et exécuter le serveur.",
  "settings.mcp.needs.missing": "Manquant",
  "settings.mcp.needs.ready": "Prêt",
  "settings.mcp.needs.checked": "Vérifié lors de Vérifier le serveur",
  "settings.mcp.fail.no_srt":
    "Le bac à sable n’est pas installé. Configurez-le ci-dessous, puis vérifiez à nouveau le serveur.",
  "settings.mcp.fail.node_missing":
    "Installez Node.js (nodejs.org, ou brew install node) pour que npm soit présent sur ce Mac, puis vérifiez à nouveau.",
  "settings.mcp.fail.uv_missing":
    "Installez uv (brew install uv, ou docs.astral.sh/uv), puis vérifiez à nouveau le serveur.",
  "settings.mcp.fail.command_not_found":
    "La commande du serveur n’est pas installée ici. Vérifiez la commande, ou installez l’outil qu’elle nomme.",
  "settings.mcp.fail.network_blocked":
    "Le serveur n’a pas pu télécharger ou atteindre ce dont il a besoin. Vérifiez votre connexion et que ses hôtes sont autorisés.",
  "settings.mcp.fail.timeout":
    "Cela a pris trop de temps. La première exécution télécharge le paquet ; vérifiez votre connexion et réessayez.",
  "settings.mcp.fail.exited":
    "Le serveur s’est arrêté juste après son démarrage. Sa dernière sortie figure ci-dessous.",
  "settings.mcp.fail.failed": "Consultez la sortie du serveur ci-dessous, puis réessayez.",
  "settings.mcp.fail.exitCode": "Code de sortie {code}.",
  "settings.mcp.fail.output": "Sortie du serveur",
  "settings.connectors.page.description":
    "Les apps et outils que {persona} peut utiliser. Chacun demande avant d’agir, sauf indication contraire de votre part.",
  "settings.connectors.page.needsYou": "Vous attend",
  "settings.connectors.page.connected": "Connecté",
  "settings.connectors.page.onThisMac": "Sur ce Mac",
  "settings.connectors.page.addMore": "Ajouter d’autres",
  "settings.connectors.page.addMore.hint":
    "Mail, calendrier, notes et outils prêts à l’emploi. Chacun demande avant d’agir.",
  "settings.connectors.page.addMore.browse": "Tout parcourir",
  "settings.connectors.page.status.paused": "En pause",
  "settings.connectors.page.status.notWorking": "Ne fonctionne pas",
  "settings.connectors.page.status.signInExpired": "Connexion expirée",
  "settings.connectors.page.status.on": "Activé",
  "settings.connectors.page.status.off": "Désactivé",
  "settings.connectors.page.paused": "En pause",
  "settings.connectors.page.open": "Ouvrir {name}",
  "settings.connectors.page.manage": "Gérer",
  "settings.connectors.page.fix.seeWhy": "Voir pourquoi",
  "settings.connectors.page.row.never": "Pas encore utilisé",
  "settings.connectors.page.row.lastUsed": "Utilisé {when}",
  "settings.connectors.page.row.unverified": "Non vérifié",
  "settings.connectors.page.row.local": "S’exécute sur ce Mac",
  "settings.connectors.page.row.remote": "Se connecte via le web",
  "settings.connectors.page.row.files":
    "{count, plural, =0 {Aucun dossier partagé} one {1 dossier partagé} other {# dossiers partagés}}",
  "settings.connectors.page.row.terminal.on": "Peut exécuter des commandes",
  "settings.connectors.page.row.terminal.off": "Les commandes sont désactivées",
  "settings.connectors.page.detail.label": "Détails de {name}",
  "settings.connectors.page.detail.about": "À propos",
  "settings.connectors.page.detail.access": "Accès",
  "settings.connectors.page.detail.source": "Source",
  "settings.connectors.page.detail.technical": "Détails techniques",
  "settings.connectors.page.detail.manage": "Mettre en pause ou supprimer",
  "settings.connectors.page.detail.type": "Type",
  "settings.connectors.page.detail.removeHint":
    "Déconnecter le met en pause et conserve ses réglages. Supprimer l’efface.",
  "settings.connectors.page.source.builtIn": "Intégré à Psyche",
  "settings.connectors.page.source.verified": "Éditeur vérifié",
  "settings.connectors.page.source.unverified": "Pas encore vérifié par quiconque",
  "settings.connectors.page.attention.signIn":
    "Votre connexion à {name} a expiré. Reconnectez-vous pour qu’il continue de fonctionner.",
  "settings.connectors.page.attention.error":
    "{name} ne fonctionne pas pour le moment. Essayez de vous reconnecter ; si cela échoue encore, supprimez-le puis ajoutez-le à nouveau.",
  "settings.connectors.page.attention.errorReason": "Message reçu : {reason}",
  "settings.connectors.page.attention.server":
    "{name} n’a pas démarré, ses outils ne sont donc pas disponibles.",
  "settings.connectors.page.attention.serverHint":
    "Vérifiez sa commande ou son adresse et les secrets ci-dessous, puis désactivez-le et réactivez-le.",
  "settings.connectors.page.server.local": "Un outil qui s’exécute dans un bac à sable sur ce Mac",
  "settings.connectors.page.server.remote": "Un outil auquel on accède par une adresse web",
  "settings.connectors.page.server.network": "Accède au réseau",
  "settings.connectors.page.server.noNetwork": "Aucun réseau",
  "settings.connectors.page.advanced": "Avancé",
  "settings.connectors.page.advanced.hint":
    "Vos propres serveurs d’outils et une recherche dans le registre public.",
  "settings.connectors.page.advanced.custom": "Votre propre serveur d’outils",
  "settings.connectors.page.advanced.customHint":
    "Exécutez n’importe quel serveur MCP dans le bac à sable, ou connectez-vous à un serveur par adresse web.",
  "settings.connectors.page.advanced.customAction": "Ajouter un serveur",
  "settings.connectors.page.advanced.find": "Trouver des serveurs en ligne",
  "settings.connectors.page.gallery.title": "Ajouter un connecteur",
  "settings.connectors.page.gallery.intro":
    "Choisissez quelque chose à essayer. Chacun demande avant d’agir, et vous pouvez le retirer à tout moment.",
  "settings.connectors.page.gallery.noMatch": "Aucun résultat. Essayez un autre mot.",
  "settings.connectors.page.gallery.back": "Retour à la galerie",
  "settings.connectors.page.gallery.community": "Communauté",
  "settings.nav.memory": "Vérification",
  "settings.nav.everything": "Sources",
  "settings.learnMore": "En savoir plus",
  "settings.learnLess": "Afficher moins",
  "settings.nav.work": "Travail",
  "settings.nav.surfaces": "Où la mémoire s’affiche",
  "settings.key.memory.work": "Travail en mémoire",
  "settings.key.memory.surfaces": "Où la mémoire s’affiche",
  "settings.key.memory.work.enabled": "Suivre mon travail",
  "settings.key.memory.work.trackedLists": "Listes de Rappels suivies comme travail",
  "settings.key.memory.work.anchorsFromFolders": "Quels dossiers comptent comme travail",
  "settings.key.memory.work.remind.enabled": "Me rappeler ce qui est à rendre demain",
  "settings.key.memory.work.remind.dueSoonHours":
    "Jusqu’où chercher à l’avance ce qui est à rendre",
  "settings.key.memory.work.remind.dayOf": "Me dire aussi le matin ce qui est à rendre aujourd’hui",
  "settings.key.memory.surfaces.tiers.work.home": "Travail dans Home",
  "settings.key.memory.surfaces.tiers.work.brief": "Travail dans le résumé quotidien",
  "settings.key.memory.surfaces.tiers.work.notification": "Travail dans les notifications",
  "settings.key.memory.surfaces.tiers.work.channel": "Travail dans le résumé envoyé à un canal",
  "settings.key.memory.surfaces.tiers.workMail.home": "E-mails de travail dans Home",
  "settings.key.memory.surfaces.tiers.workMail.brief":
    "E-mails de travail dans le résumé quotidien",
  "settings.key.memory.surfaces.tiers.workMail.notification":
    "E-mails de travail dans les notifications",
  "settings.key.memory.surfaces.tiers.workMail.channel":
    "E-mails de travail dans le résumé envoyé à un canal",
  "settings.key.memory.surfaces.tiers.people.home": "Personnes dans Home",
  "settings.key.memory.surfaces.tiers.people.brief": "Personnes dans le résumé quotidien",
  "settings.key.memory.surfaces.tiers.people.notification": "Personnes dans les notifications",
  "settings.key.memory.surfaces.tiers.people.channel": "Personnes dans le résumé envoyé à un canal",
  "settings.key.memory.surfaces.birthdays":
    "Anniversaires et dates anniversaires dans le résumé et dans Home",
  "settings.key.memory.surfaces.hideSources":
    "Exclure une source de Home, des résumés et des notifications",
  "settings.key.memory.surfaces.kinds.project": "Afficher les projets en dehors de Mémoire",
  "settings.key.memory.surfaces.kinds.course": "Afficher les cours en dehors de Mémoire",
  "settings.key.memory.surfaces.kinds.assignment": "Afficher les tâches en dehors de Mémoire",
  "settings.key.memory.surfaces.kinds.event": "Afficher les événements en dehors de Mémoire",
  "settings.recording.madeBy": "Issu d’un enregistrement",
  "settings.recording.open": "L’exécuter chaque semaine",
  "settings.recording.title": "L’exécuter selon un planning",
  "settings.recording.checking": "Vérification des étapes.",
  "settings.recording.cannot": "Celui-ci ne peut pas s’exécuter en votre absence :",
  "settings.recording.reason.sensitive":
    "L’étape {step} est un champ que vous remplissez vous-même.",
  "settings.recording.reason.input": "L’étape {step} vous demande une valeur à chaque fois.",
  "settings.recording.reason.unreadable":
    "Ses étapes sont illisibles. Enregistrez-le à nouveau pour le planifier.",
  "settings.recording.reason.browserOnly":
    "Les exécutions planifiées ne concernent pour l’instant que les enregistrements de navigateur.",
  "settings.recording.reason.off": "Il est désactivé ou a changé depuis votre approbation.",
  "settings.recording.reason.notRecording":
    "Ce n’est pas une compétence issue d’un enregistrement.",
  "settings.recording.cannotWhy":
    "Une exécution planifiée n’a personne à qui demander ; elle ne remplit donc jamais de mot de passe et ne demande jamais de valeur. Vous pouvez toujours l’exécuter vous-même depuis la discussion.",
  "settings.recording.rules":
    "Vous choisissez quand. Chaque exécution utilise vos approbations habituelles. Si la page a changé ou si une étape exige votre approbation, elle s’arrête à cette étape, se met en pause et vous prévient. Elle ne devine jamais.",
  "settings.recording.every": "Chaque",
  "settings.recording.daily": "jour",
  "settings.recording.weekly": "semaine le",
  "settings.recording.monthly": "mois le",
  "settings.recording.dayOfWeek": "Jour de la semaine",
  "settings.recording.dayOfMonth": "Jour du mois",
  "settings.recording.at": "à",
  "settings.recording.confirm": "Planifier",
  "settings.recording.close": "Annuler",
  "settings.recording.runs": "Exécutions",
  "settings.recording.seeScheduled":
    "mettre en pause, supprimer ou voir l’historique dans Planifié",
  "settings.teach.storage.title": "Enregistrements conservés",
  "settings.teach.storage.description":
    "Quand vous demandez à Psyche de conserver un enregistrement pour pouvoir en créer une autre version, les étapes sont enregistrées sur ce Mac.",
  "settings.teach.storage.encrypted":
    "Chiffré. Le fichier est verrouillé par une clé conservée dans le trousseau de ce Mac et ne peut donc pas être lu en dehors de Psyche. Il expire après 90 jours.",
  "settings.teach.storage.unavailable":
    "Les enregistrements ne sont pas conservés. Le trousseau de ce Mac n’est pas disponible, et Psyche n’enregistre pas un enregistrement en clair. Vous pouvez toujours enregistrer un enregistrement comme compétence.",
  "settings.key.capabilities.onlineSearch": "Rechercher dans le registre MCP en ligne",
  "settings.key.tools.loading": "Quand les outils sont chargés",
  "settings.widgets.title": "Widgets dans la discussion",
  "settings.widgets.privacy":
    "Psyche peut dessiner de petits panneaux dans la discussion : progression, listes, tableaux, graphiques et images. Un panneau peut pointer vers une image sur le web. L’autoriser fait récupérer l’image sur le web par votre Gateway à votre place (sans cookies, sans référent, jamais directement depuis votre appareil), uniquement pour les types d’image courants jusqu’à 512 Ko. Dans un panneau issu d’un contenu non fiable, l’image attend toujours votre clic.",
  "settings.widgets.remoteImages": "Afficher les images du web dans les widgets",
  "settings.widgets.remoteImagesHint":
    "Désactivé par défaut : ces images affichent une courte note et rien n’est récupéré. Une modification exige votre confirmation.",
};
