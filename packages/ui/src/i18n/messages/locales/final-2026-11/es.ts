import type { Catalogue } from "../../index.ts";

/** Signed connector bundles and teach-by-showing in Mac apps (es); merged into `../es.ts`. */
export const final202611: Partial<Catalogue> = {
  "settings.connectorBundle.title": "Conector compartido {name}",
  "settings.connectorBundle.intro":
    "Alguien compartió este conector como un archivo. Todavía no se ha instalado nada. Comprueba quién lo hizo y qué pide, y luego decide.",
  "settings.connectorBundle.update": "Esta es una actualización del conector que tienes.",
  "settings.connectorBundle.signer.title": "Quién lo hizo",
  "settings.connectorBundle.signer.unsigned":
    "Este archivo no está firmado, así que no hay forma de saber quién lo hizo.",
  "settings.connectorBundle.signer.dropped": "La versión instalada estaba firmada. Esta no.",
  "settings.connectorBundle.signer.new": "Firmado por {name}. No habías visto esta clave antes.",
  "settings.connectorBundle.signer.seen":
    "Firmado por {name}, con una clave que ya has visto pero en la que no confías.",
  "settings.connectorBundle.signer.trusted": "Firmado por {name}, un autor en quien confías.",
  "settings.connectorBundle.signer.own": "Firmado por ti.",
  "settings.connectorBundle.signer.changed":
    "Firmado por {name}, pero no con la clave vista antes. Comprueba que sea la misma persona.",
  "settings.connectorBundle.signer.impersonates":
    "Firmado con un nombre que se parece al tuyo, con una clave que no es tuya.",
  "settings.connectorBundle.signer.nameChanged":
    "Una clave en la que confías está firmando con un nombre que no había usado antes: {name}.",
  "settings.connectorBundle.signer.revoked": "Firmado con una clave que revocaste.",
  "settings.connectorBundle.signer.rotated":
    "Firmado por {name}: mismo autor, clave nueva (firmada por la clave anterior). No se confía en la clave nueva hasta que confíes en ella.",
  "settings.connectorBundle.signer.claim":
    "El nombre es lo que el autor afirma de sí mismo. Solo la clave lo identifica.",
  "settings.connectorBundle.signer.key": "Clave del autor",
  "settings.connectorBundle.signer.trust": "Confiar en {name} como autor",
  "settings.connectorBundle.signer.trustHint":
    "Esto solo cambia la etiqueta y los avisos de los archivos posteriores. Nunca omite esta tarjeta.",
  "settings.connectorBundle.command": "Comando que ejecuta",
  "settings.connectorBundle.commandHint":
    "Primero el programa y luego cada argumento en su propia línea. No se ejecuta a través de un shell.",
  "settings.connectorBundle.network": "Red que pide",
  "settings.connectorBundle.noNetwork": "Sin red",
  "settings.connectorBundle.networkHint":
    "Solo el entorno aislado puede hacerlo cumplir. La lista es lo que dice el autor.",
  "settings.connectorBundle.env": "Variables que lee",
  "settings.connectorBundle.noEnv": "Ninguna",
  "settings.connectorBundle.envHint": "Solo los nombres. Les das valores después de instalar.",
  "settings.connectorBundle.secrets": "Secretos que necesita",
  "settings.connectorBundle.noSecrets": "Ninguno",
  "settings.connectorBundle.secretsHint":
    "Solo los nombres. El archivo no lleva ningún secreto. Después de instalar, das un valor a cada uno y se guarda en tu bóveda.",
  "settings.connectorBundle.tools": "Herramientas que el autor dice que ofrece",
  "settings.connectorBundle.toolsCount": "{n, plural, one {# herramienta} other {# herramientas}}",
  "settings.connectorBundle.toolsHint":
    "Psyche lo inicia en el entorno aislado y lista lo que realmente ofrece. Esas herramientas son las que cuentan.",
  "settings.connectorBundle.toolsUndeclared":
    "El servidor listó herramientas que el archivo no declaraba: {names}",
  "settings.connectorBundle.toolsMissing":
    "El archivo declaraba herramientas que el servidor no listó: {names}",
  "settings.connectorBundle.files": "Scripts que lo acompañan ({n})",
  "settings.connectorBundle.file": "{path} · {bytes} B",
  "settings.connectorBundle.fileBinary": "No es texto, así que no se puede mostrar aquí.",
  "settings.connectorBundle.findings": "Qué encontraron las comprobaciones",
  "settings.connectorBundle.finding.high": "Impide la instalación: {message}",
  "settings.connectorBundle.finding.warn": "Revisa: {message}",
  "settings.connectorBundle.finding.info": "{message}",
  "settings.connectorBundle.sandbox.srt":
    "La primera ejecución es en el entorno aislado. Psyche lo inicia allí para listar sus herramientas y sigue ejecutándose allí.",
  "settings.connectorBundle.sandbox.container":
    "La primera ejecución es en un contenedor de entorno aislado. Psyche lo inicia allí para listar sus herramientas y sigue ejecutándose allí.",
  "settings.connectorBundle.sandbox.none":
    "Este Mac no tiene un entorno aislado para conectores de comando, y Psyche nunca ejecuta uno fuera de él. Este conector no se puede instalar aquí. No se inició ni se guardó nada.",
  "settings.connectorBundle.blocker.scan":
    "Las comprobaciones encontraron algo que impide instalarlo. No se inició ni se guardó nada.",
  "settings.connectorBundle.blocker.probe_failed":
    "La primera ejecución, sin red y sin secretos, no pudo iniciarlo. No se guardó nada.",
  "settings.connectorBundle.signer.ownRetired":
    "Firmado con una clave tuya que reemplazaste. Ya no se trata como tuya.",
  "settings.connectorBundle.signer.retired":
    "Firmado por {name}, con una clave que fue reemplazada por una rotación que has visto. Un archivo nuevo con esa firma es sospechoso.",
  "settings.connectorBundle.carry.kept": "Valores que diste y que se conservan: {names}",
  "settings.connectorBundle.carry.cleared":
    "Valores que diste y que no se trasladan, porque cambió quien firma o el comando. Vuelve a introducirlos: {names}",
  "settings.connectorBundle.carry.vault":
    "Los secretos que guardaste antes siguen en tu bóveda, pero no se entregan a esta versión.",
  "settings.connectorBundle.reset.title": "Si el registro de conectores compartidos está dañado",
  "settings.connectorBundle.reset.hint":
    "Los conectores que vienen de un archivo permanecen desactivados mientras no se pueda leer su registro. Esto aparta el registro dañado (y restaura la última copia buena si existe); esos conectores siguen desactivados hasta que los quites o los importes de nuevo.",
  "settings.connectorBundle.reset.go": "Restablecer el registro…",
  "settings.connectorBundle.reset.confirm": "Sí, restablecerlo",
  "settings.connectorBundle.reset.done":
    "Se restableció el registro. {restored, select, true {Se restauró la última copia buena.} other {Empieza vacío.}}",
  "settings.connectorBundle.reset.failed": "No se pudo restablecer el registro: {reason}",
  "settings.connectorBundle.hash": "ID del paquete",
  "settings.connectorBundle.close": "Cerrar",
  "settings.connectorBundle.widened.title": "Pide más que la versión que tienes",
  "settings.connectorBundle.widened.hint":
    "Aprobar esta tarjeta le da todo esto. Una tarjeta para la versión más limitada no lo habría cubierto.",
  "settings.connectorBundle.widened.command": "Un comando distinto",
  "settings.connectorBundle.widened.commandValue": "Ahora {now}. Antes: {before}",
  "settings.connectorBundle.widened.env": "Más variables",
  "settings.connectorBundle.widened.secrets": "Más secretos",
  "settings.connectorBundle.widened.network": "Más red",
  "settings.connectorBundle.widened.tools": "Más herramientas, o herramientas que pueden hacer más",
  "settings.connectorBundle.widened.payload": "Scripts distintos",
  "settings.connectorBundle.widened.payloadValue": "Los archivos incluidos cambiaron",
  "settings.connectorBundle.diff": "Qué cambió",
  "settings.connectorBundle.noChanges": "No cambió nada más.",
  "settings.connectorBundle.import.title": "Conectores compartidos",
  "settings.connectorBundle.import.hint":
    "Importa un conector que alguien te envió como archivo o enlace. Ves todo lo que pide antes de que se instale nada.",
  "settings.connectorBundle.import.file": "Importar un archivo de conector",
  "settings.connectorBundle.import.linkLabel": "O pega un enlace a uno",
  "settings.connectorBundle.import.linkPlaceholder": "https://example.com/notes.psyche-connector",
  "settings.connectorBundle.import.review": "Revisar",
  "settings.connectorBundle.import.checking": "Comprobando…",
  "settings.connectorBundle.import.failed": "No se pudo importar el conector: {reason}",
  "settings.connectorBundle.import.tooBig": "Ese archivo es demasiado grande para ser un conector.",
  "settings.connectorBundle.import.denied": "{name} no se instaló.",
  "settings.connectorBundle.import.lapsed":
    "{expired, select, true {La tarjeta de {name} caducó.} other {La tarjeta de {name} ya no se aplica.}} Impórtalo de nuevo para revisarlo.",
  "settings.connectorBundle.import.added":
    "Se añadió {name}. Dale abajo los secretos que necesita y podrá usarlos.",
  "settings.connectorBundle.import.addedNoSecrets": "Se añadió {name}.",
  "settings.connectorBundle.import.addFailed": "No se pudo añadir {name}: {reason}",
  "settings.connectorBundle.import.secretsTitle": "Secretos de {name}",
  "settings.connectorBundle.share.title": "Compartir este conector",
  "settings.connectorBundle.share.hint":
    "Crea un archivo firmado con el comando, los nombres de sus variables y secretos, la red a la que llega y sus herramientas. Nunca se incluye ningún valor. Antes confirmas qué contiene.",
  "settings.connectorBundle.share.go": "Compartir…",
  "settings.connectorBundle.share.nameLabel": "Tu nombre en los conectores compartidos",
  "settings.connectorBundle.share.nameHint":
    "Todos los que importen un archivo tuyo ven este nombre. Se pide una sola vez; tu clave de firma se crea ahora.",
  "settings.connectorBundle.share.make": "Crear el archivo",
  "settings.connectorBundle.share.label": "Compartir {name}",
  "settings.connectorBundle.share.done":
    "Se guardó {file}, firmado como {author}. Solo contiene nombres: ningún valor de variable ni de secreto.",
  "settings.connectorBundle.share.failed": "No se pudo compartir el conector: {reason}",
  "settings.connectorBundle.share.unavailable":
    "Solo Psyche en el Mac que lo ejecuta puede firmar un conector.",
  "settings.skills.signer.ownRetired":
    "Firmado con una clave tuya que reemplazaste. Ya no se trata como tuya.",
  "settings.skills.signer.retired":
    "Firmado por {name}, con una clave que fue reemplazada por una rotación que has visto. Un archivo nuevo con esa firma es sospechoso.",
  "settings.skills.signer.rotated":
    "Firmado por {name}: mismo autor, clave nueva (firmada por la clave anterior). No se confía en la clave nueva hasta que confíes en ella.",
  "settings.skills.author.state.seen": "Vista, sin confianza",
  "settings.skills.author.state.trusted": "De confianza",
  "settings.skills.author.state.revoked": "Revocada",
  "settings.skills.keys.title": "Tu clave de autor y los avisos",
  "settings.skills.keys.hint":
    "La clave que firma las habilidades y los conectores que compartes. Puedes reemplazarla y publicar un aviso cuando una clave o un archivo dejen de ser de confianza.",
  "settings.skills.keys.none":
    "Todavía no has firmado nada. Tu clave se crea la primera vez que compartes una habilidad o un conector.",
  "settings.skills.keys.own": "Firmando como {name}",
  "settings.skills.keys.fingerprint": "Clave",
  "settings.skills.keys.rotate": "Reemplazar mi clave…",
  "settings.skills.keys.rotateHint":
    "Crea una clave nueva con el mismo nombre. La clave anterior firma una declaración que nombra la nueva, de modo que quienes confiaban en ti ven al mismo autor con una clave nueva. Aun así, tienen que confiar en ella por sí mismos. Antes confirmas.",
  "settings.skills.keys.rotateLabel": "Reemplazar tu clave de autor",
  "settings.skills.keys.rotated": "Tu clave fue reemplazada. La clave nueva es {key}.",
  "settings.skills.keys.rotateFailed": "No se pudo reemplazar la clave: {reason}",
  "settings.skills.keys.notice.title": "Publicar un aviso",
  "settings.skills.keys.notice.hint":
    "Un aviso es un pequeño archivo firmado. Envíalo o alójalo, y cualquiera que conozca tu clave puede importarlo para bloquear una clave o un archivo.",
  "settings.skills.keys.notice.kindKey": "Mi clave (la actual)",
  "settings.skills.keys.notice.kindBundle": "Un archivo que compartí, por su ID de paquete",
  "settings.skills.keys.notice.kind": "Qué es malo",
  "settings.skills.keys.notice.hash": "ID del paquete (sha256:…)",
  "settings.skills.keys.notice.reason": "Por qué (todos los que lo importen lo ven)",
  "settings.skills.keys.notice.make": "Crear el aviso",
  "settings.skills.keys.notice.label": "Firmar un aviso de revocación",
  "settings.skills.keys.notice.done": "Se guardó {file}. Publícalo como quieras.",
  "settings.skills.keys.notice.failed": "No se pudo crear el aviso: {reason}",
  "settings.skills.keys.import.title": "Importar un aviso de revocación",
  "settings.skills.keys.import.hint":
    "Solo se aplica si lo firma un autor que has conocido. Solo puede bloquear: nunca da confianza a nada.",
  "settings.skills.keys.import.file": "Importar un archivo de aviso",
  "settings.skills.keys.import.linkLabel": "O pega un enlace",
  "settings.skills.keys.import.linkPlaceholder": "https://example.com/revoke.psyche-notice",
  "settings.skills.keys.import.go": "Importar",
  "settings.skills.keys.import.key": "Se bloqueó la clave {key}. Motivo indicado: {reason}",
  "settings.skills.keys.import.bundle": "Se bloqueó el archivo {hash}. Motivo indicado: {reason}",
  "settings.skills.keys.import.previewKey":
    "Esto revocará la clave {key}{names, select, none {} other { (conocida como {names})}}. Motivo indicado por quien firma: {reason}",
  "settings.skills.keys.import.previewBundle":
    "Esto bloqueará el archivo {hash}. Motivo indicado por quien firma: {reason}",
  "settings.skills.keys.import.already": "Ya está en vigor.",
  "settings.skills.keys.import.apply": "Aplicarlo",
  "settings.skills.keys.import.signedBy": "Firmado por {name}.",
  "settings.skills.keys.import.failed": "No se pudo usar el aviso: {reason}",
  "web.teach.app.record": "Grabar en una app",
  "web.teach.app.recordHint":
    "Mostrar a Psyche cómo hacer algo en una app de Mac que ya permitiste",
  "web.teach.app.pickTitle": "¿En qué app grabar?",
  "web.teach.app.pickLabel": "App",
  "web.teach.app.pickHint":
    "Solo aparecen las apps que permitiste para el uso del ordenador. Abre la app primero. Las contraseñas, los números de tarjeta y los códigos nunca se graban, ni tampoco las ventanas de Psyche ni los avisos de inicio de sesión y seguridad.",
  "web.teach.app.none":
    "Ninguna app está lista para grabar. Activa el uso del ordenador en Ajustes y dale primero a una app el nivel Clic o Interactuar.",
  "web.teach.app.start": "Iniciar la grabación",
  "web.teach.app.cancelPick": "Ahora no",
  "web.teach.app.startFailed":
    "Psyche no pudo iniciar la grabación de esa app. Ábrela primero y comprueba que Psyche tiene acceso de Accesibilidad.",
  "web.teach.app.bar.title": "Grabando {app}",
  "web.teach.app.bar.body":
    "Psyche anota tus clics, tus opciones de menú y lo que escribes solo en {app}. Los campos seguros nunca se graban, no se hacen capturas de pantalla y nada sale de este Mac hasta que guardes. La barra de menús también tiene un botón Detener.",
  "web.teach.app.bar.endedLimit":
    "La grabación se detuvo en el límite de 200 pasos. Revisa lo que captó.",
  "web.teach.app.bar.endedTimeout":
    "La grabación se detuvo al llegar a su límite de tiempo. Revisa lo que captó.",
  "web.teach.app.bar.endedInterrupted":
    "La grabación terminó antes de tiempo porque se cerró la app. Revisa lo que captó.",
  "web.teach.app.stopFailed": "Psyche no pudo terminar la grabación.",
  "web.teach.app.skipped":
    "{count, plural, one {Se dejó fuera # elemento: un campo seguro o un control sin nombre con el que encontrarlo.} other {Se dejaron fuera # elementos: campos seguros o controles sin nombre con el que encontrarlos.}}",
  "web.teach.app.privacy":
    "El texto de estos pasos proviene de las ventanas y los menús de la app. Se trata como datos, nunca como instrucciones. Al guardar, se te pide aprobar la habilidad antes de que pueda ejecutarse.",
  "web.teach.app.sensitive": "No se grabó. Psyche te pedirá que hagas esta parte tú.",
  "web.teach.app.runHint":
    "Rellena el cuadro de mensaje con la habilidad. Pulsa Enviar y observa la app: cada clic y cada entrada pide aprobación como de costumbre, y se detiene y pregunta si algo no está donde estaba.",
  "web.teach.step.app.click": "En {app}, haz clic en «{name}»",
  "web.teach.step.app.clickRole": "En {app}, haz clic en {role}",
  "web.teach.step.app.menu": "En {app}, elige {path}",
  "web.teach.step.app.type": "En {app}, escribe en «{name}»",
  "web.teach.step.app.typeKept": "En {app}, escribe {value} en «{name}»",
  "web.teach.step.app.typeInput": "En {app}, escribe {input} en «{name}»",
  "web.teach.step.app.typeAsk": "En {app}, escribe en «{name}» lo que le indiques",
  "web.teach.step.app.typeSensitive": "En {app}, escribes tú mismo en «{name}»",
};
