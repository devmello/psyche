import type { Catalogue } from "../../index.ts";

/** settings-e strings (es); merged into `../es.ts`. */
export const settingsE: Partial<Catalogue> = {
  "settings.people.removeCounts":
    "Psyche elimina {entities, plural, one {# persona o proyecto} other {# personas y proyectos}}, {facts, plural, one {# dato} other {# datos}}, {interactions, plural, one {# interacción} other {# interacciones}}, {loops, plural, one {# asunto abierto} other {# asuntos abiertos}} y {identifiers, plural, one {# dirección} other {# direcciones}}.",
  "settings.specialists.title": "Especialistas",
  "settings.specialists.description":
    "Tareas en segundo plano con un rol con nombre, cada una dentro de su presupuesto, que entregan un resultado en tu bandeja de entrada.",
  "settings.specialists.all": "Todos los especialistas",
  "settings.specialists.concurrent": "Especialistas a la vez",
  "settings.specialists.concurrentHint": "Se ejecutan más en paralelo; el resto espera en cola.",
  "settings.specialists.monthlyCap": "Gasto mensual",
  "settings.specialists.monthlyCapHint":
    "Al alcanzarlo, los trabajos nuevos esperan a que haya presupuesto. Vacío usa la mitad de tu presupuesto mensual{budget, select, none {} other { ({budget})}}.",
  "settings.specialists.monthlyCapNone": "Sin límite",
  "settings.specialists.showInFeed": "Mostrar los resultados en el Feed",
  "settings.specialists.showInFeedHint":
    "Tu bandeja de entrada recibe todos los resultados de todos modos.",
  "settings.specialists.roles": "Roles",
  "settings.specialists.rolesHint":
    "Un rol viene de una habilidad. Uno que instalaste sigue desactivado hasta que lo actives.",
  "settings.specialists.turnOn": "{role} activado",
  "settings.specialists.summary": "{model} · {budget} · {mode}",
  "settings.specialists.budgetLine": "{tokens} tokens · {cost} · {minutes} min",
  "settings.specialists.edit": "Editar",
  "settings.specialists.done": "Listo",
  "settings.specialists.editLabel": "Editar {role}",
  "settings.specialists.model": "Modelo",
  "settings.specialists.modelDefault": "Por defecto: {class}",
  "settings.specialists.class.utility": "modelo auxiliar",
  "settings.specialists.class.primary": "modelo principal",
  "settings.specialists.class.harness": "entorno de programación",
  "settings.specialists.class.vision": "modelo principal con visión",
  "settings.specialists.budget": "Presupuesto por trabajo",
  "settings.specialists.budgetTokens": "Tokens",
  "settings.specialists.budgetCost": "Coste (USD)",
  "settings.specialists.budgetMinutes": "Minutos",
  "settings.specialists.budgetCaps":
    "Hasta {tokens} tokens · {cost} · {minutes} min. Un trabajo puede pedir más, nunca por encima de esto.",
  "settings.specialists.maxMode": "Lo máximo que puede hacer sin preguntar",
  "settings.specialists.mode.plan": "Plan",
  "settings.specialists.mode.manual": "Manual",
  "settings.specialists.mode.balanced": "Equilibrado",
  "settings.specialists.mode.auto": "Auto",
  "settings.specialists.installed": "De {skill}",
  "settings.specialists.empty": "Ninguna habilidad define aún un especialista.",
  "settings.language.description":
    "El idioma del texto y cómo se escriben las fechas y los números.",
  "settings.language.languageHint": "Lo que aún no está traducido se muestra en inglés.",
  "settings.persona.identityHint": "Nombre y lema.",
  "settings.persona.avatarHint": "Elige una criatura o describe un cambio.",
  "settings.persona.whileWorkingHint": "Lo que ves mientras se ejecuta una tarea.",
  "settings.daily.group.briefHint": "Un resumen breve para empezar el día.",
  "settings.daily.group.wrapupHint": "Un repaso de lo que se hizo.",
  "settings.daily.group.deliveryHint": "Cómo te llegan.",
  "settings.daily.group.automationsHint": "Tareas recurrentes que Psyche ejecuta por ti.",
  "settings.voice.dictationHint": "Habla en lugar de escribir.",
  "settings.usage.byThreadHint": "A dónde fueron los tokens y el coste.",
  "settings.skills.installedHint": "Habilidades que Psyche puede usar ahora.",
  "settings.about.versionsHint": "Lo que se está ejecutando en este Mac.",
  "settings.specialists.allHint": "Activa o desactiva roles y define sus presupuestos.",
  "settings.vm.sandboxMacHint": "Dónde se ejecutan los comandos.",
  "settings.computerUse.macPermissionsHint": "Lo que macOS ha permitido.",
  "settings.voice.advancedHint": "Motor de voz",
  "settings.files.advancedHint": "Deja que Psyche ejecute comandos en las carpetas compartidas",
  "settings.browser.advancedHint": "Firmar las solicitudes web de Psyche",
  "settings.skills.advancedHint": "Habilidades que vienen con Psyche",
  "blocks.details.skillAction": "Acción",
  "blocks.details.skillActionValue":
    "{action, select, update {Cambiar una habilidad creada por {persona}} delete {Eliminar una habilidad creada por {persona}} other {Añadir una habilidad nueva escrita por {persona}}}",
  "blocks.details.name": "Nombre",
  "blocks.details.skillText": "Instrucciones",
  "blocks.details.skillTextView": "Ver el texto completo",
  "settings.skills.madeByAgent": "Creada por {persona}",
  "settings.skills.history": "{n, plural, one {# versión anterior} other {# versiones anteriores}}",
  "settings.skills.historyItem":
    "v{version} · aprobada {approved} · {retiredBy, select, delete {eliminada} other {reemplazada}} {retired}",
  "settings.skills.historyHint": "Se conservan como referencia. Estas versiones nunca se cargan.",
  "settings.mcp.madeBy": "Creado por Psyche",
  "settings.mcp.madeByHint":
    "Psyche escribió el código de este conector. Solo se ejecuta en el entorno aislado, solo el código que aprobaste, y sus herramientas preguntan antes de cambiar nada.",
  "settings.mcp.code.title": "Código",
  "settings.mcp.code.view": "Ver código",
  "settings.mcp.code.hide": "Ocultar código",
  "settings.mcp.code.loading": "Cargando el código…",
  "settings.mcp.code.version": "Versión {version} · {runtime} · inicia {entry}",
  "settings.mcp.code.modified":
    "El código del disco no es la versión que aprobaste, así que este conector está detenido hasta que apruebes el cambio.",
  "settings.mcp.code.file": "{path} · {bytes} B",
  "settings.mcp.code.edit": "Editar {file}",
  "settings.mcp.code.editing": "Editando {file}",
  "settings.mcp.code.save": "Guardar para revisión",
  "settings.mcp.code.saving": "Guardando…",
  "settings.mcp.code.cancel": "Cancelar edición",
  "settings.mcp.code.provided": "Lo aporta Psyche, igual para todos los conectores",
  "settings.mcp.code.approved": "{name} actualizado.",
  "settings.mcp.code.denied":
    "No se aprobó el cambio en {name}. Sigue detenido hasta que apruebes uno.",
  "blocks.details.connector.runtime": "Se ejecuta",
  "blocks.details.connector.runtimeValue": "{persona} escribió este conector (versión {version})",
  "blocks.details.connector.command": "Comando",
  "blocks.details.connector.network": "Pide acceso a",
  "blocks.details.connector.networkNone": "Sin red",
  "blocks.details.connector.tools": "Herramientas",
  "blocks.details.connector.files": "Código ({n} archivos)",
  "blocks.details.connector.file": "{path} ({bytes} bytes)",
  "blocks.details.connector.provided": "aportado por Psyche",
  "blocks.details.connector.diff": "Cambios desde la versión {version}",
  "blocks.details.connector.suggested": "{persona} sugiere este conector del registro",
  "settings.deviceAccess.files.title": "Archivos en este Mac",
  "settings.deviceAccess.files.hint":
    "Las carpetas que {persona} puede leer, y editar donde lo permitas. Las compartes en Permisos → Acceso.",
  "settings.deviceAccess.files.more": "{count, plural, one {y 1 más} other {y # más}}",
  "settings.deviceAccess.open": "Abrir Acceso",
  "settings.deviceAccess.terminal.title": "Terminal",
  "settings.deviceAccess.terminal.hint":
    "{persona} puede ejecutar comandos de terminal en este Mac cuando «Ejecutar comandos en este Mac» está activado en Permisos → Acceso.",
  "settings.deviceAccess.terminal.where":
    "Los comandos se ejecutan en tu Mac, en las carpetas que compartiste, y solo pueden escribir en una carpeta compartida con lectura y escritura.",
  "settings.deviceAccess.terminal.asks":
    "Los comandos que podrían cambiar archivos preguntan antes, salvo que elijas permitir siempre ese comando exacto. Los comandos básicos de solo lectura como ls, cat o wc se ejecutan sin preguntar, salvo que lo desactives.",
  "settings.deviceAccess.terminal.sandbox":
    "Los comandos se ejecutan en el entorno aislado. Una ejecución aprobada solo va sin él si escribes UNSANDBOXED en su tarjeta.",
  "settings.deviceAccess.terminal.on": "La ejecución de comandos está activada",
  "settings.deviceAccess.terminal.off": "La ejecución de comandos está desactivada",
  "settings.deviceAccess.terminal.folders":
    "{count, plural, =0 {Aún no hay carpetas compartidas: los comandos no tienen dónde ejecutarse.} one {1 carpeta compartida.} other {# carpetas compartidas.}}",
  "settings.mcp.needs.title": "Lo que esto necesita en tu Mac",
  "settings.mcp.needs.srt": "Entorno aislado (srt)",
  "settings.mcp.needs.srt.fix": "Mantiene el servidor alejado de los datos privados de Psyche.",
  "settings.mcp.needs.node": "Herramientas de Node.js (npm)",
  "settings.mcp.needs.node.fix":
    "Se ejecuta con el Node propio de Psyche; necesita npm en este Mac. Instala Node.js desde nodejs.org o ejecuta brew install node.",
  "settings.mcp.needs.uv": "uv (uvx)",
  "settings.mcp.needs.uv.fix":
    "Un servidor de Python. Instala uv con brew install uv o desde docs.astral.sh/uv.",
  "settings.mcp.needs.network": "Red",
  "settings.mcp.needs.network.fix": "Accede a la propia dirección del servidor.",
  "settings.mcp.needs.networkHosts": "Solo accede a {hosts} para descargar y ejecutar el servidor.",
  "settings.mcp.needs.missing": "Falta",
  "settings.mcp.needs.ready": "Listo",
  "settings.mcp.needs.checked": "Se comprueba al pulsar «Comprobar servidor»",
  "settings.mcp.fail.no_srt":
    "El entorno aislado no está instalado. Configúralo abajo y vuelve a comprobar el servidor.",
  "settings.mcp.fail.node_missing":
    "Instala Node.js (nodejs.org, o brew install node) para que npm esté en este Mac y vuelve a comprobar.",
  "settings.mcp.fail.uv_missing":
    "Instala uv (brew install uv, o docs.astral.sh/uv) y vuelve a comprobar el servidor.",
  "settings.mcp.fail.command_not_found":
    "El comando del servidor no está instalado aquí. Comprueba el comando o instala la herramienta que nombra.",
  "settings.mcp.fail.network_blocked":
    "El servidor no pudo descargar ni alcanzar lo que necesita. Comprueba tu conexión y que sus hosts estén permitidos.",
  "settings.mcp.fail.timeout":
    "Tardó demasiado. La primera ejecución descarga el paquete; comprueba tu conexión e inténtalo de nuevo.",
  "settings.mcp.fail.exited":
    "El servidor se detuvo justo después de iniciarse. Su última salida está abajo.",
  "settings.mcp.fail.failed": "Revisa la salida del servidor de abajo y vuelve a intentarlo.",
  "settings.mcp.fail.exitCode": "Código de salida {code}.",
  "settings.mcp.fail.output": "Salida del servidor",
  "gallery.intro":
    "Elige algo para probar. Cada conector pregunta antes de hacer nada, y puedes quitarlo cuando quieras.",
  "gallery.search": "Buscar conectores",
  "gallery.noMatch":
    "No hay coincidencias. Prueba con otra palabra o añade tu propio servidor MCP.",
  "gallery.back": "Todos los conectores",
  "gallery.getKey": "Dónde conseguirla.",
  "gallery.keyStaysInVault": "Se guarda en tu bóveda, nunca en los ajustes del servidor.",
  "gallery.tryAsking": "Cuando esté añadido, prueba a preguntar:",
  "gallery.custom.desc":
    "Cualquier servidor MCP: un comando que se ejecuta en el entorno aislado, o una dirección web.",
  "gallery.badge.builtIn": "Integrado",
  "gallery.badge.official": "Oficial",
  "gallery.badge.community": "Comunidad",
  "gallery.category.popular": "Populares",
  "gallery.category.files": "Archivos y conocimiento",
  "gallery.category.dev": "Desarrollo",
  "gallery.category.productivity": "Productividad",
  "gallery.category.comms": "Mensajes y correo",
  "gallery.category.web": "Web",
  "gallery.category.everyday": "Día a día",
  "gallery.category.finance": "Finanzas",
  "gallery.category.custom": "Los tuyos",
  "gallery.builtin.google": "Gmail, Google Calendar y Drive.",
  "gallery.builtin.microsoft": "Correo y calendario de Outlook.",
  "gallery.builtin.imap": "Cualquier cuenta de correo compatible con IMAP.",
  "gallery.builtin.appleNotes": "Lee y añade a tus notas en Apple Notas.",
  "gallery.builtin.appleReminders": "Ver y crear recordatorios.",
  "gallery.builtin.appleCalendar": "Ver tu calendario y añadir eventos.",
  "gallery.builtin.appleMail": "Leer y redactar correo en Apple Mail.",
  "gallery.builtin.appleShortcuts": "Ejecutar los atajos que elijas.",
  "gallery.builtin.obsidian": "Buscar y leer tu bóveda de Obsidian.",
  "gallery.builtin.slack": "Chatea con Psyche desde Slack. Se configura en Canales.",
  "gallery.preset.github.desc": "Explora repositorios, incidencias y pull requests.",
  "gallery.preset.github.example": "¿Qué pull requests esperan mi revisión?",
  "gallery.preset.github.field.token.label": "Token de acceso personal",
  "gallery.preset.github.field.token.help":
    "Un token de permisos detallados limitado a los repositorios que quieres que Psyche vea.",
  "gallery.preset.gitlab.desc":
    "Proyectos, merge requests e incidencias en GitLab.com. Inicias sesión al conectar.",
  "gallery.preset.gitlab.example": "Resume las merge requests abiertas de mi proyecto principal.",
  "gallery.preset.git.desc":
    "Lee el historial, las ramas y las diferencias de un repositorio local.",
  "gallery.preset.git.example": "¿Qué cambió en este repositorio durante la última semana?",
  "gallery.preset.git.field.repo.label": "Carpeta del repositorio",
  "gallery.preset.git.field.repo.help":
    "La carpeta de un repositorio Git en este Mac. Psyche puede leer su historial y sus diferencias.",
  "gallery.preset.sentry.desc":
    "Investiga errores e incidencias en tus proyectos de Sentry. Inicias sesión al conectar.",
  "gallery.preset.sentry.example":
    "¿Cuáles son los errores sin resolver más frecuentes esta semana?",
  "gallery.preset.linear.desc":
    "Encuentra y actualiza incidencias y proyectos. Inicias sesión al conectar.",
  "gallery.preset.linear.example": "¿Qué incidencias tengo asignadas y vencen esta semana?",
  "gallery.preset.jira.desc":
    "Busca incidencias de Jira y páginas de Confluence. Inicias sesión al conectar.",
  "gallery.preset.jira.example": "Muéstrame los tickets de Jira que actualicé ayer.",
  "gallery.preset.notion.desc":
    "Busca, lee y edita páginas de tu espacio de trabajo de Notion. Inicias sesión al conectar.",
  "gallery.preset.notion.example": "Encuentra en Notion mis notas de la reunión del martes pasado.",
  "gallery.preset.todoist.desc":
    "Ve y gestiona tus tareas y proyectos de Todoist. Inicias sesión al conectar.",
  "gallery.preset.todoist.example": "¿Qué vence hoy en Todoist?",
  "gallery.preset.airtable.desc": "Lee y actualiza los registros de tus bases de Airtable.",
};
