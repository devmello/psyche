import type { Catalogue } from "../../index.ts";

/** Overview Growth and People & projects strings (es); merged into `../es.ts`. */
export const overviewGrowth: Partial<Catalogue> = {
  "overview.meta.7d": "Últimos 7 días",
  "overview.meta.30d": "Últimos 30 días",
  "overview.meta.all": "Todo el tiempo",
  "overview.growth.loading": "Cargando el progreso",
  "overview.growth.loadFailed": "No se pudo cargar el progreso",
  "overview.growth.empty": "Aún no se ha aprendido nada en este periodo.",
  "overview.growth.counts": "Lecciones de este periodo",
  "overview.growth.learned":
    "{n, plural, one {# lección aprendida} other {# lecciones aprendidas}}",
  "overview.growth.refined": "{n, plural, one {# refinada} other {# refinadas}}",
  "overview.growth.confirmed": "{n, plural, one {# confirmada} other {# confirmadas}}",
  "overview.growth.forgotten": "{n, plural, one {# olvidada} other {# olvidadas}}",
  "overview.growth.milestones": "Hitos",
  "overview.growth.seeAll": "Ver todas las lecciones",
  "overview.growth.sheetTitle": "Lo que ha aprendido {agent}",
  "overview.growth.evidenceTitle": "Eventos detrás de «{metric}»",
  "overview.growth.card.thisWeek": "Lecciones de esta semana ({n})",
  "overview.growth.card.week": "Lecciones de la semana del {date} ({n})",
  "overview.growth.card.review": "Revisar",
  "overview.growth.card.sheetTitle": "Lo que {agent} ha aprendido esta semana",
  "overview.growth.card.sheetDescription": "Conserva, edita u olvida lo que {agent} ha captado.",
  "overview.people.loading": "Cargando personas y proyectos",
  "overview.people.loadFailed": "No se pudieron cargar las personas y los proyectos",
  "overview.people.paused":
    "El grafo de personas y proyectos está en pausa, así que no se registra nada. Actívalo en Ajustes para verlo aquí.",
  "overview.people.empty":
    "Todavía no hay nadie en este periodo. Las personas y los proyectos aparecen aquí cuando {agent} trabaja con ellos por ti.",
  "overview.people.map": "Mapa de personas y proyectos",
  "overview.people.mapHint":
    "Las flechas te mueven entre personas y proyectos, primero los que tienen más interacciones. Intro abre uno.",
  "overview.people.caption":
    "Anillos desde el centro: esta semana, este mes, antes. Más grande significa más interacciones. Los círculos son personas; los cuadrados, proyectos y organizaciones.",
  "overview.people.you": "Tú",
  "overview.people.kind.person": "Persona",
  "overview.people.kind.org": "Organización",
  "overview.people.kind.project": "Proyecto",
  "overview.people.kind.place": "Lugar",
  "overview.people.interactions": "{n, plural, one {# interacción} other {# interacciones}}",
  "overview.people.openLoops": "{n, plural, one {# asunto pendiente} other {# asuntos pendientes}}",
  "overview.people.last": "Última interacción {when}",
  "overview.people.node": "{name}, {kind}. {interactions}. Última interacción {when}. {loops}.",
  "overview.people.detailHint":
    "Pasa el cursor o el foco por una persona o un proyecto para ver sus detalles.",
  "overview.people.counts":
    "{people, plural, one {# persona} other {# personas}} · {projects, plural, one {# proyecto} other {# proyectos}} · {loops, plural, one {# asunto pendiente} other {# asuntos pendientes}}",
  "overview.people.ranked": "{name} {n}",
  "overview.people.showList": "Mostrar como lista",
  "overview.people.showMap": "Mostrar mapa",
  "overview.people.seeAll": "Ver todo",
  "overview.people.list": "Personas y proyectos, primero los que tienen más interacciones",
  "overview.people.table.name": "Nombre",
  "overview.people.table.kind": "Tipo",
  "overview.people.table.interactions": "Interacciones",
  "overview.people.table.last": "Última interacción",
  "overview.people.table.loops": "Asuntos pendientes",
};
