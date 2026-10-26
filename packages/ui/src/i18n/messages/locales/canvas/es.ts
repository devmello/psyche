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
};
