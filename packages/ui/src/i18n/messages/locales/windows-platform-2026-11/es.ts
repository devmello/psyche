import type { Catalogue } from "../../index.ts";

/** Windows variants of the sandbox PC, voice keys and platform terms, and Mac wording (es); merged into `../es.ts`. */
export const windowsPlatform202611: Partial<Catalogue> = {
  "blocks.details.runsNoHostSandbox":
    "en este equipo, sin entorno aislado: aquí no hay ninguno para los comandos",
  "blocks.execHost.noHostSandbox":
    "En este equipo no hay entorno aislado para los comandos, así que este comando solo puede ejecutarse sin uno. Escribe {word} para ejecutarlo esta vez.",
  "blocks.execHost.mustTypeOnly": "Escribe {word} para permitirlo.",
  "settings.uninstall.stopSandboxPc":
    "Se elimina el servicio del PC de entorno aislado. Windows pide la aprobación de un administrador una vez.",
  "settings.computerUse.tcc.microphone.name": "Micrófono",
  "settings.computerUse.tcc.microphone.why":
    "permite que Psyche te oiga para el dictado y las notas de reuniones",
  "settings.sandbox.restart.reopen": "Cierra Psyche y vuelve a abrirlo.",
  "settings.sandbox.pc.title": "Activar el PC de entorno aislado",
  "settings.sandbox.pc.body":
    "srt, el entorno aislado ligero de Psyche para los comandos, no funciona en Windows. Aquí, los scripts, los servidores de comandos y los conectores que crea Psyche se ejecutan en el Privacidad y seguridad → Uso del ordenador → Modo VM: un pequeño equipo Linux propio, sin acceso a tus archivos. Actívalo en Ajustes → PC de entorno aislado y vuelve a comprobarlo.",
  "settings.sandbox.pc.notReady.title": "El PC de entorno aislado aún no está listo",
  "settings.sandbox.pc.notReady.body":
    "Está activado, pero todavía no se está ejecutando o el Psyche que contiene está desactualizado. Inícialo o actualízalo en Ajustes → Privacidad y seguridad → Uso del ordenador → Modo VM y vuelve a comprobarlo.",
  "settings.sandbox.pc.ready":
    "El PC de entorno aislado está activado: los scripts, servidores de comandos y conectores que crea Psyche se ejecutan en él.",
  "settings.sandbox.pc.open": "Abrir los ajustes del PC de entorno aislado",
  "settings.sandbox.pc.where":
    "Está en Ajustes → Privacidad y seguridad → Uso del ordenador → Modo VM.",
  "settings.devices.platform.windows": "PC con Windows",
  "settings.devices.nodeKind.winHelper": "Helper de Windows",
  "settings.devices.thisPcAdmin":
    "Este PC es el dispositivo de administración. Otro dispositivo de administración puede revocarlo aquí.",
  "settings.devices.presenceKey.windowsHello":
    "Clave de Windows Hello ({algorithm}), según informa el helper",
  "settings.devices.presenceKey.windowsHelloNoAlgorithm":
    "Clave de Windows Hello, según informa el helper",
  "settings.shortcut.reserved.windowsKey": "Windows (atajos con la tecla de Windows)",
  "settings.shortcut.reserved.windowMenu": "el menú de ventanas",
  "settings.shortcut.reserved.closeApp": "cerrar apps",
  "settings.shortcut.reserved.taskManager": "el Administrador de tareas",
  "settings.shortcut.reserved.startMenu": "el menú Inicio",
  "settings.shortcut.reserved.securityScreen": "la pantalla de seguridad de Windows",
  "settings.shortcut.key.Super": "Tecla de Windows",
  "settings.shortcut.useDefault": "Usar el predeterminado",
  "settings.quickEntry.title": "Entrada rápida",
  "settings.key.quickEntry.shortcut": "Atajo",
  "settings.quickEntry.shortcutHint":
    "Abre el chat emergente desde cualquier app. Salvo que elijas otras teclas, Psyche usa {keys}, o {fallback} cuando otra app la tiene ocupada.",
  "settings.voice.key.rightCtrl": "Ctrl derecho",
  "settings.voice.key.rightAlt": "Alt derecho",
  "settings.voice.key.rightShift": "Mayús derecha",
  "settings.voice.key.rightWin": "Tecla de Windows derecha",
  "settings.voice.key.capsLock": "Bloq Mayús",
  "settings.voice.key.scrollLock": "Bloq Despl",
  "settings.voice.key.pause": "Pausa",
  "settings.voice.key.menu": "Tecla Menú",
  "settings.voice.key.insert": "Insert",
  "settings.voice.key.numLock": "Bloq Num",
  "settings.voice.key.other": "Otra tecla",
  "settings.voice.key.press": "Pulsa una tecla",
  "settings.voice.key.pressNow": "Pulsa la tecla para mantenerla…",
  "settings.voice.key.cantUse":
    "Esa tecla escribe texto, así que no se puede mantener para hablar. Prueba con Ctrl derecho, Bloq Mayús, Pausa, la tecla Menú o F13 a F24.",
  "settings.voice.key.capsLockHint":
    "Bloq Mayús conserva su estado de activado o desactivado: mantenerla para hablar no lo cambia, y un toque rápido sí lo alterna.",
  "settings.voice.key.altGrWarning":
    "Con tu distribución de teclado, Alt derecho es AltGr, que escribe caracteres como @ o €. Mantenerlo para hablar puede interferir al escribirlos; Ctrl derecho es más seguro.",
  "settings.voice.access.windowsWhy":
    "observa la tecla que mantienes y escribe en la app activa. Windows no necesita ningún permiso para ello; las apps que se ejecutan como administrador no reciben el texto dictado.",
  "settings.voice.model.title": "Modelo de voz",
  "settings.voice.model.usingHelper":
    "El dictado usa el reconocimiento de voz del helper. El modelo de voz transcribe mejor y se ejecuta en este Mac.",
  "settings.voice.model.download": "Descarga el modelo de voz ({mb} MB) para un mejor dictado",
  "settings.voice.model.downloadHint":
    "Una descarga única desde el proyecto whisper.cpp, comprobada antes de usarla. El audio nunca sale de este Mac.",
  "settings.voice.model.downloading": "Descargando el modelo de voz: {received} de {total} MB",
  "settings.voice.model.ready": "Whisper ({model}) en este Mac",
  "settings.voice.model.readyHint":
    "El dictado y las grabaciones se transcriben aquí; el audio nunca sale del Mac.",
  "settings.voice.model.readyNotFirst":
    "Instalado. Tu orden de motores pone otro motor primero, así que el dictado no lo usa ahora.",
  "settings.voice.model.failed": "La descarga falló: {reason}",
  "settings.voice.model.retry": "Intentar de nuevo",
  "settings.voice.model.vcredist":
    "El modelo de voz necesita Microsoft Visual C++ Redistributable. Instálalo y vuelve a dictar.",
  "settings.voice.model.crashed":
    "El motor de voz se detuvo inesperadamente; el dictado usa el helper hasta que vuelva a arrancar.",
  "settings.sandboxPc.title": "Activar el PC de entorno aislado",
  "settings.sandboxPc.explain":
    "{persona} tiene un pequeño PC Linux privado que funciona dentro de Windows. Las tareas se ejecutan allí en lugar de en tu PC, y solo ven las carpetas que compartes.",
  "settings.sandboxPc.oneTime":
    "Configuración única: Windows pide la aprobación de un administrador una vez, para añadir un servicio en segundo plano que ejecuta el PC. Después, Psyche descarga la imagen del PC ({download}, {disk} en disco). Nada más necesita un administrador.",
  "settings.sandboxPc.oneTimeNoSize":
    "Configuración única: Windows pide la aprobación de un administrador una vez, para añadir un servicio en segundo plano que ejecuta el PC. Después, Psyche descarga la imagen del PC. Nada más necesita un administrador.",
  "settings.sandboxPc.turnOn": "Activar el PC de entorno aislado",
  "settings.sandboxPc.cancelDownload": "Cancelar la descarga",
  "settings.sandboxPc.waitingAdmin": "Esperando la solicitud del administrador…",
  "settings.sandboxPc.restarting": "Terminando la configuración…",
  "settings.sandboxPc.downloading": "Descargando la imagen del PC: {received} de {total}",
  "settings.sandboxPc.progressLabel": "Descarga de la imagen del PC",
  "settings.sandboxPc.ready": "Configurado",
  "settings.sandboxPc.readyText": "El PC de entorno aislado está configurado. Versión {version}.",
  "settings.sandboxPc.unsupported": "El PC de entorno aislado no está disponible aquí: {reason}.",
  "settings.sandboxPc.failed": "No se pudo activar el PC de entorno aislado: {reason}",
  "settings.sandboxPc.failedDid": "No se cambió nada más. Puedes intentarlo de nuevo.",
  "settings.sandboxPc.gb": "{value, number} GB",
  "settings.sandboxPc.mb": "{value, number} MB",
  "settings.sandboxPc.loadLabel": "PC de entorno aislado",
  "settings.sandboxPc.onboarding": "PC de entorno aislado",
  "settings.sandboxPc.onboardingHint":
    "Opcional: un PC Linux privado para tareas que no deberían tocar tus archivos. Puedes configurarlo más tarde en los ajustes.",
  "settings.sandboxPc.update.title": "Actualizar el servicio del PC de entorno aislado",
  "settings.sandboxPc.update.explainCompatible":
    "Esta versión de Psyche incluye un servicio de PC de entorno aislado más nuevo que el instalado. El PC de entorno aislado sigue funcionando como hasta ahora.",
  "settings.sandboxPc.update.explainRequired":
    "Esta versión de Psyche no puede usar el servicio de PC de entorno aislado instalado. El PC de entorno aislado seguirá apagado hasta que lo actualices.",
  "settings.sandboxPc.update.available": "Actualización disponible",
  "settings.sandboxPc.update.required": "Actualización necesaria",
  "settings.sandboxPc.update.versions":
    "Instalada: {installed}. Esta versión de Psyche: {bundled}.",
  "settings.sandboxPc.update.oneStep":
    "Windows pide la aprobación de un administrador una vez. Un PC de entorno aislado en marcha se detiene mientras se reemplaza el servicio.",
  "settings.sandboxPc.update.button": "Actualizar el servicio del PC de entorno aislado",
  "settings.sandboxPc.update.failed":
    "No se actualizó el servicio del PC de entorno aislado: {reason}",
  "settings.sandboxPc.update.failedDid": "No se cambió nada más. Puedes intentarlo de nuevo.",
  "settings.sandboxPc.controls.title": "El PC de entorno aislado",
  "settings.sandboxPc.controls.hint": "Créalo una vez y después inícialo y deténlo desde aquí.",
  "settings.sandboxPc.controls.create": "Crear el PC de entorno aislado",
  "settings.sandboxPc.controls.start": "Iniciar",
  "settings.sandboxPc.controls.stop": "Detener",
  "settings.sandboxPc.controls.resume": "Reanudar",
  "settings.sandboxPc.controls.working": "Trabajando…",
  "settings.sandboxPc.controls.helperOffline":
    "El helper de Windows no se está ejecutando o aún no tiene el PC de entorno aislado, así que no se puede controlar. Reinicia el helper en Ajustes → Dispositivos.",
  "settings.sandboxPc.controls.failed": "No funcionó: {reason}",
  "settings.sandboxPc.controls.waitForImage": "Termina antes de activarlo arriba.",
  "settings.sandboxPc.snapshots.title": "Instantáneas",
  "settings.sandboxPc.snapshots.hint":
    "Guarda el disco del PC de entorno aislado para volver a él más tarde. Debe estar detenido para guardar o restaurar.",
  "settings.sandboxPc.snapshots.none": "Todavía no hay instantáneas.",
  "settings.sandboxPc.snapshots.save": "Guardar una instantánea",
  "settings.sandboxPc.snapshots.saveFresh": "Guardar como PC nuevo",
  "settings.sandboxPc.snapshots.reset": "Volver al PC nuevo",
  "settings.sandboxPc.snapshots.restore": "Restaurar",
  "settings.sandboxPc.snapshots.delete": "Eliminar",
  "settings.sandboxPc.snapshots.fresh": "PC nuevo",
  "settings.sandboxPc.snapshots.item": "{label}, {when}",
  "settings.sandboxPc.snapshots.stopFirst": "Detén primero el PC de entorno aislado.",
  "onboarding.connectors.windowsHint":
    "En Windows, {name} lee tu correo, tu calendario y tus contactos a través de una cuenta de Microsoft, Google o IMAP.",
  "web.about.windowsArm": "Arm64",
  "web.about.windowsX64": "x64",
  "web.about.windowsBuild": "compilación {build}",
  "platform.term.os": "macOS",
  "platform.term.device": "Mac",
  "platform.term.thisDevice": "Este Mac",
  "platform.term.thisDeviceLower": "este Mac",
  "platform.term.presence": "Touch ID",
  "platform.term.secretStore": "Llavero",
  "platform.term.systemSettings": "Ajustes del sistema",
  "platform.term.fileManager": "Finder",
  "platform.term.trayArea": "barra de menús",
  "platform.term.taskbar": "Dock",
  "platform.term.systemSearch": "Spotlight",
  "platform.term.helper": "helper de Mac",
  "platform.term.terminal": "Terminal",
  "platform.term.alt": "Opción",
  "platform.term.mod": "Comando",
  "platform.macOnly": "Disponible en macOS",
  "platform.macOnlyHint": "{name} necesita un Mac. Psyche en macOS puede usarlo.",
  "platform.windows.access.title": "Acceso de Windows",
  "platform.windows.access.hint": "Lo que Windows permite hacer a Psyche y lo que te pide.",
  "platform.windows.access.noPermission": "No necesita permiso",
  "platform.windows.access.uiAutomation.name": "Usar apps",
  "platform.windows.access.uiAutomation.why":
    "{persona} lee y usa las ventanas de las apps a través de la automatización de la interfaz de Windows. Windows no le permite controlar las apps que se ejecutan como administrador.",
  "platform.windows.access.screen.name": "Captura de pantalla",
  "platform.windows.access.screen.why":
    "Windows no necesita permiso para capturar la pantalla. Las ventanas de Psyche y los campos de contraseña quedan ocultos en las capturas.",
  "platform.windows.access.microphone.name": "Micrófono",
  "platform.windows.access.microphone.why":
    "Para el dictado y las notas de reuniones. Windows lo pide en Configuración → Privacidad y seguridad → Micrófono, con «Permitir que las aplicaciones de escritorio accedan al micrófono» activado.",
  "platform.windows.access.openSettings": "Abrir ajustes",
  "platform.windows.access.openSettingsFor": "Abrir la configuración de Windows para {name}",
  "platform.windows.access.state.granted": "Activado",
  "platform.windows.access.state.denied": "Desactivado en la configuración de Windows",
  "platform.windows.access.state.not_determined": "Aún no comprobado",
  "platform.helper.restart": "Reiniciar el helper",
  "platform.helper.restarting": "Reiniciando…",
  "platform.helper.restartFailed": "El helper no arrancó ({reason}).",
};
