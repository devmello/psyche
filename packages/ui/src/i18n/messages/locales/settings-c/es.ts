import type { Catalogue } from "../../index.ts";

/** settings-c strings (es); merged into `../es.ts`. */
export const settingsC: Partial<Catalogue> = {
  "settings.searchSources.excludeFolders": "No indexar nunca estas carpetas",
  "settings.searchSources.excludeFoldersPlaceholder": "~/Documents/Private",
  "settings.searchSources.indexSize": "Tamaño del índice de búsqueda: {size}",
  "settings.semanticSearch.title": "Búsqueda por significado",
  "settings.semanticSearch.description":
    "Encuentra cosas por su significado además de por sus palabras, todo en este Mac.",
  "settings.semanticSearch.enabledHint":
    "Descarga un modelo de 118 MB la primera vez. Al desactivarlo se elimina el índice de significados.",
  "settings.semanticSearch.engine.builtin": "Modelo integrado",
  "settings.semanticSearch.engine.builtinHint":
    "Multilingual E5 small, unos 100 idiomas, se ejecuta en el procesador de este Mac.",
  "settings.semanticSearch.engine.router": "Mi servidor de modelos local",
  "settings.semanticSearch.engine.routerHint":
    "Usa el modelo de embeddings definido en Roles, por ejemplo Ollama o LM Studio en este Mac.",
  "settings.semanticSearch.state.off": "Desactivado: la búsqueda compara palabras",
  "settings.semanticSearch.state.starting": "Iniciando…",
  "settings.semanticSearch.state.downloading": "Descargando el modelo: {received} de {total} MB",
  "settings.semanticSearch.state.indexing": "Indexando significados: {done} de {total}",
  "settings.semanticSearch.state.ready":
    "Activado: {n, plural, one {# pasaje indexado} other {# pasajes indexados}}",
  "settings.semanticSearch.state.readyCloud":
    "Activado, con un servicio en la nube: {n, plural, one {# pasaje indexado} other {# pasajes indexados}}",
  "settings.semanticSearch.allowCloudHint":
    "Solo si el modelo de embeddings es un servicio en la nube. Se le envían tus chats, tareas y el texto de la Biblioteca. Desactivado mantiene todo en este Mac.",
  "settings.semanticSearch.state.noModel":
    "No hay ningún modelo de embeddings definido en Roles. Elige uno o usa el modelo integrado.",
  "settings.semanticSearch.state.cloudBlocked":
    "El modelo de embeddings de Roles es un servicio en la nube. La búsqueda semántica solo usa modelos de este Mac.",
  "settings.semanticSearch.state.error": "Detenido: {reason}",
  "settings.webSearch.description":
    "Cómo busca el agente cosas en la web. Las páginas web nunca se tratan como instrucciones tuyas.",
  "settings.data.description":
    "Todo lo que {persona} guarda vive en este equipo. No se envía nada para entrenamiento.",
  "settings.data.advancedHint": "Mapas e imágenes en los widgets",
  "settings.data.keep": "Cuánto tiempo se conserva",
  "settings.data.keepHint":
    "El razonamiento y las repeticiones de tareas más antiguos se eliminan solos.",
  "settings.data.danger": "Eliminar y empezar de cero",
  "settings.memoryControls.title": "Básicos",
  "settings.memoryControls.description":
    "Elige qué recuerda {persona} y de dónde aprende. Cada opción se puede desactivar en cualquier momento.",
  "settings.learning.title": "Aprender de los comentarios",
  "settings.learning.implicit": "Fijarse en ediciones, deshacer y descartes",
  "settings.learning.implicitHint":
    "Enviar un borrador editado o deshacer una acción cuenta como comentario.",
  "settings.learning.signals": "Señales",
  "settings.learning.signal.draftEdits": "Ediciones de borradores",
  "settings.learning.signal.undo": "Deshacer",
  "settings.learning.signal.approvalEdits": "Ediciones de aprobaciones",
  "settings.learning.signal.dismissals": "Descartes",
  "settings.learning.paused": "Pausar el aprendizaje",
  "settings.learning.pausedHint":
    "Mientras está activado no se lee ni se escribe nada, y luego no se recupera nada de ese periodo.",
  "settings.learning.weeklyCard": "Tarjeta semanal «Lo que aprendí»",
  "settings.learning.weeklyCardHint":
    "Una publicación en el Feed los domingos, solo cuando hay algo que revisar.",
  "settings.learning.open": "Lo que aprendió {persona}",
  "settings.learning.openButton": "Abrir Progreso",
  "settings.learning.forgetAll": "Olvidar todo lo que aprendió {persona}",
  "settings.learning.forgetAllTitle": "¿Olvidar todo lo que {persona} aprendió de ti?",
  "settings.learning.forgetAllBody":
    "Sus notas, Alma y habilidades vuelven a lo que tú escribiste. Escribe «{phrase}» para confirmar.",
  "settings.learning.forgetPhrase": "olvidar",
  "settings.learning.forgetAllGo": "Olvidar todo",
  "settings.learning.forgotAll":
    "Se {lessons, plural, one {olvidó # lección} other {olvidaron # lecciones}} y {events, plural, one {# evento de comentarios} other {# eventos de comentarios}}.",
  "settings.data.reasoningRetentionHint":
    "Cuánto tiempo se conserva el razonamiento completo de cada paso. Desactivado conserva un resumen de una línea.",
  "settings.data.recallModeHint":
    "Tus archivos de memoria en Markdown siguen siendo la fuente de verdad. Los embeddings permiten que cada turno encuentre recuerdos por significado.",
  "settings.data.recallMode.markdown": "Solo Markdown",
  "settings.data.recallMode.markdownHint":
    "Lee los archivos y compara palabras. Nada extra que ejecutar.",
  "settings.data.recallMode.embeddings": "Markdown más embeddings",
  "settings.data.recallMode.embeddingsHint":
    "Usa la misma elección de embeddings que la Búsqueda. El modelo se carga cuando hace falta y se libera cuando está inactivo.",
  "settings.data.recallState.off": "Solo Markdown.",
  "settings.data.encryptMemory": "Cifrar la memoria en el disco",
  "settings.data.encryptMemoryHint":
    "Guarda lo que {persona} sabe de las personas en un archivo cifrado, con la clave en tu bóveda. Al desactivarlo, primero se copia todo de vuelta.",
  "settings.data.encryptMemory.restart": "Se activa la próxima vez que se inicie Psyche.",
  "settings.data.encryptMemory.on": "Cifrada.",
  "settings.data.encryptMemory.pending": "Esperando la clave del ayudante del Mac.",
  "settings.data.encryptMemory.unavailable": "No disponible: {why}",
  "settings.data.encryptMemory.offDone":
    "La memoria ha vuelto a la base de datos principal; se eliminó el archivo cifrado.",
  "settings.data.recallState.semantic":
    "Recuperando por significado y palabras: {vectors} de {chunks} pasajes de memoria indexados.",
  "settings.data.recallState.modelMissing":
    "El modelo de embeddings aún no se ha descargado, así que la recuperación solo compara palabras. Activa la Búsqueda semántica en Ajustes → Conectores y fuentes → Búsqueda para descargarlo.",
  "settings.data.recallState.cloudBlocked":
    "El servicio de embeddings no tiene permiso para recibir tu memoria, así que la recuperación solo compara palabras.",
  "settings.data.recallState.textOnly":
    "No hay ningún modelo de embeddings disponible, así que la recuperación solo compara palabras.",
  "settings.data.replayRetentionHint":
    "Las pantallas que {persona} miró mientras trabajaba, para la cronología. Desactivado no guarda ninguna.",
  "settings.devices.presenceKey.unknown": "Clave de Touch ID (el ayudante no indica el tipo)",
  "settings.devices.presenceKey.deviceIdentity":
    "Los pagos usan Touch ID o la contraseña de tu Mac. No hay nada que configurar.",
  "settings.devices.touchId.none":
    "Aún no hay ninguna clave de Touch ID. Las tarjetas que necesitan Touch ID no se pueden aprobar hasta que se registre una.",
  "settings.devices.touchId.bundled": "El Psyche Helper de esta app muestra la clave",
  "settings.devices.touchId.notBundled":
    "Este ayudante no es el que viene con esta app, así que su clave no se puede registrar aquí.",
  "settings.devices.touchId.keyMismatch":
    "El ayudante de Psyche de esta app ahora muestra la clave {shown}, no la registrada {registered}. Si no restableciste la clave tú, considéralo sospechoso y no la registres.",
  "settings.devices.touchId.confirmReplace":
    "Esto reemplaza la clave de Touch ID {previous} registrada para este Mac. Reemplázala solo si restableciste la clave tú.",
  "settings.devices.touchId.confirmReplaceButton": "Reemplazar la clave",
  "settings.devices.touchId.noBundledKey":
    "El Psyche Helper de esta app no tiene clave de Touch ID ({reason}).",
  "settings.devices.touchId.register": "Registrar esta clave",
  "settings.devices.touchId.remove": "Quitar clave",
  "settings.devices.touchId.manualLabel": "ID de la clave",
  "settings.devices.touchId.manualHint":
    "Ejecuta psyche-helper --print-identity en el Mac y pega el presenceKeyId que imprime.",
  "settings.files.execHost": "Ejecutar comandos en este Mac",
  "settings.files.execHostHint":
    "Deja que {persona} ejecute comandos en tus carpetas compartidas, en el entorno aislado. Los comandos que podrían cambiar archivos preguntan antes.",
  "settings.files.execHostSwitch": "Permitir comandos en este Mac",
  "settings.files.readOnlyQuiet": "Ejecutar comandos de solo lectura sin preguntar",
  "settings.files.readOnlyQuietHint":
    "Los comandos básicos de archivos e información que solo leen, como ls, cat o wc, se ejecutan en el entorno aislado sin tarjeta. Todo lo demás pregunta, git incluido, y también cada comando después de que {persona} lea algo de fuera.",
  "settings.files.revoke": "Revocar",
  "settings.files.description":
    "{persona} solo accede a lo que permites, y pregunta en el chat cuando necesita más.",
  "settings.files.foldersHint":
    "Solo lectura deja que {persona} abra y busque en una carpeta; lectura y escritura deja que guarde cambios. Revocar surte efecto al instante.",
  "settings.files.addYourself": "Añadir una carpeta tú mismo",
  "settings.files.addYourselfHint":
    "Normalmente no hace falta: {persona} pregunta cuando una tarea necesita una carpeta. Las carpetas añadidas empiezan en solo lectura.",
  "settings.access.title": "A qué puede acceder {persona}",
  "settings.access.listLabel": "A qué puede acceder {persona}",
  "settings.access.empty":
    "Todavía nada. Cuando {persona} necesita una carpeta o una app, te lo pregunta en el chat, y lo que permitas aparece aquí.",
  "settings.access.scope.always": "Siempre",
  "settings.access.scope.conversation": "Este chat",
  "settings.access.scope.limited": "Por ahora",
  "settings.access.used": "usado {when}",
  "settings.access.revokeNamed": "Revocar {name}",
  "settings.access.loadLabel": "a lo que Psyche puede acceder",
  "settings.access.loadFailed": "Psyche no pudo cargar a qué puede acceder ({reason}).",
  "settings.access.unchanged": "El acceso no ha cambiado.",
  "settings.model.advancedHint": "Límites de contexto, modelos locales",
  "settings.permissions.subject.prepNotes": "Notas tituladas «Prep:» (preparación de reuniones)",
  "settings.permissions.specificConnectors":
    "Los permisos de un conector concreto se ajustan en su página en Conectores.",
  "settings.permissions.openConnectors": "Abrir Conectores",
  "settings.persona.description": "Cómo se ve y se presenta {name}.",
  "settings.persona.whileWorking": "Mientras trabaja",
  "settings.persona.showReasoningHint":
    "Muestra el razonamiento de {persona} mientras trabaja. Nunca se guarda.",
  "settings.connectors.page.onHost": "En {host}",
  "settings.connectors.page.row.onHost": "En {host}",
  "settings.computerUse.remote":
    "El uso del ordenador funciona en {host}. Pídelo desde allí o usa el navegador.",
  "settings.gateways.title": "Gateways en este ordenador",
  "settings.gateways.description":
    "Usa Psyche desde este ordenador con el Gateway de otro, como tu Mac de casa. Solo hay un Gateway activo a la vez, y cambiar reinicia Psyche.",
  "settings.gateways.loadLabel": "Gateways guardados",
  "settings.gateways.thisMac": "Este Mac",
  "settings.gateways.active": "Conectado",
  "settings.gateways.pinned": "Identidad fijada",
  "settings.gateways.notPinned": "Fija su identidad en la primera conexión",
  "settings.gateways.switch": "Cambiar",
  "settings.gateways.switchTo": "Cambiar a {name}",
  "settings.gateways.switchTitle": "¿Cambiar a {name}?",
  "settings.gateways.switchKeep":
    "Psyche se reinicia en {name}. Psyche en este Mac sigue ejecutándose, así que sus automatizaciones continúan.",
  "settings.gateways.switchOnly": "Cambiar",
  "settings.gateways.switchAndStop": "Cambiar y detener Psyche en este Mac",
  "settings.gateways.pairAgain": "Vincular de nuevo",
  "settings.gateways.pairAgainNamed": "Vincular de nuevo con {name}",
  "settings.gateways.forget": "Olvidar",
  "settings.gateways.forgetNamed": "Olvidar {name}",
  "settings.gateways.add": "Añadir un Gateway",
  "settings.gateways.addressLabel": "Enlace de vinculación o dirección",
  "settings.gateways.addressPlaceholder": "studio-mac.your-tailnet.ts.net",
  "settings.gateways.nameLabel": "Nombre (opcional)",
  "settings.gateways.addHint":
    "Pega el enlace de vinculación del Mac que ejecuta Psyche (Ajustes, Servidor y acceso remoto, Vincular otro ordenador). Sin enlace, escribe su dirección de Tailscale, https://<host>.<tailnet>.ts.net; este ordenador pedirá vincularse y el propietario lo aprueba allí.",
  "settings.gateways.newLink": "Ha llegado un nuevo enlace de vinculación. ¿Usarlo?",
  "settings.gateways.useNewLink": "Usarlo",
  "settings.gateways.ignoreNewLink": "Ignorar",
  "settings.gateways.fromLink":
    "Abierto desde un enlace de vinculación. Compruébalo y pulsa Añadir Gateway. Psyche te pide confirmar la dirección antes de conectarse.",
  "settings.gateways.adding": "Añadir Gateway",
  "settings.gateways.problem.empty": "Escribe la dirección del Gateway.",
  "settings.gateways.problem.invalid": "Esa no es una dirección que Psyche pueda usar.",
  "settings.gateways.problem.needs_full_name":
    "Usa el nombre completo, como studio-mac.your-tailnet.ts.net. Un nombre corto no se puede comprobar.",
  "settings.gateways.problem.needs_https":
    "Usa una dirección https://. El http simple solo funciona a través de un túnel SSH en este ordenador.",
  "settings.gateways.problem.has_path": "Usa solo la dirección, sin ruta.",
  "settings.gateways.problem.has_credentials": "Quita cualquier nombre de usuario o contraseña.",
  "settings.gateways.problem.link_not_a_pairing_link": "Eso no es un enlace de vinculación.",
  "settings.gateways.problem.link_unsupported_version":
    "Ese enlace de vinculación es de una versión más reciente de Psyche. Actualiza Psyche en este ordenador e inténtalo de nuevo.",
  "settings.gateways.problem.link_malformed":
    "Ese enlace de vinculación está dañado. Cópialo de nuevo desde el Mac que lo creó.",
  "settings.gateways.problem.link_extra_fields":
    "Ese enlace de vinculación tiene algo que Psyche no entiende, así que no se usa.",
  "settings.gateways.problem.link_bad_field":
    "Ese enlace de vinculación está dañado. Cópialo de nuevo desde el Mac que lo creó.",
  "settings.gateways.problem.link_lan":
    "Este enlace de vinculación es de un ordenador de tu red local pero no incluye su certificado, así que no se usa. En ese Mac, crea uno nuevo: Vincular otro ordenador, Desde esta red.",
  "settings.gateways.problem.link_not_lan":
    "Ese enlace de vinculación indica una dirección que no está en una red local, así que no se usa.",
  "settings.gateways.problem.link_pin_mismatch":
    "Este Gateway ya está guardado con una identidad distinta. Usa antes «Vincular de nuevo» en él y luego añade el enlace.",
  "settings.gateways.problem.failed": "No se pudo añadir el Gateway. No cambió nada.",
  "settings.gateways.problem.declined": "Se canceló añadir el Gateway.",
  "settings.gateways.problem.actionFailed": "Eso no funcionó. No cambió nada.",
  "settings.remote.title": "Permitir otros ordenadores",
  "settings.remote.description":
    "Deja que Psyche en otro ordenador use el Gateway de este Mac a través de Tailscale. El Gateway se queda en este Mac y solo escucha a Tailscale; Tailscale Serve es la única entrada.",
  "settings.remote.step1":
    "Instala Tailscale en este Mac y en el otro ordenador, e inicia sesión en ambos en la misma tailnet.",
  "settings.remote.step2":
    "En Terminal en este Mac, publica el Gateway en tu tailnet. Es Serve, no Funnel.",
  "settings.remote.copyCommand": "Copiar comando",
  "settings.remote.copied": "Copiado",
  "settings.remote.step3":
    "Indica al Gateway su dirección. En config.json, en la carpeta de datos de Psyche, define:",
  "settings.remote.step4":
    "Reinicia Psyche. Luego, en el otro ordenador, añade este Mac como Gateway. Mostrará un código de vinculación y la huella de una clave: compáralos con la solicitud en «Esperando vinculación» aquí y apruébala.",
  "settings.remote.funnel":
    "No actives nunca Tailscale Funnel para esto. Pondría el Gateway en internet público.",
  "settings.remote.configWarnings":
    "config.json tiene ajustes que esta versión de Psyche no conoce, así que los ignora: {keys}. Si querías usar alguno, revisa la ortografía.",
  "settings.uninstall.group": "Desinstalar Psyche",
  "settings.uninstall.groupHint":
    "Detiene el Gateway y el asistente y mueve la app a la Papelera. Tus datos se quedan, salvo que elijas otra cosa.",
  "settings.uninstall.open": "Desinstalar Psyche…",
  "settings.uninstall.title": "Desinstalar Psyche",
  "settings.uninstall.description":
    "Todo lo que aparece abajo va a la Papelera, así que aún puedes recuperarlo. No se elimina nada de forma permanente.",
  "settings.uninstall.dataChoice": "Tus datos",
  "settings.uninstall.keep": "Conservar mis datos",
  "settings.uninstall.keepHint":
    "Los chats, la memoria, la bóveda y las copias de seguridad se quedan en la carpeta de datos.",
  "settings.uninstall.delete": "Eliminar mis datos",
  "settings.uninstall.deleteHint":
    "También mueve la carpeta de datos a la Papelera: chats, memoria, bóveda y copias de seguridad.",
  "settings.uninstall.willDo": "Qué ocurre",
  "settings.uninstall.stopAgent": "El LaunchAgent del Gateway se detiene y se elimina.",
  "settings.uninstall.stopHelper":
    "Psyche Helper se detiene y «Abrir al iniciar sesión» se desactiva.",
  "settings.uninstall.trash": "Movido a la Papelera",
  "settings.uninstall.kind.agent": "LaunchAgent del Gateway",
  "settings.uninstall.kind.support": "Application Support",
  "settings.uninstall.kind.cache": "Cachés, registros, preferencias y estado guardado",
  "settings.uninstall.kind.data": "Tus datos",
  "settings.uninstall.kind.app": "La app",
  "settings.uninstall.agentOther":
    "El agente del Gateway pertenece a otra copia de Psyche o a la herramienta de línea de comandos, así que no se toca.",
  "settings.uninstall.blocked": "{path} no se puede mover a la Papelera desde aquí: {reason}",
  "settings.uninstall.keychainStays":
    "Los elementos del llavero se quedan (la clave de la bóveda y los del asistente). Elimínalos en Acceso a Llaveros si quieres.",
  "settings.uninstall.keychainGoes":
    "También se eliminan los elementos del llavero de la bóveda y del asistente.",
  "settings.uninstall.removeKeychain":
    "Eliminar también mis elementos del llavero (com.psyche.vault y los del asistente). Sin tus datos no sirven de nada.",
  "settings.uninstall.kind.state": "Estado guardado de las ventanas",
  "settings.uninstall.dataStays": "Tu carpeta de datos no se toca.",
  "settings.uninstall.typeWord": "Escribe {word} para confirmar",
  "settings.uninstall.presence":
    "Después se te pedirá que confirmes con Touch ID o en este dispositivo, porque esto elimina tus datos.",
  "settings.uninstall.approvalLabel": "Desinstalar Psyche y eliminar los datos",
  "settings.uninstall.failed": "Psyche no pudo desinstalarse ({reason}). No se cambió nada más.",
  "settings.uninstall.cancel": "Cancelar",
  "settings.uninstall.go": "Desinstalar y salir",
  "settings.uninstall.goDelete": "Eliminar los datos y desinstalar",
  "settings.remote.admin":
    "Un ordenador que se vincula obtiene lectura, escritura y aprobaciones. Admin sigue desactivado salvo que lo marques al aprobar, y cada cambio de admin sigue necesitando tu Touch ID aquí.",
  "settings.remote.address": "Dirección pública",
  "settings.remote.addressUnset": "Sin definir",
  "settings.remote.proxy": "Proxy de confianza",
  "settings.remote.on": "Activado",
  "settings.remote.off": "Desactivado",
  "settings.remote.fingerprint": "Clave de este Gateway",
  "settings.remote.fingerprintHint":
    "Compárala con la huella que muestra el otro ordenador al conectarse por primera vez.",
  "settings.remote.loadLabel": "Identidad del Gateway",
  "settings.remote.clientNote":
    "Este ordenador es cliente de {host}. El acceso remoto se configura en {host}.",
  "settings.pair.title": "Vincular otro ordenador",
  "settings.pair.description":
    "Crea un enlace de vinculación, o un código QR, para Psyche en otro ordenador. Funciona una vez, durante diez minutos, y el ordenador que lo use queda vinculado con el acceso que marques aquí, sin segunda aprobación.",
  "settings.pair.needsAddress":
    "Define primero la dirección pública de este Mac (paso 3 de arriba) y luego crea un enlace de vinculación.",
  "settings.pair.scopes": "Qué puede hacer el otro ordenador",
  "settings.pair.adminHint":
    "Admin le permite cambiar ajustes de seguridad, dispositivos y la bóveda, y sigue desactivado salvo que lo marques. Cada cambio de admin sigue necesitando tu Touch ID aquí.",
  "settings.pair.make": "Crear un enlace de vinculación",
  "settings.pair.resultRegion": "Enlace de vinculación y código QR",
  "settings.pair.qrLabel": "Código QR del enlace de vinculación de {host}",
  "settings.pair.scan":
    "En el otro ordenador, elige «Añadir un Gateway» y pega este enlace para {host}.",
  "settings.pair.expires": "Caduca {when}.",
  "settings.pair.linkLabel": "Enlace de vinculación",
  "settings.pair.copy": "Copiar enlace",
  "settings.pair.gives": "Una vez usado, ese ordenador obtiene: {scopes}.",
  "settings.pair.compare":
    "Comprueba la clave de este Mac antes de usar el enlace: {fingerprint}. Puedes compararla.",
  "settings.pair.secret":
    "Quien tenga este enlace en los próximos diez minutos puede vincular un ordenador. No lo publiques ni lo envíes a nadie en quien no confiarías para este Mac.",
  "settings.pair.live": "Enlaces de vinculación sin usar",
  "settings.pair.unused": "Aún sin usar",
  "settings.pair.revoke": "Revocar",
  "settings.pair.revokeNamed": "Revocar el enlace de vinculación creado {when}",
  "settings.pair.madeToast":
    "Enlace de vinculación creado. Funciona una vez, durante diez minutos.",
  "settings.pair.usedToast": "Un ordenador se vinculó con tu enlace.",
  "settings.pair.gone": "El enlace de vinculación ya no es válido, así que ya no se muestra.",
  "settings.pair.err.noAddress":
    "Este Mac aún no tiene dirección pública, así que no hay nada que poner en un enlace.",
  "settings.pair.err.tooMany":
    "Ya hay tres enlaces de vinculación sin usar. Revoca uno o espera a que caduque.",
  "settings.pair.err.forbidden":
    "Solo Psyche en el propio Host, vinculado como admin, puede crear un enlace de vinculación.",
  "settings.pair.err.failed": "No se pudo crear un enlace de vinculación ({reason}).",
};
