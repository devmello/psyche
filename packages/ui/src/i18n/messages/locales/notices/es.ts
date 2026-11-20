import type { Catalogue } from "../../index.ts";

/** Notices the Gateway authors (es); merged into `../es.ts`. */
export const notices: Partial<Catalogue> = {
  "notice.security.changed.title": "Psyche deshizo un cambio de seguridad hecho fuera de la app",
  "notice.security.changed.body":
    "Un programa de este Mac cambió {count, plural, =1 {# registro de seguridad} other {# registros de seguridad}} (dispositivos, claves, permisos o ajustes) sin pasar por Psyche{times, plural, =0 {} =1 {} other {, # veces hasta ahora}}. Psyche los restauró. Si no fuiste tú, revisa el Mac por si hay software no deseado.",
  "notice.security.untrusted.title": "Psyche no puede fiarse de sus registros de seguridad",
  "notice.security.untrusted.body":
    "La comprobación de los registros de seguridad de Psyche falló, así que los cambios de seguridad, los dispositivos nuevos y las aprobaciones con Touch ID están bloqueados. Revisa tus dispositivos y ejecuta `psyched security reseal` en el Mac (se aplica a las 24 horas).",
  "notice.security.firstSeal.title": "Psyche ahora comprueba sus registros de seguridad",
  "notice.security.firstSeal.body":
    "Psyche selló {devices, plural, =1 {# dispositivo vinculado} other {# dispositivos vinculados}} y sus ajustes de seguridad. A partir de ahora, un cambio hecho fuera de Psyche se deshace y se muestra aquí. Revisa tus dispositivos una vez.",
  "notice.security.resealed.title":
    "{restored, select, yes {Registros de seguridad sellados tras una restauración} other {Registros de seguridad sellados de nuevo}}",
  "notice.security.resealed.body":
    "{restored, select, yes {Psyche arrancó desde una copia restaurada y selló sus registros de seguridad tal como están. Si no restauraste ninguna copia, revisa tus dispositivos.} other {Psyche selló de nuevo sus registros de seguridad tras el periodo de espera.}}",
  "notice.security.firstAdmin.title":
    "Un comando de este Mac creó el primer dispositivo administrador",
  "notice.security.firstAdmin.body":
    "{device}{key, select, none {} other { (clave {key})}} pasó a ser el primer dispositivo administrador {via, select, desktop {desde la app de Psyche} other {mediante `psyched`}} en este Mac. Si no fuiste tú, revócalo en Ajustes → Dispositivos.",
  "notice.security.recovery.title":
    "{state, select, requested {Un comando de este Mac pidió un cambio de seguridad} applied {Se aplicó un cambio de seguridad de este Mac} cancelled {Se canceló un cambio de seguridad de este Mac} other {No se pudo aplicar un cambio de seguridad de este Mac}}",
  "notice.security.recovery.body":
    "{op, select, approve {Aprobar el dispositivo {device}{key, select, none {} other { (clave {key})}} con {scopes}.} grant {Dar a {device}{key, select, none {} other { (clave {key})}} {scopes}.} presence {Desactivar el requisito de Touch ID y clave de acceso para los cambios de seguridad hasta que se registre una clave nueva.} seal {Aceptar los registros de seguridad actuales tal como están.} other {Un cambio de seguridad.}}{state, select, requested { Se aplica {when, select, none {en 24 horas} other {el {when}}} salvo que lo canceles en Psyche.} failed {{reason, select, none {} other { {reason}}}} other {}}",
  "notice.browser.chrome.title": "Psyche está controlando tu Chrome",
  "notice.browser.chrome.body":
    "Una tarea usa el perfil de Chrome de Psyche, donde tienes la sesión iniciada. El título de su ventana dice “Psyche is driving this window”. Se cierra cuando termina la tarea; también puedes salir de Chrome.",
  "notice.browser.takeover.title": "Psyche te necesita en el navegador",
  "notice.browser.takeover.body":
    "En {host}, el agente pregunta: {reason}. Toma el control en el panel del navegador y luego devuélvelo.",
  "notice.connector.consent.title": "Termina de conectar Google",
  "notice.connector.consent.body":
    "Abre este enlace en el ordenador donde se ejecuta Psyche para dar acceso: {url}",
  "notice.connector.changed.title": "Cambió una conexión",
  "notice.connector.changed.body":
    "{reason, select, account_changed {Un conector ahora inicia sesión en otra cuenta. Se detuvo el trabajo ligado a la cuenta anterior.} disconnected {Se desconectó un conector. Se detuvo el trabajo que lo necesitaba.} scope_changed {Un conector ahora es de solo lectura. Se detuvieron las acciones pendientes a través de él.} other {Se revocó el acceso de un conector. Inicia sesión de nuevo para seguir usándolo.}}",
  "notice.connector.reconnect.title": "Hay que volver a conectar",
  "notice.connector.reconnect.body":
    "Un conector perdió el acceso y necesitas iniciar sesión de nuevo.",
  "notice.attention.paused.title": "Una tarea te está esperando",
  "notice.attention.paused.body":
    "En pausa antes de {tool} en una app o sitio sensible hasta que vuelvas a Psyche.",
  "notice.apiKey.changed.title":
    "{kind, select, brave {La clave de {provider} se {action, select, changed {cambió} other {eliminó}}} other {La clave de API de {provider} se {action, select, changed {cambió} other {eliminó}}}}",
  "notice.apiKey.changed.body":
    '{action, select, changed {Cambiada} other {Eliminada}} desde {device, select, none {un dispositivo} other {"{device}" ({platform}{paired, select, none {} other {, vinculado el {paired}}})}}. Si no fuiste tú, revoca el dispositivo en Ajustes → Dispositivos.',
  "notice.approvals.digest.title":
    "{count, plural, =1 {# acción de tus automatizaciones está esperando} other {# acciones de tus automatizaciones están esperando}}",
  "notice.approvals.digest.body": "Abre Aprobaciones para aprobarlas o rechazarlas",
  "notice.approvals.resumeMissed.title":
    "{automation, select, none {No se hizo una acción aprobada de una automatización} other {{automation}: no se hizo la acción aprobada}}",
  "notice.approvals.resumeMissed.body":
    "{why, select, expired {La aprobación caducó antes de que la automatización llegara a la acción, así que no se hizo nada. Si aún la necesita, volverá a preguntar.} paused {La automatización está en pausa o se eliminó, así que no se volvió a ejecutar y no se hizo nada. Si aún la necesita, volverá a preguntar.} restart {Psyche se reinició antes de que la automatización pudiera volver a ejecutarse, así que no se hizo nada. Si aún la necesita, volverá a preguntar.} restart_kept {Psyche se reinició antes de que la automatización pudiera volver a ejecutarse. El permiso que diste se mantiene, así que su próxima ejecución hará esto sin preguntar. Para retirarlo, revócalo en Permisos permanentes, en Aprobaciones.} failed {La automatización volvió a ejecutar la acción, pero falló. Consulta Actividad para ver qué salió mal. Si aún la necesita, volverá a preguntar.} failed_kept {La automatización volvió a ejecutar la acción, pero falló. Consulta Actividad para ver qué salió mal. El permiso que diste se mantiene, así que su próxima ejecución lo volverá a intentar sin preguntar. Para retirarlo, revócalo en Permisos permanentes, en Aprobaciones.} unknown {La automatización volvió a ejecutar la acción, pero Psyche no puede saber si funcionó. Consulta Actividad para comprobarlo.} not_reached_kept {La automatización se volvió a ejecutar pero no llegó a la misma acción, así que no se hizo nada. El permiso que diste se mantiene, así que su próxima ejecución hará esto sin preguntar. Para retirarlo, revócalo en Permisos permanentes, en Aprobaciones.} other {La automatización se volvió a ejecutar pero no llegó a la misma acción, así que no se hizo nada. Si aún la necesita, volverá a preguntar.}}",
  "notice.specialist.result.title":
    "{outcome, select, done {{who} terminó {title}} partial {{who} se detuvo pronto en {title}} cancelled {{who} se detuvo en {title}} other {{who} no pudo terminar {title}}}",
  "notice.specialist.result.body":
    "{outcome, select, done {Listo} partial {Parcial} cancelled {Cancelado} other {Fallido}}{findings, plural, =0 {} one { · # hallazgo} other { · # hallazgos}}{cost, select, none {} other { · {cost}}} · {minutes, plural, =0 {menos de 1 min} other {# min}}",
  "notice.mcp.changed.title": "El servidor MCP {server} cambió sus herramientas",
  "notice.mcp.suspicious.title":
    "El servidor MCP {server} tiene descripciones de herramientas sospechosas",
  "notice.mcp.review.body": "Revísalo antes de usar este servidor: {details}",
  "notice.security.tightened.title":
    "Se reforzaron los ajustes de seguridad desde {device, select, none {un dispositivo} other {{device}}}",
  "notice.security.tightened.body":
    "Esto solo redujo lo que Psyche puede hacer, así que no hizo falta aprobación. Si no fuiste tú, revoca el dispositivo en Ajustes → Dispositivos.",
  "notice.codeRun.held.title":
    "Psyche retuvo configuración de inicio de una ejecución de código en {repo}",
  "notice.codeRun.held.body":
    "Un comando en el sandbox creó {paths}. Las apps o tu próximo comando podrían ejecutar código desde ahí, así que Psyche lo apartó sin borrarlo. Si lo creaste tú o tus herramientas, toca Conservar.",
  "notice.codeRun.changed.title":
    "La configuración de inicio cambió durante una ejecución de código en {repo}",
  "notice.codeRun.changed.body":
    "{paths} cambió mientras un comando se ejecutaba en el sandbox. Si no fuiste tú ni tu editor, revísalo antes de abrir la carpeta.",
  "notice.codeRun.partial.title": "{repo} es demasiado grande para revisarlo entero",
  "notice.codeRun.partial.body":
    "Psyche solo revisó las carpetas superiores en busca de configuración de inicio creada por ejecuciones de código.",
  "notice.codeRun.recreated.title": "El sandbox de {repo} se volvió a crear",
  "notice.codeRun.recreated.body":
    "Sus carpetas de solo lectura cambiaron, así que los servidores en marcha y lo instalado fuera del repositorio ya no están. Vuelve a iniciar lo que necesites.",
  "notice.action.keepIt": "Conservar",
  "notice.codeRun.incident.title":
    "Psyche retuvo algo que quizá no venga de una ejecución de código en {repo}",
  "notice.codeRun.incident.body":
    "Mientras se apartaba {paths}, cambió una carpeta del camino, así que lo movido puede venir de otro sitio. Está guardado en {place}. Revísalo antes de tocar Conservar, que lo pone en {paths} dentro de {repo}.",
  "notice.codeRun.unmoved.title":
    "La configuración de inicio de una ejecución de código en {repo} sigue en su sitio",
  "notice.codeRun.unmoved.body":
    "Un comando en el sandbox creó {paths} y Psyche no pudo apartarlo, así que no está retenido. Las apps o tu próximo comando podrían ejecutar código desde ahí. Revísalo o bórralo antes de abrir la carpeta o ejecutar algo en ella.",
  "notice.machine.added.title": "{name} se añadió como un ordenador que Psyche puede usar",
  "notice.machine.added.body":
    "Psyche puede usar su pantalla, aplicaciones, shell y archivos, y cada acción allí te pide permiso antes. Si no lo añadiste tú, quítalo en Ajustes → Dispositivos.",
};
