import type { Catalogue } from "../../index.ts";

/** keep-awake and retry strings (es); merged into `../es.ts`. */
export const keepAwake: Partial<Catalogue> = {
  "settings.daily.group.keepAwake": "Mantener este equipo activo",
  "settings.daily.keepAwake.hint":
    "Mientras se ejecuta una tarea programada, este equipo no se suspende hasta que termine. La pantalla sí puede apagarse.",
  "settings.key.scheduled.keepAwake":
    "Mantener este equipo activo mientras se ejecutan tareas programadas",
  "scheduled.history.retryingAt": "Reintento a las {time}",
  "scheduled.history.retry": "Reintento {n} de 3",
  "scheduled.history.failedAfterRetries": "Falló tras {n} reintentos",
  "scheduled.history.cancelRetry": "Cancelar reintento",
  "scheduled.history.cancelRetry.aria": "Cancelar el reintento de la ejecución de {when}",
  "scheduled.history.cancelRetry.failed": "No se pudo cancelar el reintento ({reason}).",
  "settings.updates.group": "Actualizaciones",
  "settings.updates.hint": "Psyche busca actualizaciones firmadas y las instala al salir.",
  "settings.updates.channel": "Canal de versiones",
  "settings.updates.channel.stable": "Estable",
  "settings.updates.channel.note":
    "Estable es el único canal por ahora. Beta aparecerá aquí cuando se publiquen compilaciones beta. Cada actualización se comprueba con la clave de versiones de Psyche en cualquier caso.",
  "settings.updates.saveFailed": "No se pudo guardar el canal de versiones ({reason}).",
  "settings.storage.title": "Almacenamiento",
  "settings.storage.hint": "Espacio en disco que Psyche usa en su carpeta de datos en este equipo.",
  "settings.storage.total": "Total",
  "settings.storage.clear": "Borrar…",
  "settings.storage.cleared": "Borrado. Se liberaron {size}.",
  "settings.storage.clearFailed": "No se pudo borrar el almacenamiento ({reason}).",
  "settings.storage.failed": "No se pudo leer el uso de almacenamiento ({reason}).",
  "settings.storage.confirm.title": "¿Borrar cachés y grabaciones antiguas?",
  "settings.storage.confirm.body":
    "Se borrarán hasta {size} de cachés y grabaciones del navegador con más de 7 días. Psyche reconstruye las cachés cuando las necesita. Tus chats, memoria, Biblioteca, bóveda y ajustes no se tocan.",
  "settings.storage.confirm.clear": "Borrar",
  "settings.storage.cat.database": "Base de datos",
  "settings.storage.cat.memoryIndex": "Índice de memoria",
  "settings.storage.cat.library": "Adjuntos y Biblioteca",
  "settings.storage.cat.browserProfiles": "Perfiles del navegador",
  "settings.storage.cat.recordings": "Grabaciones",
  "settings.storage.cat.logs": "Registros",
  "settings.storage.cat.caches": "Cachés",
  "settings.storage.cat.other": "Todo lo demás",
};
