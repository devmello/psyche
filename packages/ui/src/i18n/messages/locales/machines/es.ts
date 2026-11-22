import type { Catalogue } from "../../index.ts";

/** Computers Psyche can use (es); merged into `../es.ts`. */
export const machines: Partial<Catalogue> = {
  "machines.title": "Ordenadores que Psyche puede usar",
  "machines.description":
    "Ordenadores Linux que has vinculado para que Psyche use allí apps, comandos y archivos mientras sigues usando este.",
  "machines.empty":
    "Dale a Psyche un ordenador Linux para trabajar, de modo que use allí apps, comandos y archivos mientras sigues usando este.",
  "machines.add": "Añadir un ordenador Linux",
  "machines.add.description":
    "Psyche trabaja en ese ordenador mientras sigues usando este. Las acciones allí siguen tus ajustes de aprobación.",
  "machines.add.account": "¿Qué cuenta debe usar Psyche allí?",
  "machines.add.account.own": "Tu cuenta (recomendado)",
  "machines.add.account.ownHint":
    "Psyche puede usar allí tus archivos, apps e inicios de sesión, igual que tú. Nunca obtiene root.",
  "machines.add.account.dedicated": "Una cuenta psyche aparte",
  "machines.add.account.dedicatedHint":
    "Psyche solo ve los archivos y apps de esa cuenta. No tiene sudo ni contraseña.",
  "machines.add.needsNetwork":
    "Otros ordenadores aún no pueden llegar a este. Activa primero el acceso remoto o el acceso por red local en Ajustes → Servidor y acceso remoto.",
  "machines.add.make": "Mostrar los comandos",
  "machines.add.again": "Crear comandos nuevos",
  "machines.add.commands": "Comandos para el ordenador Linux",
  "machines.add.installStep": "1. En el ordenador Linux, instala el asistente",
  "machines.add.pairStep": "2. Inicia allí la vinculación",
  "machines.add.expires": "El enlace funciona una vez y caduca {when}.",
  "machines.add.waiting": "Esperando a que el ordenador se vincule…",
  "machines.add.paired": "{name} está vinculado. Psyche ya puede usarlo.",
  "machines.add.pairedToast": "Se añadió {name}",
  "machines.add.done": "Listo",
  "machines.copy": "Copiar",
  "machines.status.online": "En línea",
  "machines.status.offline": "Sin conexión",
  "machines.status.degraded": "Necesita atención",
  "machines.display.headless": "Pantalla privada",
  "machines.display.desktopSession": "Su propio escritorio",
  "machines.display.container": "Contenedor",
  "machines.thisComputer": "Este ordenador",
  "machines.watch": "Ver",
  "machines.watchNamed": "Ver {name}",
  "machines.apps": "Acceso a apps",
  "machines.appsNamed": "Acceso a apps en {name}",
  "machines.folders": "Carpetas",
  "machines.foldersNamed": "Carpetas en {name}",
  "machines.rename.action": "Cambiar nombre",
  "machines.rename.named": "Cambiar el nombre de {name}",
  "machines.rename.label": "Nuevo nombre para {name}",
  "machines.rename.save": "Guardar",
  "machines.rename.cancel": "Cancelar",
  "machines.remove": "Quitar",
  "machines.removeTitle": "¿Quitar {name}?",
  "machines.removeDescription":
    "Psyche deja de usar {name} de inmediato y se revoca su vinculación. Para volver a usarlo, vincúlalo de nuevo.",
  "machines.err.nameTaken": "Otro ordenador ya tiene ese nombre, o está reservado. Elige otro.",
  "machines.err.nameInvalid":
    "No se puede usar ese nombre. Usa letras, números y signos normales, hasta 64 caracteres, y no mezcles letras parecidas.",
  "machines.err.forbidden":
    "Cambiar el nombre requiere un dispositivo administrador. Inténtalo desde uno.",
  "machines.err.failed": "No funcionó ({reason}). No se cambió nada.",
  "machines.account.own":
    "Se ejecuta con tu propia cuenta en {name}. Psyche puede usar allí tus archivos, apps e inicios de sesión, igual que tú. Si alguna vez comprometieran a tu Psyche, un atacante también podría, salvo con root, que Psyche nunca obtiene.",
  "machines.account.dedicated":
    "Se ejecuta con una cuenta aparte en {name}. Psyche solo ve los archivos y apps de esa cuenta.",
  "machines.account.useSeparate": "Usar una cuenta aparte…",
  "machines.account.useSeparateHint":
    "En {name}, vuelve a ejecutar el instalador con la opción de cuenta aparte y luego vincúlalo de nuevo:",
  "machines.shell.contained": "Los comandos se ejecutan en un shell aislado",
  "machines.shell.full": "Los comandos se ejecutan en el shell completo de la cuenta",
  "machines.shell.off": "Los comandos están desactivados",
  "machines.limits.folders":
    "{count, plural, =0 {Ninguna carpeta concedida} one {# carpeta concedida} other {# carpetas concedidas}}",
  "machines.helperVersion": "Asistente {version}",
  "machines.helperVersionUnknown": "Versión del asistente desconocida",
  "machines.update": "Hay un asistente más reciente. Actualiza el asistente en {name}:",
  "machines.warnings": "Avisos para {name}",
  "machines.warn.fullShell":
    "Shell completo de la cuenta. Los comandos no están aislados, así que llegan a todo lo que llega esta cuenta.",
  "machines.warn.userLimits":
    "Los límites son del usuario. Cualquier programa que se ejecute con esta cuenta puede cambiar lo que Psyche puede hacer en {name}.",
  "machines.warn.sudo":
    "Esta cuenta tiene sudo sin contraseña. Psyche no puede usar sudo aquí, pero otros programas que ejecutes con esta cuenta sí.",
  "machines.paired": "Vinculado {when}",
  "machines.line": "En «{name}» · Linux · {place}",
  "machines.place.screen": "pantalla privada",
  "machines.place.desktop": "su escritorio",
  "machines.place.command": "comando",
  "machines.place.files": "archivos",
  "machines.step.on": "{label} en {name}",
  "machines.picker.title": "Ordenadores",
  "machines.picker.description":
    "Elige para qué ordenador son estos ajustes y dónde trabaja Psyche cuando no estás mirando uno concreto.",
  "machines.picker.show": "Mostrar el acceso a apps de",
  "machines.picker.default": "Ordenador predeterminado para el trabajo en segundo plano",
  "machines.picker.defaultHint":
    "Las tareas y automatizaciones se ejecutan allí salvo que nombren un ordenador. Elige un ordenador Linux para que Psyche trabaje allí mientras tú trabajas aquí.",
  "machines.picker.appsOn": "Apps en {name}",
  "machines.picker.appsHint":
    "Psyche las sincroniza con {name} y nunca va más allá de los límites propios de ese ordenador.",
  "machines.picker.noApps":
    "Psyche aún no ha visto apps en {name}. Aparecerán aquí cuando las vea.",
  "machines.picker.offline": "{name} está sin conexión. Los cambios llegan cuando se reconecte.",
  "computerWatch.titleMachine": "{name} · pantalla privada",
  "computerWatch.machineOffline": "No se puede llegar a {name}. Reintentando…",
  "computerWatch.empty.bodyMachine":
    "Cuando el agente necesite una pantalla en {name}, podrás verla aquí.",
  "notice.machine.working.title": "Psyche está trabajando en {name}",
  "notice.machine.working.body":
    "Está usando la pantalla, las apps o los archivos de ese ordenador. Míralo en Ajustes → Dispositivos.",
  "notice.machine.offline.title": "{name} se desconectó",
  "notice.machine.offline.body":
    "Psyche no puede usarlo hasta que se reconecte. Las tareas que lo necesitan esperan por ti.",
  "machines.add.linkStep": "3. Cuando pida el enlace, pega este",
  "machines.add.installSource":
    "Obtén el paquete del asistente en {url}, descomprímelo y ejecuta esto en el ordenador Linux.",
  "machines.reports": "{name} informa:",
  "computerWatch.machineLoading": "Cargando ordenador…",
  "computerWatch.machineMissing": "Ese ordenador no está disponible.",
  "settings.key.computerUse.defaultMachine":
    "Ordenador predeterminado para el trabajo en segundo plano",
  "settings.key.computerUse.machineApps": "Acceso a apps en un ordenador Linux",
};
