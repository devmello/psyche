import type { Catalogue } from "../../index.ts";

/** settings-d strings (es); merged into `../es.ts`. */
export const settingsD: Partial<Catalogue> = {
  "settings.pair.via": "¿Desde dónde se conectará el otro ordenador?",
  "settings.pair.viaAddress": "Por Tailscale, en la dirección de este Mac",
  "settings.pair.viaLan": "Desde esta red",
  "settings.pair.viaLanHint":
    "Un enlace para esta red contiene la clave y el certificado de este Mac, así que solo funciona para ordenadores en el mismo Wi-Fi o Ethernet.",
  "settings.pair.lanNote":
    "Este enlace es para ordenadores de la misma red que este Mac. Indica la clave y el certificado que Psyche exigirá.",
  "settings.pair.err.noLan":
    "Activa «Permitir ordenadores de esta red» y espera a que esté escuchando para crear un enlace para esta red.",
  "settings.key.gateway.lan": "Permitir ordenadores de esta red",
  "settings.key.gateway.lan.rotateCert": "El certificado de red",
  "settings.lan.title": "Permitir ordenadores de esta red",
  "settings.lan.description":
    "Deja que Psyche en otro ordenador del mismo Wi-Fi o Ethernet acceda al Gateway de este Mac, sin Tailscale. Está desactivado hasta que lo actives.",
  "settings.lan.loadLabel": "Acceso a la red",
  "settings.lan.unsupported": "Este Gateway es demasiado antiguo para escuchar en la red.",
  "settings.lan.toggle": "Permitir ordenadores de esta red",
  "settings.lan.toggleHint":
    "Psyche escucha en una red, mediante una conexión cifrada con su propio certificado. Un ordenador que se conecta sigue necesitando aprobación aquí con Touch ID.",
  "settings.lan.ipv6": "Usar también las direcciones IPv6 de esta red",
  "settings.lan.ipv6Hint":
    "Añade las direcciones IPv6 privadas (empiezan por fd o fc) de la red elegida. Nunca se usan las direcciones IPv6 públicas ni las fe80.",
  "settings.lan.problem.ipv6Off":
    "{address} es una dirección IPv6 y IPv6 está desactivado, así que Psyche no escucha en ella. Activa IPv6 arriba o quítala.",
  "settings.lan.problem.ipv6NeedsIpv4":
    "Psyche no escucha en {address}. IPv6 solo se usa junto con la dirección IPv4 de esta red, que antes tienes que permitir aquí.",
  "settings.lan.interface": "Red",
  "settings.lan.interfaceDefault": "Red principal",
  "settings.lan.interfaceOption": "{name} ({address})",
  "settings.lan.noInterface": "No se encontró ninguna conexión Wi-Fi ni Ethernet en este Mac.",
  "settings.lan.trustedOnly":
    "Actívalo solo en una red de confianza. En un Wi-Fi compartido o de invitados, cualquiera conectado puede llegar a la pantalla de vinculación.",
  "settings.lan.status": "Estado",
  "settings.lan.listening": "Escuchando en {addresses}",
  "settings.lan.notListening": "No escucha",
  "settings.lan.address": "Dirección",
  "settings.lan.discovery": "Detección",
  "settings.lan.advertised": "Visible para Psyche en esta red",
  "settings.lan.notAdvertised": "No visible. Añade este Mac por su dirección.",
  "settings.lan.certificate": "Certificado",
  "settings.lan.certificateHint":
    "Los ordenadores que se vinculan lo recuerdan. Si sustituyes el certificado, todos tienen que vincularse de nuevo.",
  "settings.lan.rotate": "Sustituir certificado",
  "settings.lan.rotateTitle": "¿Sustituir el certificado de red?",
  "settings.lan.rotateBody":
    "Los ordenadores ya vinculados por la red dejarán de conectarse hasta que se vinculen de nuevo. Úsalo si crees que el certificado se copió.",
  "settings.lan.rotateConfirm": "Sustituir y desconectarlos",
  "settings.lan.rotateFailed": "No se pudo sustituir el certificado ({reason}). No cambió nada.",
  "settings.lan.problem.unknownInterface": "{name} no es una red de este Mac.",
  "settings.lan.problem.noInterface":
    "No hay ninguna red en la que escuchar, así que no se escucha nada.",
  "settings.lan.problem.bindFailed":
    "No se pudo escuchar en {address}. Puede que otro programa esté usando el puerto.",
  "settings.lan.problem.paused":
    "El acceso por red local está en pausa en esta red. Lo activaste para otra distinta.",
  "settings.lan.allowHere": "Permitir en esta red",
  "settings.lan.problem.cert":
    "Psyche no pudo crear ni leer su certificado de red, así que no escucha.",
  "settings.lan.problem.cloudflare":
    "Este Gateway está configurado para ser accesible solo a través de Cloudflare Access, así que tampoco escuchará en la red.",
  "settings.gateways.discoverConflict":
    "Más de un ordenador anunció este nombre con claves distintas, así que Psyche no lo añade. Añade el correcto por su dirección.",
  "settings.lan.problem.container":
    "Un Gateway en un contenedor no escucha en la red de esta manera.",
  "settings.lan.problem.advertise":
    "Psyche no pudo anunciarse en la red. Los ordenadores aún pueden añadir este Mac por su dirección.",
  "settings.gateways.discover": "Buscar en esta red",
  "settings.gateways.discovering": "Buscando…",
  "settings.gateways.discoverTitle": "En esta red",
  "settings.gateways.discoverNone":
    "No se encontró ningún Psyche. En ese ordenador, activa «Permitir ordenadores de esta red».",
  "settings.gateways.discoverFailed": "No se pudo buscar en la red. Añádelo por su dirección.",
  "settings.gateways.discoverKey": "Clave {fingerprint}",
  "settings.gateways.discoverHint":
    "Lo que un ordenador anuncia en la red es una afirmación. La pantalla de vinculación muestra su clave: compárala con la del Host antes de aprobar.",
  "settings.gateways.discoverAdd": "Añadir {name}",
  "settings.gateways.discoverSaved": "Guardado",
  "settings.devices.gatewayKey": "Clave de este Gateway {fingerprint}",
  "settings.devices.fromAddress": "Desde {address}",
  "settings.devices.fromLan": "Desde {address}, en tu red. Comprueba la clave completa de abajo.",
  "settings.devices.adminOptIn":
    "Admin permite que este ordenador cambie ajustes de seguridad, dispositivos y la bóveda. Déjalo desactivado salvo que lo necesites.",
  "settings.skills.signer.title": "Quién lo hizo",
  "settings.skills.signer.unsigned":
    "Sin firmar. Nada indica quién lo hizo ni que no se modificó por el camino, así que se instala como un editor desconocido.",
  "settings.skills.signer.new": "Firmado por {name}. No habías visto esta clave antes.",
  "settings.skills.signer.seen":
    "Firmado por {name}, con una clave que ya has visto pero en la que no has confiado.",
  "settings.skills.signer.trusted": "Firmado por {name}, un autor en quien confías.",
  "settings.skills.signer.own": "Firmado por ti.",
  "settings.skills.signer.changed":
    "Firmado por {name}, pero no con la clave vista antes. Comprueba que sea la misma persona antes de instalarlo.",
  "settings.skills.signer.changedUpdate":
    "Firmado por {name}, con una clave distinta a la de la versión que tienes instalada. Comprueba que sea la misma persona antes de actualizar.",
  "settings.skills.signer.dropped":
    "La versión instalada estaba firmada por {name}. Esta no está firmada en absoluto.",
  "settings.skills.signer.impersonates":
    "Firmado por {name}, que se parece al nombre con el que firmas tus propias habilidades, pero la clave no es tuya. No lo instales salvo que sepas de dónde viene.",
  "settings.skills.signer.nameChanged":
    "Firmado con una clave en la que confías, pero con un nombre que no había usado antes: {name}. Comprueba que sigue siendo la misma persona.",
  "settings.skills.signer.originAgent":
    "Escrito por un asistente en el Mac del remitente. Léelo como texto sin revisar, lo haya firmado quien lo haya firmado.",
  "settings.skills.widened.specialist": "Rol en segundo plano",
  "settings.skills.bundleOriginAgent": "Escrito por un asistente en otro lugar",
  "settings.skills.export.label": "Firmando «{name}»",
  "settings.skills.author.label": "Confianza en el autor",
  "settings.skills.signer.claim":
    "El nombre es lo que el autor afirma de sí mismo. La clave es lo que une las versiones.",
  "settings.skills.signer.key": "Clave del autor",
  "settings.skills.signer.trust": "Confiar en {name} como autor",
  "settings.skills.signer.trustHint":
    "Las versiones posteriores firmadas con esta clave se marcan como de un autor en quien confías. Cada instalación sigue preguntándote antes.",
  "settings.skills.widened.title": "Pide más que la versión instalada",
  "settings.skills.widened.hint":
    "Aprobarlo no le da ningún permiso por sí solo, pero ahora también llevará a estas preguntas.",
  "settings.skills.widened.permissions": "Permisos nuevos",
  "settings.skills.widened.tools": "Herramientas nuevas",
  "settings.skills.widened.prompts": "Archivos de prompt nuevos",
  "settings.skills.import.file": "Importar un archivo…",
  "settings.skills.import.hint":
    "Un archivo .psyche-skill de otra persona, o un enlace https a uno. Se comprueba y se te muestra antes de instalar nada.",
  "settings.skills.import.failed": "Psyche no pudo leer ese archivo ({reason}).",
  "settings.skills.import.tooBig": "ese archivo supera los 8 MB",
  "settings.skills.signedBy": "Firmado por {name}",
  "settings.skills.signedState":
    "{state, select, own {tú} trusted {de confianza} revoked {revocado} other {sin confianza}}",
  "settings.skills.export": "Exportar…",
  "settings.skills.export.title": "Exportar «{name}»",
  "settings.skills.export.hint":
    "El archivo se firma con tu clave de autor, para que quien lo reciba sepa que es tuyo y que no se modificó. La clave se queda en este Mac.",
  "settings.skills.export.nameLabel": "Nombre con el que firmar",
  "settings.skills.export.nameHint":
    "Se crea una vez. Todos los que importen tus habilidades lo ven.",
  "settings.skills.export.go": "Exportar y firmar",
  "settings.skills.exported":
    "«{name}» exportado como {file}, firmado como {author}.{created, select, true { Se creó tu clave de autor: {key}.} other {}}",
  "settings.skills.author.trust": "Confiar en este autor",
  "settings.skills.author.untrust": "Dejar de confiar en este autor",
  "settings.skills.author.revoke": "Revocar este autor",
  "settings.skills.author.revokeTitle": "¿Revocar la clave de {name}?",
  "settings.skills.author.revokeDescription":
    "Las habilidades firmadas con ella dejan de cargarse y se rechazan los archivos nuevos firmados con ella. Puedes volver a confiar en ella más tarde.",
  "settings.skills.author.revokeConfirm": "Revocar",
  "settings.usage.unavailable": "El uso todavía no está disponible desde este Gateway.",
  "settings.usage.thisMonth": "Este mes",
  "settings.usage.monthLine":
    "{cost} y {tokens} tokens en {turns, plural, one {# turno} other {# turnos}}. Hoy hasta ahora: {today}.",
  "settings.usage.noBudget": "No hay presupuesto mensual definido.",
  "settings.usage.byModel": "Últimos 7 días por modelo",
  "settings.usage.model": "Modelo",
  "settings.usage.turns": "{n, plural, one {# turno} other {# turnos}}",
  "settings.usage.planWindow":
    "{model}: {pct}% de la ventana del plan usada, se restablece {when}.",
  "settings.vm.enabledHint":
    "Las tareas que lo piden se ejecutan en el invitado, solo con las carpetas que compartes.",
  "settings.vm.credentialsHint":
    "Con la bóveda del anfitrión, los valores se quedan en tu Mac. Una bóveda del invitado guarda su propia copia.",
  "settings.voice.anyAppHint":
    "donde sea que estés escribiendo. El texto va a tu cursor, nunca al agente ni a un campo de contraseña.",
  "settings.voice.talkHint":
    "Un botón de Voz en el área de escritura inicia una conversación hablada. La voz nunca aprueba nada.",
  "settings.people.title": "Personas y proyectos",
  "settings.people.description":
    "Las fichas que {persona} guarda de las personas y proyectos de tu vida. Se quedan en este Mac y cada dato muestra de dónde viene.",
  "settings.people.loadLabel": "Cargando los ajustes de personas y proyectos",
  "settings.people.off":
    "Desactivado. {persona} no guarda fichas de las personas y proyectos de tu vida.",
  "settings.people.turnOn": "Activar",
  "settings.people.graph": "Aprender de personas a partir de",
  "settings.people.entityRecall": "Usar nombres en las respuestas",
  "settings.people.entityRecallHint":
    "Cuando nombras a alguien en un chat privado, {persona} añade una línea sobre esa persona. Nunca en grupos ni canales.",
  "settings.people.sources": "Aprender de personas a partir de",
  "settings.people.sourcesHint":
    "Cada fuente está desactivada hasta que la actives. Desactivarla deja de leerla.",
  "settings.people.source.contacts": "Contactos",
  "settings.people.source.mail": "Correo",
  "settings.people.source.calendar": "Calendario",
  "settings.people.source.messages": "Mensajes",
  "settings.people.source.messagesHint":
    "Usa con quién hablas y cuándo, nunca el texto de los mensajes.",
  "settings.people.source.notes": "Notas",
  "settings.people.source.chats": "Tus chats",
  "settings.people.sourceOff": "Desactivado",
  "settings.people.sourceCounts":
    "{entities, plural, one {# persona o proyecto} other {# personas y proyectos}} · {interactions, plural, one {# interacción} other {# interacciones}} · {read, select, none {aún sin leer} other {leído {read}}}",
  "settings.people.retention": "Cuánto duran las interacciones",
  "settings.people.retentionLabel": "Conservar las interacciones durante",
  "settings.people.retentionHint":
    "Las cabeceras y enlaces más antiguos se eliminan cada noche. Las fichas, los datos y los asuntos abiertos se quedan hasta que los olvides.",
  "settings.people.months": "{n, plural, one {# mes} other {# meses}}",
  "settings.people.learning": "Cómo se mantienen las fichas",
  "settings.people.learningHint":
    "Los resúmenes, los roles y los asuntos abiertos vienen del modelo auxiliar, local por defecto.",
  "settings.people.budget":
    "Esta noche: {tokens, number} de {maxTokens, number} tokens, {entities, number} de {maxEntities, number} personas y proyectos. Los resúmenes, roles y asuntos abiertos vienen del modelo auxiliar, local por defecto.",
  "settings.people.nightly": "Cada noche",
  "settings.people.nightlyHint":
    "Actualiza los resúmenes y encuentra asuntos abiertos mientras duermes.",
  "settings.people.afterRun": "Tras cada tarea",
  "settings.people.afterRunHint": "Actualiza las pocas personas y proyectos que tocó una tarea.",
  "settings.people.precision": "Asuntos sugeridos que conservaste: {list}.",
  "settings.people.precisionItem": "{source} {confirmed, number} de {total, number}",
  "settings.people.aboutYou": "Sobre ti",
  "settings.people.aboutYouHint":
    "Tu propia ficha: cada dato que {persona} aprendió sobre ti, con su fuente.",
  "settings.people.openOwnCard": "Abrir tu ficha",
  "settings.people.ownCardHint": "Datos sobre ti de tu perfil, chats y apps conectadas.",
  "settings.people.editUserMd": "Editar USER.md",
  "settings.people.blocked": "Bloqueado en Personas",
  "settings.people.blockedHint":
    "No se vuelve a aprender nada de ello. Un dominio bloqueado cubre todas las direcciones de ese dominio.",
  "settings.people.noneBlocked": "No hay nadie bloqueado.",
  "settings.people.blockedOn": "{kind} · bloqueado {date}",
  "settings.people.unblock": "Desbloquear",
  "settings.people.unblockLabel": "Desbloquear {hint}",
  "settings.people.block": "Bloquear",
  "settings.people.blockKindLabel": "Qué bloquear",
  "settings.people.blockValue": "Dirección, teléfono o dominio",
  "settings.people.blockKind.email": "Dirección de correo",
  "settings.people.blockKind.phone": "Número de teléfono",
  "settings.people.blockKind.domain": "Dominio",
  "settings.people.blockKind.contact": "Contacto",
  "settings.people.blockKind.channel": "Canal",
  "settings.people.blockKind.calendar": "Calendario",
  "settings.people.blockKind.url": "Dirección web",
  "settings.people.blockPlaceholder.email": "nombre@ejemplo.com",
  "settings.people.blockPlaceholder.phone": "+34 600 000 000",
  "settings.people.blockPlaceholder.domain": "ejemplo.com",
  "settings.people.nothingStored": "Aún no hay nada guardado de ninguna fuente.",
  "settings.people.sourceStored":
    "{entities, plural, one {# persona o proyecto} other {# personas y proyectos}} · {interactions, plural, one {# interacción} other {# interacciones}}",
  "settings.people.deleteSource": "Eliminar…",
  "settings.people.deleteSourceLabel": "Eliminar lo que aportó {source}",
  "settings.people.deleteSourceTitle": "¿Eliminar lo que aportó {source}?",
  "settings.people.deleteSourceAfter":
    "{source} se desactiva para que la próxima sincronización no lo traiga de vuelta. Los datos que añadiste tú se conservan.",
  "settings.people.deleteSourceConfirm": "Eliminar",
  "settings.people.deletedSource": "Se eliminó lo que aportó {source}.",
  "settings.people.forgetAll": "Todo sobre personas y proyectos",
  "settings.people.forgetAllHint":
    "Elimina cada persona, proyecto, ficha y asunto abierto, y desactiva Personas y proyectos. Tus propios archivos de memoria se quedan.",
  "settings.people.forgetAllButton": "Olvidar…",
  "settings.people.forgetAllTitle": "¿Olvidar todo sobre personas y proyectos?",
  "settings.people.forgetAllAfter":
    "No se puede deshacer. Personas y proyectos se desactiva; vuelve a activarlo para empezar de cero.",
  "settings.people.typeToConfirm": "Escribe «{phrase}» para confirmar",
  "settings.people.forgetAllConfirm": "Olvidar todo",
  "settings.people.forgotAll": "Se olvidó todo sobre personas y proyectos.",
  "settings.people.counting": "Comprobando qué se eliminaría…",
  "settings.people.previewFailed": "Psyche no pudo contar lo que eliminaría ({reason}).",
};
