import type { Catalogue } from "../../index.ts";

/** Output canvas strings (es); merged into `../es.ts`. */
export const canvas: Partial<Catalogue> = {
  "canvas.chart": "Gráfico",
  "canvas.htmlOff":
    "Esto viene de contenido no confiable, así que la vista previa está desactivada. Ejecútala solo si confías en ella. Se ejecuta en un entorno aislado sin red.",
  "canvas.htmlRun": "Ejecutar",
  "canvas.htmlNoPreview": "Este equipo no puede previsualizar HTML; se muestra el código.",
  "canvas.label": "Lienzo: {title}",
  "canvas.recents": "Resultados recientes",
  "canvas.loading": "Cargando…",
  "canvas.missing": "Psyche no pudo cargar este resultado.",
  "canvas.untrusted": "De contenido no confiable",
  "canvas.version": "Versión",
  "canvas.versionOption":
    "v{version} · {author, select, user {tú} specialist {especialista} other {Psyche}} · {time}",
  "canvas.copy": "Copiar",
  "canvas.copied": "Copiado",
  "canvas.download": "Descargar",
  "canvas.restore": "Restaurar como versión nueva",
  "canvas.oldVersion": "Versión {version} (solo lectura).",
  "canvas.conflict":
    "Esto cambió mientras editabas, así que no se guardó tu cambio. Vuelve a intentarlo sobre la versión más reciente.",
  "canvas.saveFailed": "No se pudo guardar: {message}",
  "canvas.map": "Mapa",
  "map.label": "Mapa: {title}",
  "map.untitled": "Mapa",
  "map.list": "Lugares",
  "map.openLink": "Abrir enlace",
  "map.empty": "No hay lugares que mostrar.",
  "map.tilesOff": "Las teselas del mapa están desactivadas en Ajustes. Se muestra la lista.",
  "map.tilesFailed": "No se pudo cargar el mapa. Se muestra la lista.",
  "map.showMap": "Mostrar mapa",
  "map.showList": "Mostrar lista",
  "map.card": "Mapa: {title}",
  "map.meta": "{count, plural, one {# lugar} other {# lugares}} · {date}",
  "map.openCanvas": "Abrir en el lienzo",
  "map.invalid": "No se pudo leer este mapa.",
  "map.gesture.windows": "Usa Ctrl + desplazar para hacer zoom en el mapa",
  "map.gesture.mac": "Usa ⌘ + desplazar para hacer zoom en el mapa",
  "map.gesture.mobile": "Usa dos dedos para mover el mapa",
  "settings.map.title": "Mapas",
  "settings.map.privacy":
    "Mostrar un mapa pide al servidor de teselas la zona que miras, así que ese servidor puede saber aproximadamente dónde miras. Desactiva las teselas para ver los lugares solo en lista, o usa tu propio servidor.",
  "settings.map.tiles": "Mostrar teselas del mapa",
  "settings.map.tilesHint": "Desactivado muestra los lugares en una lista sin peticiones de mapa.",
  "settings.map.style": "URL de estilo del servidor de teselas",
  "settings.map.styleHint":
    "Una URL de estilo JSON de MapLibre, por ejemplo de tu propio servidor. Vacía usa las teselas gratuitas de OpenFreeMap (solo https; http para localhost).",
  "settings.map.styleDark": "URL de estilo (oscuro)",
  "settings.map.styleDarkHint":
    "Opcional. Vacía usa el estilo anterior también en modo oscuro, o el estilo oscuro de OpenFreeMap.",
};
