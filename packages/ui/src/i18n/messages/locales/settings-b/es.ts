import type { Catalogue } from "../../index.ts";

/** settings-b strings (es); merged into `../es.ts`. */
export const settingsB: Partial<Catalogue> = {
  "settings.connectors.can.asksByDefault": "Pregunta antes salvo que lo permitas",
  "settings.connectors.can.lifted": "Se ejecuta sin preguntar",
  "settings.connectors.can.liftWhat": "{action} en {name}",
  "settings.connectors.can.readOnly": "Desactivado mientras {name} está conectado en solo lectura",
  "settings.connectors.can.mail.read.title": "Leer correo",
  "settings.connectors.can.mail.read.lines":
    "Leer y buscar correo, incluido el no leído · Ver los contadores de no leídos por buzón · Usar el correo que tienes seleccionado",
  "settings.connectors.can.mail.draft.title": "Redactar correo",
  "settings.connectors.can.mail.draft.lines":
    "Redactar correos nuevos, respuestas y reenvíos (se guardan, no se envían)",
  "settings.connectors.can.mail.organize.title": "Organizar correo",
  "settings.connectors.can.mail.organize.lines":
    "Marcar como leído, destacar, archivar y mover · Guardar adjuntos",
  "settings.connectors.can.mail.send.title": "Enviar correo",
  "settings.connectors.can.mail.send.lines": "Enviar correo y borradores guardados",
  "settings.connectors.can.notes.read.title": "Leer notas",
  "settings.connectors.can.notes.read.lines": "Buscar, listar y leer notas y carpetas",
  "settings.connectors.can.notes.create.title": "Escribir notas",
  "settings.connectors.can.notes.create.lines": "Crear notas y añadirles contenido",
  "settings.connectors.can.reminders.read.title": "Leer recordatorios",
  "settings.connectors.can.reminders.read.lines": "Ver lo que vence, está vencido y está marcado",
  "settings.connectors.can.reminders.write.title": "Cambiar recordatorios",
  "settings.connectors.can.reminders.write.lines": "Añadir, completar y marcar recordatorios",
  "settings.connectors.can.calendar.read.title": "Leer tu calendario",
  "settings.connectors.can.calendar.read.lines":
    "Ver eventos, asistentes y enlaces de reuniones · Encontrar tiempo libre",
  "settings.connectors.can.calendar.write.title": "Cambiar tu calendario",
  "settings.connectors.can.calendar.write.lines": "Añadir, mover y cambiar eventos",
  "settings.connectors.grant.allowed":
    "Permitido en Ajustes del Sistema → Privacidad y seguridad → {grant}",
  "settings.connectors.grant.automation": "Automatización → {app}",
  "settings.connectors.grant.calendars": "Calendarios",
  "settings.connectors.grant.reminders": "Recordatorios",
  "settings.connectors.grant.contacts": "Contactos",
  "settings.connectors.grant.photos": "Fotos",
  "settings.connectors.app.mail": "Mail",
  "settings.connectors.app.notes": "Notas",
  "settings.connectors.app.music": "Música",
  "settings.connectors.app.safari": "Safari",
  "settings.connectors.app.chrome": "Google Chrome",
  "settings.connectors.app.things": "Things",
  "settings.connectors.app.shortcuts": "Atajos",
  "settings.connectors.try.title": "Pruébalo",
  "settings.connectors.try.mail.unread": "¿Qué hay sin leer de hoy?",
  "settings.connectors.try.mail.reminder":
    "Crea un recordatorio a partir del correo que tengo seleccionado",
  "settings.connectors.try.mail.reply": "Redacta una respuesta al último correo de Dana",
  "settings.connectors.try.notes.find": "Busca mi nota sobre la reunión fuera de la oficina",
  "settings.connectors.try.notes.append":
    "Añade las decisiones de hoy a mi nota de la reunión fuera de la oficina",
  "settings.connectors.try.reminders.due": "¿Qué vence hoy?",
  "settings.connectors.try.reminders.add": "Recuérdame llamar al dentista mañana a las 9",
  "settings.connectors.try.calendar.today": "¿Qué tengo hoy en el calendario?",
  "settings.connectors.try.calendar.focus":
    "Reserva dos horas para concentrarme mañana por la mañana",
  "settings.connectors.actionFailed": "Psyche no pudo cambiar {name} ({reason}). No cambió nada.",
  "settings.mcp.badge": "MCP",
  "settings.mcp.showDetails": "Mostrar detalles",
  "settings.mcp.hideDetails": "Ocultar detalles",
  "settings.sandbox.setUp": "Configurar el entorno aislado",
  "settings.mcp.sandboxHelp":
    "Los servidores de comandos necesitan un entorno aislado en este Mac.",
  "settings.sandbox.title": "Configurar el entorno aislado",
  "settings.sandbox.why":
    "Los comandos se ejecutan en tu Mac con tus archivos, pero no pueden leer tu bóveda, tus claves ni los datos privados de Psyche.",
  "settings.sandbox.whyHow":
    "Usa srt, el runtime de aislamiento de Anthropic, sobre el propio entorno aislado de macOS. No hace falta máquina virtual.",
  "settings.sandbox.privacy":
    "Psyche no instala nada por su cuenta. Ejecutas cada paso de abajo tú mismo, o abres la descarga tú.",
  "settings.sandbox.checking": "Examinando este Mac…",
  "settings.sandbox.checkAgain": "Comprobar de nuevo",
  "settings.sandbox.done": "Hecho",
  "settings.sandbox.copy": "Copiar",
  "settings.sandbox.copied": "Copiado",
  "settings.sandbox.ready": "Listo",
  "settings.sandbox.srt.ready":
    "srt está configurado en {path}. Se pueden añadir servidores de comandos.",
  "settings.sandbox.srt.missing.title": "Instalar srt",
  "settings.sandbox.srt.missing.body":
    "srt viene de npm. Si el comando pide permiso para escribir, ejecútalo con los permisos de tu propia cuenta; Psyche nunca lo ejecuta por ti.",
  "settings.sandbox.srt.install": "Instálalo con npm",
  "settings.sandbox.srt.link": "Leer sobre srt en GitHub",
  "settings.sandbox.srt.thenCheck": "Luego comprueba de nuevo",
  "settings.sandbox.srt.thenCheckBody":
    "Psyche encuentra srt en tu PATH, en las carpetas de Homebrew y npm, sin reiniciar.",
  "settings.sandbox.srt.broken":
    "No se puede usar el srt de {path}: {problem, select, not_absolute {la ruta debe empezar por /} not_executable {allí no hay ningún programa que se pueda ejecutar} other {no se encontró}}.",
  "settings.sandbox.srt.fromEnv":
    "PSYCHE_SRT_PATH define esta ubicación, así que no se puede cambiar aquí.",
  "settings.sandbox.srt.installButton": "Instalar con Psyche",
  "settings.sandbox.srt.reinstallButton": "Reinstalar",
  "settings.sandbox.srt.updateButton": "Actualizar srt",
  "settings.sandbox.srt.installOr": "O deja que Psyche lo instale por ti",
  "settings.sandbox.srt.installConfirm.title": "¿Instalar srt {version}?",
  "settings.sandbox.srt.installConfirm.body":
    "Psyche descargará {package} {version} y sus dependencias del registro de npm (registry.npmjs.org), comprobará cada archivo con una suma de verificación incluida en esta versión de Psyche y los descomprimirá con su propio Node. No se instala nada en todo el sistema, no se ejecutan scripts de instalación y no hace falta contraseña.",
  "settings.sandbox.srt.installConfirm.where": "Se colocará en {dir}",
  "settings.sandbox.srt.installConfirm.go": "Instalar",
  "settings.sandbox.srt.installConfirm.cancel": "Cancelar",
  "settings.sandbox.srt.installing": "Instalando srt…",
  "settings.sandbox.srt.installed": "Instalado por Psyche: srt {version}.",
  "settings.sandbox.srt.installFailed": "No se pudo instalar srt: {reason}",
  "settings.sandbox.srt.updateAvailable":
    "Esta versión de Psyche incluye un srt más reciente ({version}); está instalado {installed}.",
  "settings.sandbox.srt.choose": "srt está en otro sitio",
  "settings.sandbox.srt.path": "Ruta completa a srt",
  "settings.sandbox.srt.use": "Usar este srt",
  "settings.sandbox.srt.useHint":
    "Al guardarlo se te pide confirmar en este dispositivo, porque decide qué ejecuta tus comandos.",
  "settings.sandbox.containers.title": "Aislamiento más fuerte (opcional)",
  "settings.sandbox.containers.body":
    "Un runtime de contenedores ejecuta el código en su propia máquina Linux, sin acceso a los archivos de tu Mac: para el código que ejecuta el agente y algunas conversiones de archivos. Los servidores de comandos siguen usando srt salvo que el Gateway esté configurado para usar contenedores.",
  "settings.sandbox.containers.ready": "{runtime} se está ejecutando.",
  "settings.sandbox.runtime.appleContainer": "Apple container",
  "settings.sandbox.runtime.docker": "Docker",
  "settings.sandbox.runtime.podman": "Podman",
  "settings.sandbox.missing.title": "Instalar {runtime}",
  "settings.sandbox.missing.appleContainer":
    "El runtime de contenedores de Apple da a cada entorno aislado su propia VM ligera. Necesita macOS 26 en Apple silicon y un instalador que apruebas con la contraseña de tu Mac.",
  "settings.sandbox.missing.docker":
    "Docker mediante Colima es gratuito y ligero; Docker Desktop es la opción de apuntar y hacer clic.",
  "settings.sandbox.step.download": "Descarga y abre el instalador",
  "settings.sandbox.step.downloadLink": "Abrir las versiones de Apple container",
  "settings.sandbox.step.start": "Inícialo",
  "settings.sandbox.step.install": "Instálalo con Homebrew",
  "settings.sandbox.step.orDesktop": "O descarga Docker Desktop y ábrelo una vez",
  "settings.sandbox.step.desktopLink": "Abrir la descarga de Docker Desktop",
  "settings.sandbox.stopped.title": "{runtime} está instalado pero no se está ejecutando",
  "settings.sandbox.stopped.appleContainer": "Inicia su servicio del sistema y comprueba de nuevo.",
  "settings.sandbox.stopped.docker":
    "Inicia el daemon de Docker (abre Docker Desktop o ejecuta el comando de abajo) y comprueba de nuevo.",
  "settings.sandbox.stopped.podman": "Inicia la máquina de Podman y comprueba de nuevo.",
  "settings.sandbox.restart.title": "{runtime} se está ejecutando. Reinicia el Gateway para usarlo",
  "settings.sandbox.restart.body":
    "El Gateway buscó un runtime de contenedores al iniciarse y no encontró ninguno. Reinícialo y entonces detectará {runtime}.",
  "settings.sandbox.restart.step": "Reiniciar el Gateway",
  "settings.sandbox.without":
    "Sin srt, Psyche aún puede usar servidores por URL y tus conectores, pero no puede ejecutar servidores de comandos MCP locales.",
  "settings.mcp.off": "Desactivado",
  "settings.mcp.turnedOn": "{name} está activado.",
  "settings.mcp.turnedOff": "{name} está desactivado.",
  "settings.mcp.tools.title": "Herramientas",
  "settings.mcp.tools.hint":
    "{off, plural, =0 {Psyche puede usar todas las herramientas.} one {# herramienta no está disponible para Psyche.} other {# herramientas no están disponibles para Psyche.}} Desactivar una no reinicia el servidor.",
  "settings.mcp.tools.loadFailed": "No se pudieron cargar las herramientas: {reason}",
  "settings.mcp.tools.off": "Este servidor está desactivado. Actívalo para ver sus herramientas.",
  "settings.mcp.tools.notConnected":
    "Este servidor no está conectado, así que no lista herramientas.",
  "settings.mcp.tools.none": "Este servidor no tiene herramientas.",
  "settings.mcp.money.title": "Pagos",
  "settings.mcp.money.description":
    "Una herramienta que mueve dinero pide Touch ID o tu contraseña cada vez. Indica cuáles de las herramientas de este servidor lo hacen.",
  "settings.mcp.money.auto": "Decidir por el nombre de cada herramienta",
  "settings.mcp.money.autoHint":
    "Psyche lo deduce del nombre y la descripción de la herramienta, que un servidor puede redactar para evitarlo.",
  "settings.mcp.money.always": "Todas las herramientas mueven dinero",
  "settings.mcp.money.alwaysHint": "Cada llamada a este servidor te pide aprobar un pago.",
  "settings.mcp.money.never": "Ninguna herramienta mueve dinero",
  "settings.mcp.money.neverHint":
    "Ninguna llamada pide aprobar un pago, se llame como se llame la herramienta. Solo para un servidor que no puede gastar dinero.",
  "settings.mcp.secrets.title": "Secretos",
  "settings.mcp.secrets.intro":
    "Claves con las que arranca este servidor. Se quedan en tu bóveda; Psyche solo muestra si cada una está definida.",
  "settings.mcp.secrets.loadFailed": "No se pudieron cargar los secretos: {reason}",
  "settings.mcp.secrets.set": "Definido",
  "settings.mcp.secrets.unset": "Sin definir",
  "settings.mcp.secrets.replace": "Reemplazar",
  "settings.mcp.secrets.setIt": "Definir un valor",
  "settings.mcp.secrets.replaceFor": "Reemplazar {name}",
  "settings.mcp.secrets.plain":
    "Se guarda en los ajustes del servidor, no en la bóveda. Al reemplazarlo pasa a la bóveda.",
  "settings.mcp.secrets.newValue": "Nuevo valor para {name}",
  "settings.mcp.secrets.hint": "Se guarda en tu bóveda y el servidor se reinicia con él.",
  "settings.mcp.secrets.replaced":
    "Se reemplazó {name}. El servidor se reinicia con el nuevo valor.",
  "settings.mcp.danger.title": "Zona de peligro",
  "settings.mcp.danger.disable": "Desactivar este servidor",
  "settings.mcp.danger.disableHint":
    "Conserva sus ajustes pero lo detiene. Sus herramientas desaparecen y los permisos que les diste terminan.",
  "settings.mcp.danger.disableAction": "Desactivar",
  "settings.mcp.danger.enable": "Activar este servidor",
  "settings.mcp.danger.enableHint": "Lo vuelve a iniciar. Sus secretos piden tu aprobación.",
  "settings.mcp.danger.enableAction": "Activar",
  "settings.mcp.danger.remove": "Quitar este servidor",
  "settings.mcp.danger.removeHint": "Elimina sus ajustes. Los secretos de tu bóveda se quedan.",
  "settings.mcp.json.toggle": "Pegar JSON",
  "settings.mcp.json.label": "JSON del servidor",
  "settings.mcp.json.hint":
    "El formato habitual de mcpServers. Las claves y tokens van a tu bóveda, no a los ajustes.",
  "settings.mcp.json.fill": "Rellenar el formulario",
  "settings.mcp.json.choose": "¿Qué servidor?",
  "settings.mcp.json.empty": "Pega primero el JSON de un servidor.",
  "settings.mcp.json.invalid": "Eso no es un JSON válido.",
  "settings.mcp.json.shape": "Se esperaba un objeto JSON con una entrada mcpServers.",
  "settings.mcp.json.noServers": "No hay ningún servidor con comando o URL en ese JSON.",
  "settings.mcp.json.secrets":
    "{n, plural, one {# secreto} other {# secretos}} del JSON irán a tu bóveda: {names}.",
  "settings.mcp.json.ignored": "No se trasladó: {names}.",
  "settings.searchSources.title": "Fuentes de búsqueda",
  "settings.searchSources.description":
    "Lo que Psyche lee para tu índice de búsqueda. Todo está desactivado hasta que lo actives; el índice se queda en este Mac. Activar una fuente también deja que la memoria aprenda de ella, salvo que lo excluyas en Memoria → Fuentes (Memoria y Contactos son la excepción: de ninguna se aprende).",
  "settings.searchSources.hint.mail":
    "Asunto, remitente, destinatarios, fecha y texto de tu correo en Apple Mail. Las respuestas citadas se omiten.",
  "settings.searchSources.hint.messages":
    "Tus conversaciones de iMessage, por chat y día. Los mensajes de otras personas nunca se tratan como instrucciones.",
  "settings.searchSources.hint.notes": "El título y el texto de tus notas de Apple Notas.",
  "settings.searchSources.hint.calendar":
    "Eventos de los últimos tres años y los próximos doce meses: título, hora, lugar, asistentes y notas.",
  "settings.searchSources.hint.reminders":
    "Recordatorios y sus listas, fechas de vencimiento y notas.",
  "settings.searchSources.hint.contacts":
    "Tus Contactos de Apple: nombre, apodo, empresa, cargo, correos, teléfonos, ciudad y país de cada dirección, y cumpleaños. Nunca se leen las direcciones postales, las notas ni los grupos. El agente no puede buscar en ellos hasta que lo permitas, y ese interruptor solo cubre este índice: lo que Memoria ha aprendido de las personas y sus páginas con correos o números siguen el acceso del agente propio de Memoria.",
  "settings.searchSources.hint.files":
    "Archivos de texto, código, PDF, Word y Excel en las carpetas que has compartido. Las imágenes se indexan por nombre.",
  "settings.searchSources.hint.browser":
    "Páginas que el navegador de Psyche lee por ti, durante 90 días. Nunca se guardan páginas privadas, de inicio de sesión ni de pago.",
  "settings.searchSources.hint.transcripts":
    "Notas de voz y reuniones, separadas por hablante. Las palabras de otras personas nunca se tratan como instrucciones.",
  "settings.searchSources.hint.memory":
    "Lo que Psyche recuerda: tus personas, proyectos, trabajo pendiente y eventos, y los datos que Psyche ha aceptado. Se deja fuera todo lo sensible, lo que aún espera revisión, lo aprendido de una fuente en la que el agente no puede buscar y lo que se mantiene privado. La memoria no aprende de este índice, y necesita tener la memoria activada.",
  "settings.searchSources.runOnBatteryHint":
    "Permite que la indexación, Reconstruir y la lectura de texto en imágenes continúen mientras tu Mac funciona con batería, a un ritmo más suave. Gasta más batería. El modo de bajo consumo sigue pausando la indexación.",
  "settings.searchSources.cannotEnable": "Todavía no se puede activar: {why}",
  "settings.searchSources.cannotAgent": "El agente todavía no puede buscar aquí: {why}",
  "settings.searchSources.state.off": "Desactivado: no se lee",
  "settings.searchSources.state.unavailable": "Activado, pero no disponible: {why}",
  "settings.searchSources.state.error": "Problema: {why}",
  "settings.searchSources.state.indexing":
    "Indexando: {n, plural, one {# elemento} other {# elementos}} hasta ahora",
  "settings.searchSources.state.idle": "Al día: {n, plural, one {# elemento} other {# elementos}}",
  "settings.searchSources.neverIndexed": "Aún sin indexar",
  "settings.searchSources.lastIndexed": "Última indexación {when}",
  "settings.searchSources.rebuild": "Reconstruir",
  "settings.searchSources.rebuildLabel": "Reconstruir {source}",
  "settings.searchSources.rebuilding": "Reconstruyendo…",
  "settings.searchSources.rebuild.turnOnFirst": "Activa antes {source}",
  "settings.searchSources.rebuild.starting": "Reconstruyendo {source}…",
  "settings.searchSources.rebuild.progress":
    "Reconstruyendo {source}: {n, plural, one {# elemento leído} other {# elementos leídos}} hasta ahora. Continúa en segundo plano.",
  "settings.searchSources.rebuild.done":
    "{source} reconstruido: {n, plural, one {# elemento} other {# elementos}}.",
  "settings.searchSources.rebuild.failed": "No se pudo reconstruir {source}: {why}",
  "settings.searchSources.agent": "Dejar que el agente de Psyche busque aquí",
  "settings.searchSources.agentLabel": "Búsqueda del agente en {source}",
  "settings.searchSources.ocr": "Leer el texto de las imágenes (OCR)",
  "settings.searchSources.ocrHint":
    "Lee capturas de pantalla y PDF escaneados con Apple Vision, una página a la vez, con corriente (o con batería si «Indexar con batería» está activado). Nada sale de tu Mac.",
  "settings.searchSources.ocrLabel": "Leer el texto de las imágenes de {source}",
  "settings.searchSources.processing": "Procesamiento",
  "settings.searchSources.processingLabel": "Procesamiento de {source}",
  "settings.searchSources.processing.cloud": "Modelo en la nube (actual)",
  "settings.searchSources.processing.local": "Modelo local",
  "settings.searchSources.processing.none": "Ninguno: sin resúmenes",
  "settings.searchSources.excludeContacts": "No indexar nunca estos contactos",
  "settings.searchSources.excludeContactsHint":
    "Direcciones de correo, números de teléfono o nombres, separados por comas",
};
