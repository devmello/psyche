import type { Catalogue } from "../../index.ts";

/** settings-a strings (es); merged into `../es.ts`. */
export const settingsA: Partial<Catalogue> = {
  "settings.essentials.fullAccessNote":
    "El acceso completo se activa por chat, desde el menú de modo del chat.",
  "settings.essentials.description":
    "Las pocas decisiones que toma la mayoría, cada una con un valor seguro por defecto. {persona} pregunta cuando necesita más.",
  "settings.essentials.openPlace": "{place}…",
  "settings.essentials.moreIn": "Más en {place}",
  "settings.essentials.model.title": "Modelo",
  "settings.essentials.model.thinksWith": "{persona} piensa con",
  "settings.essentials.model.ready": "Listo",
  "settings.essentials.model.addKey": "Añadir clave de API…",
  "settings.essentials.model.none": "Aún no hay modelo",
  "settings.essentials.model.noneHint":
    "{persona} necesita un modelo para poder responder. Añade una clave o usa un modelo de este Mac.",
  "settings.essentials.model.setUp": "Configurar un modelo",
  "settings.essentials.asks.title": "Con qué frecuencia {persona} pregunta antes",
  "settings.essentials.memory.title": "Memoria",
  "settings.essentials.memory.remember": "Dejar que {persona} recuerde nuestros chats",
  "settings.essentials.memory.rememberHint":
    "Desactivado pausa la memoria: no se recuerda ni indexa nada nuevo de los chats hasta que lo vuelvas a activar.",
  "settings.essentials.rest":
    "Todo lo demás, y un control más fino de cada uno de estos ajustes, está en las páginas de abajo. Buscar en los ajustes encuentra cualquiera.",
  "settings.searchModel.title": "Modelo para la búsqueda",
  "settings.searchModel.description":
    "Qué modelo lee las preguntas, escribe las tarjetas de contexto y reordena los resultados.",
  "settings.searchModel.utility": "Tu modelo auxiliar",
  "settings.searchModel.utilityHint":
    "El modelo pequeño definido en Modelos. Si es un modelo en la nube, el texto que lee va a ese proveedor.",
  "settings.searchModel.apple":
    "Usar el modelo en el dispositivo de Apple para las tareas de búsqueda privadas",
  "settings.searchModel.appleName": "Modelo en el dispositivo de Apple",
  "settings.searchModel.appleHint":
    "El texto se queda en este Mac: nada que descargar, sin clave, nada se envía a la nube. Lee unos {k}k tokens a la vez, así que el texto largo se omite. Si no puede responder, esa tarea se omite. Nunca recurre a un modelo en la nube.",
  "settings.searchModel.apple.why.off":
    "Apple Intelligence está desactivado. Actívalo en Ajustes del Sistema, en Apple Intelligence y Siri.",
  "settings.searchModel.apple.why.os": "Este Mac necesita macOS 26 o posterior.",
  "settings.searchModel.apple.why.device": "Este Mac o esta región no admite Apple Intelligence.",
  "settings.searchModel.apple.why.notReady":
    "Apple aún está preparando el modelo. Inténtalo de nuevo dentro de un rato.",
  "settings.searchModel.apple.why.unknown": "El modelo no está disponible ahora mismo.",
  "settings.searchModel.apple.whySkipped": "Hasta entonces, esas tareas se omiten.",
  "settings.searchModel.apple.host":
    "Este es un ajuste de {host}. El modelo se ejecuta en {host}, no en este ordenador, y el cambio se aplica a todas las ventanas.",
  "settings.searchModel.apple.ready": "Listo en este Mac",
  "settings.searchModel.apple.needsAi": "Necesita Apple Intelligence",
  "settings.searchModel.apple.notReady": "Preparándose",
  "settings.searchModel.apple.notOnThisMac": "No disponible en este Mac",
  "settings.searchModel.apple.unavailable": "No disponible ahora mismo",
  "settings.search.advancedHint": "Qué modelo lee tus preguntas",
  "settings.search.description":
    "Lo que Psyche indexa para poder encontrar cosas por ti, y qué motor usa en la web.",
  "settings.nav.specialists": "Especialistas",
  "settings.nav.notifications": "Notificaciones",
  "settings.nav.people": "Personas y privacidad",
  "settings.key.appearance.showInDock": "Mostrar en el Dock cuando no hay ventanas abiertas",
  "settings.key.appearance.openAtLogin": "Abrir Psyche al iniciar sesión",
  "settings.key.browser.useSignedInSessions": "Usar mis sesiones iniciadas",
  "settings.key.exec.srtPath": "Ubicación de srt",
  "settings.key.devices.hostHelper.status": "Comprobación del asistente de Linux",
  "settings.key.devices.helper.availability": "Conexión de Psyche Helper",
  "settings.key.devices.hostHelperDeviceId": "Qué Psyche Helper usar",
  "settings.key.search.model.engine": "Modelo para la búsqueda",
  "settings.key.search.semantic.enabled": "Búsqueda semántica (en el dispositivo)",
  "settings.key.search.cards.enabled": "Tarjetas de contexto para la búsqueda",
  "settings.semanticSearch.cardsHint":
    "Un modelo pequeño en la nube escribe un resumen breve de cada elemento guardado. Limitado a unos 200 000 tokens al día.",
  "settings.key.search.encrypt": "Cifrar el índice de búsqueda",
  "settings.semanticSearch.encryptHint":
    "Mantiene el índice de búsqueda ilegible sin una clave guardada por separado. Se aplica en el siguiente inicio y reconstruye el índice una vez.",
  "settings.semanticSearch.encrypt.on": "Índice cifrado",
  "settings.semanticSearch.encrypt.pending":
    "Esperando a que el ayudante del Mac abra el índice cifrado",
  "settings.semanticSearch.encrypt.unavailable": "Sin cifrar: {why}",
  "settings.key.search.rerank.enabled":
    "Reordenar los mejores resultados con un modelo pequeño en la nube",
  "settings.semanticSearch.rerankHint":
    "Un modelo pequeño en la nube pone los mejores resultados primero. Los 20 fragmentos principales salen de este Mac. Desactivado por defecto.",
  "settings.key.search.runOnBattery": "Indexar con batería",
  "settings.key.search.queryModel.enabled": "Leer las preguntas con un modelo pequeño",
  "settings.semanticSearch.queryModelHint":
    "Un modelo pequeño en la nube deduce los filtros de tiempo, persona y fuente. Solo se envía la pregunta, nunca tus elementos.",
  "settings.key.search.semantic.engine": "Motor de embeddings",
  "settings.key.search.semantic.allowCloud": "Permitir un servicio de embeddings en la nube",
  "settings.key.memory.recall.mode": "Cómo se recupera la memoria",
  "settings.key.widgets.remoteImages": "Imágenes remotas en los widgets",
  "settings.key.ui.map.tiles": "Teselas del mapa",
  "settings.key.ui.map.styleUrl": "URL del estilo del mapa",
  "settings.key.ui.map.styleUrlDark": "URL del estilo del mapa (oscuro)",
  "settings.key.teaching.enabled": "Aprender de tus comentarios",
  "settings.key.teaching.implicit": "Fijarse en ediciones, deshacer y descartes",
  "settings.key.teaching.paused": "Pausar el aprendizaje",
  "settings.key.teaching.weeklyCard": "Tarjeta semanal «Lo que aprendí»",
  "settings.key.memory.graph": "Personas y proyectos",
  "settings.key.memory.everything": "Memoria en segundo plano",
  "settings.key.agent.showReasoning": "Mostrar el razonamiento mientras trabaja",
  "settings.key.data.reasoningRetentionDays": "Conservar el razonamiento durante",
  "settings.key.notifications.quietHours.enabled": "Horas de silencio",
  "settings.key.notifications.quietHours.start": "Silencio desde",
  "settings.key.notifications.quietHours.end": "Silencio hasta",
  "settings.notifications.title": "Notificaciones",
  "settings.notifications.helper.title": "Notificaciones de Psyche Helper",
  "settings.notifications.helper.hint":
    "Las notificaciones de aprobación llegan a través de Psyche Helper. Permite que las muestre para recibir las aprobaciones con la ventana cerrada.",
  "settings.notifications.helper.allow": "Permitir notificaciones de Psyche Helper",
  "settings.notifications.helper.denied":
    "Las notificaciones están desactivadas en Ajustes del Sistema",
  "settings.notifications.helper.openSettings": "Abrir Ajustes del Sistema",
  "settings.notifications.description": "Cuándo puede interrumpirte Psyche.",
  "settings.notifications.group.quietHours": "Horas de silencio",
  "settings.notifications.quietHours.hint":
    "Retiene las notificaciones hasta que termine la franja. Las aprobaciones urgentes siguen llegando. El pase nocturno de la memoria tiene sus propias horas, en los ajustes de memoria.",
  "settings.key.ui.onboarding.progress": "Progreso de la introducción",
  "settings.key.permissions.liftedFloors": "Acciones permitidas sin preguntar para {id}",
  "settings.key.specialists.maxConcurrent": "Especialistas a la vez",
  "settings.key.specialists.showInFeed": "Mostrar los resultados de los especialistas en el Feed",
  "settings.key.specialists.enabled": "{role} activado",
  "settings.key.specialists.model": "Modelo de {role}",
  "settings.credentials.payments.description":
    "Una tarjeta de un solo uso, después de que apruebes cada compra. Los números de tarjeta nunca llegan a Psyche.",
  "settings.approval.presenceUnavailable":
    "Esta ventana no puede confirmar que eres tú. Aprueba el cambio en la app Psyche de tu Mac (Touch ID) o desde un dispositivo con llave de acceso. No cambia nada hasta entonces.",
  "settings.doctor.gateway": "Gateway",
  "settings.doctor.gatewayOk": "Responde.",
  "settings.doctor.model": "Modelo",
  "settings.doctor.noModel": "Aún no hay ningún modelo elegido. Añade uno en Ajustes → Modelos.",
  "settings.doctor.sandbox": "Entorno aislado",
  "settings.doctor.noSandbox":
    "No hay ningún entorno aislado disponible, así que los comandos siguen bloqueados.",
  "settings.doctor.memory": "Memoria",
  "settings.doctor.memoryPaused": "La memoria está en pausa: no se recuerda nada nuevo.",
  "settings.doctor.memoryOk": "{files, plural, one {# archivo} other {# archivos}} en la memoria.",
  "settings.appearance.colors": "Colores",
  "settings.appearance.comfort": "Comodidad",
  "settings.appearance.advancedHint":
    "Tono de gris, color personalizado, dirección del texto, comprobación de contraste",
  "settings.appearance.fineTune": "Ajuste fino de los colores",
  "settings.appearance.fineTuneHint": "Para quien quiere un aspecto exacto.",
  "settings.appearance.contrastCheck": "Comprobación de contraste",
  "settings.appearance.contrastCheckHint": "Lo legible que es cada tema, paso a paso.",
  "settings.appearance.background": "Segundo plano",
  "settings.appearance.showInDockHint":
    "Desactivado, Psyche sigue ejecutándose desde la barra de menús cuando se cierra su última ventana.",
  "settings.appearance.openAtLoginHint":
    "Inicia Psyche en la barra de menús cuando inicias sesión, para que las automatizaciones programadas siempre puedan ejecutarse.",
  "settings.appearance.glass.hint":
    "Deja que el contenido se transparente a través de menús, ventanas emergentes y el área de escritura.",
  "settings.browser.description":
    "{persona} navega en su propia ventana. El modo Chrome real usa un perfil aparte en el que inicias sesión una vez.",
  "settings.browser.signedIn.title": "Sitios con sesión iniciada",
  "settings.browser.signedIn.description":
    "Sitios en los que has iniciado sesión en el navegador de Psyche. Las tareas reutilizan estos inicios de sesión.",
  "settings.browser.signedIn.auto": "encontrado automáticamente",
  "settings.browser.useSignedIn.title": "Sesiones iniciadas",
  "settings.browser.useSignedIn.description":
    "{persona} sigue usando tu sesión en el mismo sitio. Escribir, comprar y enviar siguen preguntándote primero.",
  "settings.browser.useSignedIn.label": "Dejar que Psyche use mis sesiones iniciadas",
  "settings.browser.useSignedIn.hint":
    "Activado por defecto. Desactivado abre cada sitio sin sesión, salvo los que elegiste mantener con sesión.",
  "settings.browser.signedIn.none": "Aún no hay sitios con sesión iniciada.",
  "settings.browser.agent.title": "Inicios de sesión del agente",
  "settings.browser.agent.description":
    "Qué inicios de sesión tuyos puede usar el navegador del agente. Los cambios se aplican a las pestañas nuevas, también en tareas ya en curso.",
  "settings.browser.agent.mode.label": "Inicios de sesión",
  "settings.browser.agent.mode.clean": "Sin sesión",
  "settings.browser.agent.mode.auto": "Solo sitios con sesión iniciada",
  "settings.browser.agent.mode.profile": "Todos los sitios",
  "settings.browser.agent.mode.cleanHint":
    "Cada sitio se abre sin sesión. El agente nunca usa tus inicios de sesión.",
  "settings.browser.agent.mode.autoHint":
    "Los sitios de la lista de abajo se abren con tus inicios de sesión, incluidos los sitios en los que el navegador ya tiene sesión. Los demás se abren sin sesión.",
  "settings.browser.agent.mode.profileHint":
    "Cada sitio se abre con tus inicios de sesión. El agente puede actuar como tú en cualquiera.",
  "settings.browser.agent.sites.title": "Sitios con sesión iniciada",
  "settings.browser.agent.sites.description":
    "Sitios que el agente abre con tus inicios de sesión en el modo «Solo sitios con sesión iniciada». Añade uno aquí o inicia sesión desde una pestaña del navegador. Solo https, o http para localhost.",
  "settings.browser.agent.sites.none": "No hay sitios en la lista.",
  "settings.browser.agent.sites.readOnly": "Cierra la sesión desde la app de escritorio de Psyche",
  "settings.browser.agent.sites.signOutSite": "Cerrar sesión en {site}",
  "settings.browser.agent.sites.source.stay": "Mantener sesión",
  "settings.browser.agent.sites.source.setting": "Añadido en Ajustes",
  "settings.browser.agent.mode.autoHintOff":
    "Solo los sitios de la lista de abajo se abren con tus inicios de sesión. Los demás se abren sin sesión.",
  "settings.browser.agent.sites.remove": "Quitar {site}",
  "settings.browser.agent.sites.removeShort": "Quitar",
  "settings.browser.agent.sites.label": "Dirección del sitio",
  "settings.browser.agent.sites.add": "Añadir sitio",
  "settings.browser.agent.ports.title": "Puertos de vista previa",
  "settings.browser.agent.ports.description":
    "Servidores de desarrollo locales que el agente puede abrir, solo en localhost.",
  "settings.browser.agent.ports.none": "No hay puertos en la lista.",
  "settings.browser.agent.ports.remove": "Quitar el puerto {port}",
  "settings.browser.agent.ports.label": "Número de puerto",
  "settings.browser.agent.ports.add": "Añadir puerto",
  "settings.browser.agent.fromEnv":
    "Lo define la variable de entorno {variable}. Quítala para cambiarlo aquí.",
  "settings.browser.agent.refuse.notUrl":
    "Eso no es una dirección de sitio. Usa una forma como https://ejemplo.com.",
  "settings.browser.agent.refuse.wildcard":
    "No se permiten comodines. Indica cada sitio con su dirección exacta.",
  "settings.browser.agent.refuse.credentials":
    "No se permiten direcciones con usuario o contraseña.",
  "settings.browser.agent.refuse.path": "Indica solo la dirección del sitio, sin ruta.",
  "settings.browser.agent.refuse.scheme":
    "Usa https. El http simple solo se permite para localhost.",
  "settings.browser.agent.refuse.port": "Un puerto debe ser un número entero de 1 a 65535.",
  "settings.browser.signedIn.viaHosts": "También con sesión iniciada mediante {hosts}",
  "settings.browser.signedIn.forget": "Cerrar sesión / olvidar",
  "settings.browser.signedIn.loadFailed":
    "Psyche no pudo listar los sitios con sesión iniciada ({reason}).",
  "settings.browser.signedIn.forgetFailed": "Psyche no pudo cerrar la sesión de {site} ({reason}).",
  "settings.browser.import.title": "Importar inicios de sesión de otro navegador",
  "settings.browser.import.description":
    "Trae tus inicios de sesión de Chrome, Brave, Edge, Arc o Firefox al navegador de Psyche, para que las tareas tengan la sesión iniciada donde tú la tienes. Tú eliges los sitios; no se importa nada hasta entonces.",
  "settings.browser.import.from": "Importar inicios de sesión de…",
  "settings.browser.import.chooseBrowser": "Elige un navegador",
  "settings.browser.import.profile": "Perfil",
  "settings.browser.import.read": "Leer inicios de sesión",
  "settings.browser.import.reading": "Leyendo…",
  "settings.browser.import.noProfiles":
    "No se encontró ningún perfil de {browser} con inicios de sesión en este ordenador.",
  "settings.browser.import.keychainHint":
    "macOS te pide tu contraseña para que Psyche desbloquee los inicios de sesión de {browser}. Se quedan en este Mac y nunca llegan al chat, los registros ni la auditoría.",
  "settings.browser.import.noneInstalled": "Ninguno de estos navegadores está en este ordenador.",
  "settings.browser.import.unsupportedFda":
    "{browser} no es compatible: leer sus inicios de sesión requiere acceso total al disco, y Psyche no lo pide.",
  "settings.browser.import.unsupportedPlatform":
    "{browser} aún no es compatible en este ordenador. La importación de inicios de sesión funciona en macOS.",
  "settings.browser.import.sourcesFailed": "Psyche no pudo listar tus navegadores ({reason}).",
  "settings.browser.import.readFailed":
    "Psyche no pudo leer los inicios de sesión de {browser} ({reason}).",
  "settings.browser.import.leftOut": "Omitidas: {expired} cookies caducadas y {skipped} ilegibles.",
  "settings.browser.import.noneFound": "Este perfil no tiene inicios de sesión para importar.",
  "settings.browser.import.search": "Buscar sitios",
  "settings.browser.import.selectAll": "Seleccionar todo salvo lo sensible",
  "settings.browser.import.clear": "Borrar",
  "settings.browser.import.noMatch": "Ningún sitio coincide con «{query}».",
  "settings.browser.import.cookies": "{count, plural, one {# cookie} other {# cookies}}",
  "settings.browser.import.sensitive.bank": "Banco",
  "settings.browser.import.sensitive.payment": "Pagos",
  "settings.browser.import.sensitive.passwords": "Gestor de contraseñas",
  "settings.browser.import.sensitive.email": "Correo",
  "settings.browser.import.sensitive.signin": "Proveedor de inicio de sesión",
  "settings.browser.import.hosts": "Hosts: {hosts}",
  "settings.browser.import.hostsMore": "Hosts: {hosts} y {count} más",
  "settings.browser.import.sensitiveWarning":
    "{kind}: una sesión aquí puede mover dinero, restablecer tus otras cuentas o abrir tus contraseñas. Márcalo solo si las tareas lo necesitan.",
  "settings.browser.import.noTrust":
    "Los sitios importados no ganan confianza extra: los pagos siguen necesitando tu confirmación y todo lo demás sigue tu modo de aprobación.",
  "settings.browser.import.importN":
    "{count, plural, =0 {Importar} one {Importar # sitio} other {Importar # sitios}}",
  "settings.browser.import.cancel": "Cancelar",
  "settings.browser.import.done":
    "{count, plural, =0 {No se importó ningún inicio de sesión.} one {Inicios de sesión importados para # sitio.} other {Inicios de sesión importados para # sitios.}}",
  "settings.browser.import.refused":
    "{count, plural, one {El navegador de Psyche rechazó # cookie.} other {El navegador de Psyche rechazó # cookies.}}",
  "settings.browser.import.importFailed":
    "Psyche no pudo importar los inicios de sesión ({reason}).",
  "settings.browser.import.importedTitle": "Inicios de sesión importados",
  "settings.browser.import.importedFrom":
    "De {browser} el {date}, {count, plural, one {# cookie} other {# cookies}}",
  "settings.browser.import.remove": "Quitar inicios de sesión importados",
  "settings.browser.import.removeHint":
    "Quita las cookies que escribió esta importación. No cierra sesión: para eso usa Olvidar en Sitios con sesión iniciada.",
  "settings.browser.import.removeFailed":
    "Psyche no pudo quitar los inicios de sesión importados de {site} ({reason}).",
  "settings.computerUse.appsHint": "Hasta dónde puede llegar Psyche en cada app.",
  "settings.connectors.catalog.appleShortcuts": "Atajos",
  "settings.connectors.catalog.obsidian": "Obsidian",
  "settings.connectors.trust.verified": "verificado",
  "settings.connectors.filter.label": "Mostrar",
  "settings.connectors.filter.all": "Todos",
  "settings.connectors.filter.apps": "Apps",
  "settings.connectors.filter.mcp": "Servidores MCP",
  "settings.connectors.configureFailed": "Psyche no pudo guardar los ajustes de {name}: {reason}",
  "settings.shortcuts.title": "Tus atajos",
  "settings.shortcuts.loading": "Leyendo tus atajos de este Mac…",
  "settings.shortcuts.none": "Aún no hay atajos en la app Atajos.",
  "settings.shortcuts.noHelper": "Abre Psyche en tu Mac para ver tus atajos: el ayudante los lee.",
  "settings.shortcuts.failed": "Psyche no pudo leer tus atajos.",
  "settings.shortcuts.hint":
    "Desactivado: nunca se ejecuta. Preguntar: una tarjeta cada vez. Permitir: se ejecuta sin preguntar, solo los atajos que únicamente leen.",
  "settings.shortcuts.rule.off": "Desactivado",
  "settings.shortcuts.rule.ask": "Preguntar",
  "settings.shortcuts.rule.allow": "Permitir",
  "settings.shortcuts.actions": "Acciones de Psyche",
  "settings.shortcuts.install": "Instalar",
  "settings.shortcuts.installNamed": "Instalar {name}",
  "settings.shortcuts.installed": "Instalado",
  "settings.trusted.title.reminders": "Tus listas de Recordatorios",
  "settings.trusted.title.notes": "Tus carpetas de Notas",
  "settings.trusted.title.calendar": "Tus calendarios",
  "settings.trusted.none.reminders": "Aún no hay listas de Recordatorios.",
  "settings.trusted.none.notes": "Aún no hay carpetas en Notas.",
  "settings.trusted.none.calendar": "Aún no hay calendarios.",
  "settings.trusted.loading": "Leyéndolos de este Mac…",
  "settings.trusted.noHelper": "Abre Psyche en tu Mac para verlos: el ayudante los lee.",
  "settings.trusted.failed": "Psyche no pudo leerlos de este Mac.",
  "settings.trusted.toggle": "Mía: tratar como de confianza",
  "settings.trusted.shared": "Compartida",
  "settings.trusted.hint":
    "Leer de ella no hará que el chat vuelva a preguntar. Actívalo solo en listas que nadie más pueda editar.",
  "settings.obsidian.vault": "Carpeta de la bóveda",
  "settings.obsidian.newVault": "Carpeta de la nueva bóveda",
  "settings.obsidian.noVault": "No se ha elegido ninguna bóveda",
  "settings.obsidian.vaultHint":
    "Psyche lee la bóveda a través de una carpeta compartida (Ajustes → Permisos → Acceso): compártela y luego úsala.",
  "settings.obsidian.share": "Compartir esta carpeta",
  "settings.obsidian.shared": "Compartida",
  "settings.obsidian.useVault": "Usar esta bóveda",
  "settings.obsidian.change": "Cambiar de bóveda…",
  "settings.obsidian.daily": "Carpeta de notas diarias",
  "settings.obsidian.dailyPlaceholder": "De los ajustes de notas diarias de Obsidian",
  "settings.connectors.can.title": "Qué puede hacer {persona}",
  "settings.connectors.can.label": "Qué puede hacer {persona} con {name}",
  "settings.connectors.can.alwaysAsks": "Pregunta siempre antes",
};
