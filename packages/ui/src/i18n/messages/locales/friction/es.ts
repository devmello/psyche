import type { Catalogue } from "../../index.ts";

/** Approval-friction and person-interaction strings (es); merged into `../es.ts`. */
export const friction: Partial<Catalogue> = {
  "friction.title": "Fricción de aprobaciones",
  "friction.hint":
    "Con qué frecuencia Psyche se detiene a preguntar antes de actuar, y cómo respondes. Solo cifras, del registro de auditoría.",
  "friction.window": "Periodo",
  "friction.window.days": "Últimos {days} días",
  "friction.loading": "Contando aprobaciones…",
  "friction.error": "No se pudo cargar la fricción de aprobaciones: {reason}",
  "friction.retry": "Intentar de nuevo",
  "friction.empty":
    "Psyche no revisó acciones en este periodo, así que no hay fricción que mostrar.",
  "friction.since": "Desde el {date}",
  "friction.asked":
    "Preguntó por {asks, plural, one {# acción} other {# acciones}} de {decisions, plural, one {# acción revisada} other {# acciones revisadas}} ({rate} %).",
  "friction.perRun":
    "Las ejecuciones que preguntaron al menos una vez tuvieron una media de {n} preguntas cada una.",
  "friction.answered": "De las preguntas terminadas, el {rate} % se respondió antes de caducar.",
  "friction.approved": "De las preguntas terminadas, el {rate} % se aprobó.",
  "friction.noTimes":
    "En este periodo no se respondió ninguna pregunta, así que no hay tiempo de respuesta.",
  "friction.times":
    "Responder tomó una mediana de {p50}. La décima parte más lenta tardó {p90} o más.",
  "friction.expired":
    "{n, plural, =0 {Ninguna pregunta caducó sin respuesta.} one {# pregunta caducó sin respuesta.} other {# preguntas caducaron sin respuesta.}}",
  "friction.rejected":
    "{n, plural, =0 {No se rechazó ninguna respuesta.} one {# respuesta se rechazó por no válida.} other {# respuestas se rechazaron por no válidas.}}",
  "friction.saved":
    "{n, plural, =0 {Ninguna acción se ejecutó con un permiso permanente sin aviso.} one {# acción se ejecutó con un permiso permanente y sin aviso.} other {# acciones se ejecutaron con un permiso permanente y sin aviso.}}",
  "friction.grantsCreated":
    "{n, plural, =0 {No se creó ningún permiso permanente.} one {Se creó # permiso permanente.} other {Se crearon # permisos permanentes.}}",
  "friction.kinds": "De dónde salieron las preguntas",
  "friction.kind.row":
    "{kind}: preguntado {asks}, aprobado {approved}, rechazado {declined}, caducado {expired}",
  "friction.rules": "Motivos más comunes para preguntar",
  "friction.rule.row": "{label}: {count}",
  "friction.rule.mode": "Tu ajuste de modo",
  "friction.rule.taint": "Contenido externo",
  "friction.rule.policy": "Tu política",
  "friction.rule.designated": "Un lugar protegido",
  "friction.rule.site": "Una regla de sitio",
  "friction.rule.other": "Otra regla",
  "friction.modes": "Por modo",
  "friction.mode.row": "{mode}: preguntó {asks} de {decisions}",

  "people.interactions.title": "Interacciones recientes",
  "people.interactions.empty": "Todavía no hay interacciones con {name}.",
  "people.interactions.error": "No se pudieron cargar las interacciones: {reason}",
  "people.interactions.more": "Mostrar más",
  "people.interactions.loadingMore": "Cargando…",
};
