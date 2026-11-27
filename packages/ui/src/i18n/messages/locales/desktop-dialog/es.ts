import type { Catalogue } from "../../index.ts";

/** Native dialogs and notifications (es); merged into `../es.ts`. */
export const desktopDialog: Partial<Catalogue> = {
  "desktop.dialog.notificationsOn": "Las notificaciones están activadas.",
  "desktop.dialog.anotherCopyTitle": "Ya hay otra copia de Psyche en ejecución",
  "desktop.dialog.anotherCopyDetail":
    "Se ejecuta desde {path}. Usar esta copia cambia Psyche a esta app; la otra copia se conectará entonces a esta.",
  "desktop.dialog.keepOtherCopy": "Mantener la otra copia",
  "desktop.dialog.useThisCopy": "Usar esta copia",
  "desktop.dialog.cancel": "Cancelar",
  "desktop.dialog.ok": "Aceptar",
  "desktop.dialog.shareFolderTitle": "Compartir una carpeta con Psyche",
  "desktop.dialog.share": "Compartir",
  "desktop.dialog.gatewaysFileTitle": "Psyche no puede leer sus Gateways guardados",
  "desktop.dialog.gatewaysFileDetail":
    "{problem}. Psyche se inicia en {os, select, macos {este Mac} windows {este PC} other {este equipo}} y deja el archivo tal cual, así que no se pierde ninguna identidad fijada. Corrige o elimina el archivo en la carpeta de datos de Psyche para usar el Gateway de otro equipo.",
  "desktop.dialog.stillRunningTitle": "Psyche sigue en ejecución",
  "desktop.dialog.stillRunningBody":
    "Las tareas y automatizaciones siguen en marcha. Abre Psyche desde su icono en el área de notificaciones; haz clic derecho en él para salir.",
  "desktop.dialog.manualStepsTitle": "Falta un paso para terminar de quitar Psyche",
  "desktop.dialog.uninstallTitle": "¿Desinstalar Psyche?",
  "desktop.dialog.uninstall": "Desinstalar",
  "desktop.dialog.uninstallAndDelete": "Eliminar datos y desinstalar",
  "desktop.dialog.uninstallItems":
    "{count, plural, one {# elemento se moverá} other {# elementos se moverán}} a la papelera, incluido Psyche.app.",
  "desktop.dialog.uninstallDataFolder":
    "Tu carpeta de datos {folder} también se moverá a la papelera.",
  "desktop.dialog.uninstallDataKept": "Tu carpeta de datos se conserva.",
  "desktop.dialog.uninstallKeychain": "Se eliminarán los elementos del llavero que guarda Psyche.",
  "desktop.dialog.uninstallKeychainKept":
    "Los elementos del llavero se quedan; si quieres, elimínalos en Acceso a Llaveros.",
  "desktop.dialog.stopTitle":
    "¿Detener Psyche en {os, select, macos {este Mac} windows {este PC} other {este equipo}}?",
  "desktop.dialog.stopDetail":
    "Sus automatizaciones y tareas programadas se detienen hasta que vuelvas a cambiar. Déjalo en marcha para que sigan funcionando.",
  "desktop.dialog.stopButton":
    "Detener Psyche en {os, select, macos {este Mac} windows {este PC} other {este equipo}}",
  "desktop.dialog.keepRunning": "Dejarlo en marcha",
  "desktop.dialog.forgetTitle": "¿Olvidar {name}?",
  "desktop.dialog.forgetDetail":
    "{origin}\n\nEsto elimina la clave de este equipo para ese Gateway y todo lo que Psyche guardó aquí para él. {name} seguirá mostrando este equipo hasta que alguien lo quite allí.",
  "desktop.dialog.forgetButton": "Olvidar",
  "desktop.dialog.repairTitle": "¿Volver a emparejar con {name}?",
  "desktop.dialog.repairDetail":
    "{origin}\n\nEsto olvida la identidad que Psyche fijó para él y la clave de este equipo, así que la próxima conexión fija lo que responda en esa dirección y pide emparejarse como un equipo nuevo. Hazlo solo si sabes por qué cambió su identidad.",
  "desktop.dialog.repairButton": "Volver a emparejar",
  "desktop.dialog.claimTitle": "¿Configurar el servidor de Psyche en {origin}?",
  "desktop.dialog.claimDetail":
    "Psyche comprueba que el servidor conoce el código de configuración que escribiste antes de confiar en él, y el servidor comprueba que este equipo lo conoce antes de hacerlo administrador. Continúa solo si acabas de instalar ese servidor tú mismo.",
  "desktop.dialog.setUp": "Configurar",
  "desktop.dialog.addLanTitle": "¿Es {origin} un Psyche de esta red?",
  "desktop.dialog.addLanDetail":
    "Nombre: {name}\n\nUn Psyche de esta red usa su propio certificado, que Psyche fija en lugar de confiar en el del sistema: comprueba el certificado y la clave del Gateway en la primera conexión y rechaza cualquier otro después. Elige «Https simple» solo para un servidor con un certificado normal (por ejemplo, un proxy inverso con tu propia CA). No se comparte nada hasta que su dueño apruebe este equipo allí.",
  "desktop.dialog.psycheOnNetwork": "Psyche de esta red",
  "desktop.dialog.plainHttps": "Https simple",
  "desktop.dialog.addLinkTitleLan": "¿Conectar Psyche a {origin} en esta red?",
  "desktop.dialog.addLinkTitle": "¿Conectar Psyche a {origin}?",
  "desktop.dialog.addLinkDetail":
    "{external, select, yes {Otra app o una web abrió este enlace; no lo pegaste tú. Continúa solo si lo creaste tú mismo en {os, select, macos {el Mac} windows {el PC} other {el equipo}} que ejecuta Psyche.\n\n} other {}}Psyche solo se conectará si ese Gateway demuestra esta identidad:\n{fingerprint}\n\n{lan, select, yes {Usa su propio certificado, no uno en el que confíe el sistema. Psyche lo mantiene fijo al que indica este enlace ({pin}…) antes de enviar nada, y rechaza cualquier otro. Continúa solo si el enlace viene de tu propio {os, select, macos {Mac} windows {PC} other {equipo}} en esta red.\n\n} other {}}El código de un solo uso del enlace permite que ese Gateway apruebe este equipo sin volver a preguntar, con el acceso que eligió su dueño al crearlo.",
  "desktop.dialog.addDetailKey":
    "Nombre: {name}\nClave que anunció: {key}…\n\nEste equipo pedirá a ese Gateway emparejarse. No se comparte nada hasta que su dueño apruebe este equipo allí, y Psyche fija la identidad del Gateway en la primera conexión.",
  "desktop.dialog.addDetailPlain":
    "Nombre: {name}\n\nEste equipo pedirá a ese Gateway emparejarse. No se comparte nada hasta que su dueño apruebe este equipo allí, y Psyche fija la identidad del Gateway en la primera conexión.",
  "desktop.dialog.addGatewayButton": "Añadir Gateway",
};
