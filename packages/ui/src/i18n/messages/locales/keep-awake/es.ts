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
  "settings.storage.title": "Almacenamiento",
  "settings.storage.hint": "Espacio en disco que Psyche usa en su carpeta de datos en este equipo.",
  "settings.storage.total": "Total",
  "settings.storage.clear": "Borrar…",
  "settings.storage.cleared": "Borrado. Se liberaron {size}.",
  "settings.storage.clearFailed": "No se pudo borrar el almacenamiento ({reason}).",
  "settings.storage.compact.title": "Compactar la base de datos",
  "settings.storage.compact.hint":
    "Base de datos: {size}, se pueden recuperar hasta {reclaimable}. Psyche se detiene un momento mientras tanto.",
  "settings.storage.compact.button": "Compactar",
  "settings.storage.compact.running": "Compactando…",
  "settings.storage.compact.done": "Compactada en {seconds} s, {size} liberados.",
  "settings.storage.compact.failed": "No se pudo compactar la base de datos ({reason}).",
  "settings.storage.compact.busy": "Psyche está ocupado. Vuelve a intentarlo cuando termine.",
  "settings.storage.failed": "No se pudo leer el uso de almacenamiento ({reason}).",
  "settings.storage.confirm.title": "¿Borrar cachés y grabaciones antiguas?",
  "settings.storage.confirm.body":
    "Se borrarán {size} de cachés y grabaciones del navegador con más de 7 días, junto con sus entradas en la Biblioteca. Psyche reconstruye las cachés cuando las necesita. Tus chats, memoria, otros archivos de la Biblioteca, bóveda y ajustes no se tocan.",
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
