import type { Catalogue } from "../../index.ts";

/** gallery-a strings (es); merged into `../es.ts`. */
export const galleryA: Partial<Catalogue> = {
  "gallery.preset.airtable.example":
    "Lista los registros de mi base Projects que están marcados como bloqueados.",
  "gallery.preset.airtable.field.key.label": "Token de acceso personal",
  "gallery.preset.airtable.field.key.help":
    "Crea un token que pueda leer las bases que quieras usar.",
  "gallery.preset.fetch.desc": "Descarga una página web y léela como texto sin formato.",
  "gallery.preset.fetch.example": "Lee esta página y dame los tres puntos clave.",
  "gallery.preset.fetch.field.sites.label": "Sitios web a los que puede acceder",
  "gallery.preset.fetch.field.sites.help":
    "Nombres de host separados por comas, como en.wikipedia.org. Si lo dejas vacío, solo podrá acceder al registro de paquetes.",
  "gallery.preset.braveSearch.desc": "Busca en la web, noticias e imágenes con Brave.",
  "gallery.preset.braveSearch.example":
    "Busca las noticias de esta semana sobre modelos de IA de código abierto.",
  "gallery.preset.braveSearch.field.key.label": "Clave de API",
  "gallery.preset.braveSearch.field.key.help": "El plan gratuito basta para probarlo.",
  "gallery.preset.playwright.desc":
    "Maneja un navegador aparte para leer páginas y rellenar formularios.",
  "gallery.preset.playwright.example": "Abre example.com y dime qué dice la página.",
  "gallery.preset.playwright.field.sites.label": "Sitios web a los que puede acceder",
  "gallery.preset.playwright.field.sites.help":
    "Nombres de host separados por comas que puede abrir. Déjalo vacío para mantenerlo sin conexión.",
  "gallery.preset.firecrawl.desc": "Extrae y rastrea sitios web y los convierte en texto limpio.",
  "gallery.preset.firecrawl.example":
    "Rastrea el sitio de documentación de example.com y resume las secciones principales.",
  "gallery.preset.firecrawl.field.key.label": "Clave de API",
  "gallery.preset.firecrawl.field.key.help": "Se usa para extraer y rastrear sitios por ti.",
  "gallery.preset.time.desc": "Consulta la hora actual y convierte entre zonas horarias.",
  "gallery.preset.time.example":
    "¿Qué hora es en Tokio cuando son las 9 de la mañana en San Francisco?",
  "gallery.preset.homeAssistant.desc":
    "Ve y controla los dispositivos que expones en Home Assistant.",
  "gallery.preset.homeAssistant.example": "¿Qué luces están encendidas ahora mismo?",
  "gallery.preset.homeAssistant.field.url.label": "Dirección del servidor",
  "gallery.preset.homeAssistant.field.url.help":
    "Activa la integración Model Context Protocol Server y copia su dirección desde Ajustes, Sistema, IA. Debe empezar por https://.",
  "gallery.preset.stripe.desc":
    "Consulta clientes, pagos y saldos. Solo lectura, según tu clave restringida.",
  "gallery.preset.stripe.example": "¿Cuánto cobré en los últimos 30 días?",
  "gallery.preset.stripe.field.key.label": "Clave restringida",
  "gallery.preset.stripe.field.key.help":
    "Crea una clave restringida (empieza por rk_) solo con permiso de lectura. Aquí se rechazan otras claves.",
  "settings.connectors.page.description":
    "Las apps y herramientas que {persona} puede usar. Cada una pregunta antes de actuar, salvo que digas lo contrario.",
  "settings.connectors.page.needsYou": "Te necesita",
  "settings.connectors.page.connected": "Conectado",
  "settings.connectors.page.onThisMac": "En este Mac",
  "settings.connectors.page.addMore": "Añadir más",
  "settings.connectors.page.addMore.hint":
    "Correo, calendario, notas y herramientas ya preparadas. Cada una pregunta antes de actuar.",
  "settings.connectors.page.addMore.browse": "Ver todos",
  "settings.connectors.page.status.paused": "En pausa",
  "settings.connectors.page.status.notWorking": "No funciona",
  "settings.connectors.page.status.signInExpired": "Sesión caducada",
  "settings.connectors.page.status.on": "Activado",
  "settings.connectors.page.status.off": "Desactivado",
  "settings.connectors.page.paused": "En pausa",
  "settings.connectors.page.open": "Abrir {name}",
  "settings.connectors.page.manage": "Gestionar",
  "settings.connectors.page.fix.seeWhy": "Ver por qué",
  "settings.connectors.page.row.never": "Aún sin usar",
  "settings.connectors.page.row.lastUsed": "Usado {when}",
  "settings.connectors.page.row.unverified": "Sin verificar",
  "settings.connectors.page.row.local": "Se ejecuta en este Mac",
  "settings.connectors.page.row.remote": "Se conecta por la web",
  "settings.connectors.page.row.files":
    "{count, plural, =0 {Ninguna carpeta compartida} one {1 carpeta compartida} other {# carpetas compartidas}}",
  "settings.connectors.page.row.terminal.on": "Puede ejecutar comandos",
  "settings.connectors.page.row.terminal.off": "Los comandos están desactivados",
  "settings.connectors.page.detail.label": "Detalles de {name}",
  "settings.connectors.page.detail.about": "Acerca de",
  "settings.connectors.page.detail.access": "Acceso",
  "settings.connectors.page.detail.source": "Origen",
  "settings.connectors.page.detail.technical": "Detalles técnicos",
  "settings.connectors.page.detail.manage": "Pausar o quitar",
  "settings.connectors.page.detail.type": "Tipo",
  "settings.connectors.page.detail.removeHint":
    "Desconectar lo pone en pausa y conserva sus ajustes. Quitar lo elimina.",
  "settings.connectors.page.source.builtIn": "Integrado en Psyche",
  "settings.connectors.page.source.verified": "Editor verificado",
  "settings.connectors.page.source.unverified": "Nadie lo ha revisado todavía",
  "settings.connectors.page.attention.signIn":
    "Tu sesión con {name} caducó. Inicia sesión de nuevo para que siga funcionando.",
  "settings.connectors.page.attention.error":
    "{name} no funciona ahora mismo. Prueba a iniciar sesión de nuevo; si sigue fallando, quítalo y vuelve a añadirlo.",
  "settings.connectors.page.attention.errorReason": "Lo que dijo: {reason}",
  "settings.connectors.page.attention.server":
    "{name} no se inició, así que sus herramientas no están disponibles.",
  "settings.connectors.page.attention.serverHint":
    "Revisa su comando o dirección y los secretos de abajo, y luego desactívalo y vuelve a activarlo.",
  "settings.connectors.page.server.local":
    "Una herramienta que se ejecuta en un entorno aislado en este Mac",
  "settings.connectors.page.server.remote": "Una herramienta a la que accedes por dirección web",
  "settings.connectors.page.server.network": "Accede a la red",
  "settings.connectors.page.server.noNetwork": "Sin red",
  "settings.connectors.page.advanced": "Avanzado",
  "settings.connectors.page.advanced.hint":
    "Tus propios servidores de herramientas y una búsqueda en el registro público.",
  "settings.connectors.page.advanced.custom": "Tu propio servidor de herramientas",
  "settings.connectors.page.advanced.customHint":
    "Ejecuta cualquier servidor MCP en el entorno aislado o conéctate a uno por dirección web.",
  "settings.connectors.page.advanced.customAction": "Añadir servidor",
  "settings.connectors.page.advanced.find": "Buscar servidores en línea",
  "settings.connectors.page.gallery.title": "Añadir un conector",
  "settings.connectors.page.gallery.intro":
    "Elige algo para probar. Cada uno pregunta antes de hacer nada, y puedes quitarlo cuando quieras.",
  "settings.connectors.page.gallery.noMatch": "No hay coincidencias. Prueba con otra palabra.",
  "settings.connectors.page.gallery.back": "Volver a la galería",
  "settings.connectors.page.gallery.community": "Comunidad",
  "onboarding.stepCount": "{n, number} de {total, number}",
  "onboarding.connectors.onThisMac": "En este Mac",
  "onboarding.connectors.onThisMacHint":
    "Cada app pide permiso a macOS al conectarse, una por una.",
  "onboarding.connectors.connectApps":
    "{n, plural, =0 {Conectar apps} one {Conectar # app} other {Conectar # apps}}",
  "onboarding.connectors.connecting": "Conectando {name}",
  "onboarding.connectors.accounts": "Cuentas",
  "onboarding.step.memory": "Memoria y hábitos diarios",
  "onboarding.about.lead":
    "Unos pocos datos para que Psyche te conozca desde el principio. Todo es opcional y vive en USER.md, que puedes editar cuando quieras.",
  "onboarding.about.name": "Tu nombre",
  "onboarding.about.nameHint": "¿Cómo debe llamarte Psyche?",
  "onboarding.about.timeZone": "Zona horaria",
  "onboarding.about.timeZoneHint": "Europe/Madrid",
  "onboarding.about.work": "Trabajo o estudios",
  "onboarding.about.workHint": "A qué te dedicas, en pocas palabras",
  "onboarding.about.city": "Ciudad de residencia",
  "onboarding.about.cityHint": "Dónde sueles estar",
  "onboarding.memory.lead":
    "¿Ya tienes un perfil en ChatGPT o Claude? Pega su exportación de memoria o la respuesta a «¿Qué sabes de mí?». Revisas todo antes de guardarlo.",
  "onboarding.memory.unavailable":
    "Importar no está disponible en esta ventana. Puedes hacerlo más tarde en Alma.",
  "onboarding.memory.format": "De dónde viene",
  "onboarding.memory.format.chatgpt": "ChatGPT",
  "onboarding.memory.format.claude": "Claude",
  "onboarding.memory.format.text": "Otro texto",
  "onboarding.memory.paste": "Texto de la memoria",
  "onboarding.memory.placeholder": "Pega aquí, o sube un archivo .txt, .md o .json",
  "onboarding.memory.upload": "Subir un archivo",
  "onboarding.memory.review": "Revisar",
  "onboarding.memory.found":
    "Se encontraron {n, number} elementos para revisar ({skipped, number} omitidos). Desmarca lo que no quieras conservar.",
  "onboarding.memory.items": "Elementos que importar",
  "onboarding.memory.flagged": "Parece una instrucción",
  "onboarding.memory.edit": "Volver al texto",
  "onboarding.memory.save": "Guardar {n, number} en la memoria",
  "onboarding.memory.saved": "Se guardaron {n, number} elementos en la memoria.",
  "onboarding.memory.failed": "Eso no funcionó ({reason}).",
  "onboarding.habits.lead":
    "Tarjetas breves en Inicio, por la mañana y por la tarde. Psyche solo lee; no se envía nada sin tu aprobación.",
  "onboarding.habits.brief": "Resumen diario",
  "onboarding.habits.briefHint": "Tu día, cada mañana de lunes a viernes.",
  "onboarding.habits.wrapup": "Cierre de la tarde",
  "onboarding.habits.wrapupHint": "Lo que se hizo y lo que pasa a mañana.",
  "onboarding.habits.followups": "Seguimiento de pendientes",
  "onboarding.habits.followupsHint": "Detecta las respuestas que sigues esperando.",
  "onboarding.rerun.title": "Configurar de nuevo",
  "onboarding.rerun.description":
    "Repasa de nuevo la configuración inicial. Los pasos ya hechos se omiten.",
  "onboarding.rerun.button": "Volver a ejecutar la configuración",
  "onboarding.step.you": "Tú y tu agente",
  "onboarding.step.stuff": "Tus cosas",
  "onboarding.step.safety": "Seguridad",
  "onboarding.you.lead": "Todo en esta página es opcional y puedes cambiarlo más tarde.",
  "onboarding.you.agent": "Tu agente",
  "onboarding.you.customize": "Personalizar el aspecto",
  "onboarding.you.more": "Más sobre ti",
  "onboarding.memory.habitsLead":
    "Elige qué hace {name} cada día y qué conserva en la memoria. Todo se puede cambiar en Ajustes.",
  "onboarding.memory.bring": "Traer la memoria de ChatGPT o Claude",
  "onboarding.habits.title": "Cada día",
  "onboarding.work.title": "Trabajo y pendientes",
  "onboarding.work.hint":
    "Mantiene un pendiente para todo lo que tenga fecha límite: facturas, alquiler, impuestos, renovaciones, plazos de trabajo, deberes. {persona} lee solo las listas y carpetas que elijas. Desactivado hasta que digas que sí.",
  "onboarding.work.remindHint":
    "Se envía con tu cierre de la tarde. Los títulos solo se muestran para lo que añadiste tú.",
  "onboarding.work.later":
    "Elige qué listas y carpetas de Recordatorios cuentan en Ajustes → Memoria → Trabajo.",
  "onboarding.people.title": "Personas",
  "onboarding.people.label": "Incluir personas en mi resumen",
  "onboarding.people.hint":
    "Datos sobre las personas que conoces y con quién mantener el contacto. Desactivado salvo que lo actives.",
  "onboarding.people.needsBrief":
    "El resumen de la mañana está desactivado, así que las personas no aparecerán todavía. Actívalo para verlas.",
  "onboarding.safety.lead":
    "Cómo te llegan las aprobaciones y qué se ejecuta solo. Aquí no se pide acceso a tus archivos, apps ni pantalla: {name} lo pide en el chat la primera vez que lo necesita.",
  "onboarding.safety.touchId": "Touch ID para las aprobaciones",
  "onboarding.safety.touchId.checking": "Examinando el ayudante del Mac…",
  "onboarding.safety.touchId.again": "Comprobar de nuevo",
  "onboarding.safety.touchId.set": "Configurar",
  "onboarding.safety.touchId.setHint": "Las aprobaciones que te necesitan piden tu huella.",
  "onboarding.safety.touchId.starting":
    "El ayudante del Mac aún se está iniciando. Vuelve a comprobar en un momento.",
  "onboarding.safety.touchId.noKey": "El ayudante del Mac no tiene clave de Touch ID ({reason}).",
  "onboarding.safety.touchId.register": "Registrar esta clave",
  "onboarding.safety.touchId.hint":
    "Registra una vez la clave del ayudante del Mac para que Touch ID pueda confirmar las aprobaciones.",
  "onboarding.safety.notifications": "Notificaciones",
  "onboarding.safety.asks":
    "Si dejas que {name} ejecute comandos en este Mac, los que solo leen, como ls o cat, se ejecutan sin tarjeta. Todo lo demás te pregunta antes.",
  "onboarding.safety.sandbox": "Configurar un entorno aislado para los comandos",
  "onboarding.safety.optional": "Opcional",
  "onboarding.done.on": "Activado",
  "onboarding.done.off": "Desactivado",
  "onboarding.done.daily": "Diario",
  "onboarding.done.work": "Seguimiento del trabajo",
  "onboarding.done.people": "Personas en tu resumen",
  "onboarding.done.touchId": "Touch ID",
  "onboarding.done.touchIdSet": "Clave registrada",
  "onboarding.done.touchIdNot": "Aún sin registrar",
  "onboarding.done.modelKept": "Sin cambios",
  "onboarding.done.try": "Prueba a continuación",
  "onboarding.done.try.search":
    "Haz una pregunta en Buscar (⌘K). La respuesta muestra de dónde en tu vida viene.",
  "onboarding.done.try.home":
    "Abre Inicio. «Para ponerte al día» muestra lo que puedes haber dejado pasar.",
  "onboarding.done.try.canDo":
    "Abre «¿Qué puedes hacer?» en el menú del engranaje para ver tareas ya preparadas.",
  "capabilities.title": "¿Qué puedes hacer?",
  "capabilities.lead":
    "Cosas para probar ahora mismo. Las tarjetas que necesitan una cuenta se activan cuando está conectada.",
  "capabilities.available": "Listo para probar",
  "capabilities.locked": "Conecta para desbloquear",
  "capabilities.connect": "Conectar cuentas",
  "capabilities.try": "Prueba: {prompt}",
  "capabilities.addAutomation": "Añadir: {name}",
  "capabilities.automationAdded": "Añadido: {name}",
  "capabilities.automationFailed": "No se pudo añadir esa automatización ({reason}).",
  "capabilities.open": "¿Qué puedes hacer?",
  "capabilities.openHint": "Mira lo que puede hacer Psyche",
  "capabilities.brief.title": "Planifica mi día",
  "capabilities.brief.desc": "Resumen de la mañana con tu calendario, correo y recordatorios.",
  "capabilities.brief.prompt1": "Dame un resumen de hoy.",
  "capabilities.brief.prompt2": "¿En qué debería centrarme esta semana?",
  "capabilities.brief.auto": "Resumen de la mañana a las 7:30 los días laborables",
  "capabilities.meetings.title": "Prepara mis reuniones",
  "capabilities.meetings.desc": "Quién estará, qué se dijo la última vez, qué preguntar.",
  "capabilities.meetings.prompt1": "Prepárame para mi próxima reunión.",
  "capabilities.meetings.prompt2": "¿Qué reuniones de hoy necesitan preparación?",
  "capabilities.inbox.title": "Clasifica mi bandeja de entrada",
  "capabilities.inbox.desc":
    "Ordena lo que necesita respuesta, lo que puede esperar y lo que se puede ignorar.",
  "capabilities.inbox.prompt1": "Clasifica mi bandeja de entrada.",
  "capabilities.inbox.prompt2": "Redacta respuestas a los tres correos más urgentes.",
  "capabilities.inbox.auto": "Clasificación de la bandeja a las 8:00 los días laborables",
  "capabilities.reminders.title": "Recordatorios y pendientes",
  "capabilities.reminders.desc": "Añade, mueve y revisa recordatorios con lenguaje natural.",
  "capabilities.reminders.prompt1": "Recuérdame llamar al dentista el viernes.",
};
