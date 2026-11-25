import type { Catalogue } from "../../index.ts";

/** Psyche points (es); merged into `../es.ts`. */
export const points: Partial<Catalogue> = {
  "points.sheet.title": "Guíame por un formulario",
  "points.sheet.description":
    "Elige una ventana y Psyche señala el siguiente campo. Tú haces los clics y escribes.",
  "points.sheet.windows.label": "Ventana",
  "points.sheet.windows.loading": "Buscando ventanas…",
  "points.sheet.windows.empty":
    "No hay ventanas que señalar. Abre el formulario y vuelve a intentarlo.",
  "points.sheet.windows.error":
    "No se pudieron listar tus ventanas. Comprueba que Psyche Helper esté en marcha y vuelve a intentarlo.",
  "points.sheet.windows.retry": "Reintentar",
  "points.sheet.window.untitled": "Ventana sin título",
  "points.sheet.window.frontmost": "Al frente",
  "points.refusal.never_app": "Psyche no señala en esta app.",
  "points.refusal.fixed_off": "Esta app está fuera de los límites de Psyche.",
  "points.refusal.terminal_or_ide": "Los terminales y los editores de código no son formularios.",
  "points.refusal.owner_off": "Desactivaste esta app en Ajustes.",
  "points.refusal.not_a_window": "Psyche no puede leer esta ventana.",
  "points.refusal.permission_missing": "Permite Accesibilidad para leer esta ventana.",
  "points.sheet.goal.label": "¿Para qué es este formulario? (opcional)",
  "points.sheet.goal.placeholder": "Declaración de la renta 2026, casados con declaración conjunta",
  "points.sheet.data.provider":
    "Psyche envía a {provider} las etiquetas del formulario y lo que escribes, salvo contraseñas y números de tarjeta, banco e identificación, para guiarte.",
  "points.sheet.data.local": "Esto se queda en este ordenador.",
  "points.sheet.data.providerFallback": "tu proveedor de modelos",
  "points.sheet.payments":
    "En las páginas de pago Psyche solo da indicaciones. Esos campos los rellenas tú.",
  "points.sheet.permission.hint":
    "Psyche lee la ventana mediante Accesibilidad. Permítela para Psyche Helper para empezar.",
  "points.sheet.start": "Empezar a señalar",
  "points.sheet.starting": "Empezando…",
  "points.sheet.cancel": "Cancelar",
  "points.sheet.startFailed": "No se pudo empezar a señalar. Inténtalo de nuevo.",
  "points.sheet.session.active": "Señalando en {app}",
  "points.sheet.session.stop": "Dejar de señalar",
  "points.state.reading": "Leyendo el formulario…",
  "points.state.pointing": "Campo {step} de {of}",
  "points.state.paused": "En pausa",
  "points.needs.screenRecording.title": "Que Psyche mire necesita Grabación de pantalla",
  "points.needs.screenRecording.hint":
    "Psyche envía una imagen de esta ventana solo cuando pulsas Que Psyche mire.",
  "points.needs.done": "Listo",
  "points.offer.button": "Guíame",
  "points.offer.hint": "Psyche te muestra dónde mirar. Tú haces clic y escribes.",
  "points.offer.elsewhere":
    "Inicia Psyche points en el ordenador donde se ejecuta Psyche: pulsa {keys} y elige Guíame por un formulario.",
  "points.palette.start": "Guíame por un formulario",
  "points.palette.keywords":
    "psyche points flecha guiar formulario rellenar impuestos visado trámites ayuda",
  "points.settings.title": "Psyche points",
  "points.settings.description":
    "Elige una ventana y Psyche señala el siguiente campo. Nunca hace clic ni escribe.",
  "points.settings.enabledHint":
    "Añade Guíame por un formulario a la paleta de comandos y al menú de la barra de menús.",
  "settings.key.points.enabled": "Guiarme por formularios",
  "points.card.back": "Atrás",
  "points.card.skip": "Omitir",
  "points.card.next": "Siguiente",
  "points.card.looksWrong": "¿Parece incorrecto?",
  "points.card.stuck": "¿Atascado?",
  "points.card.stuckMissing": "No lo tengo",
  "points.card.stuckUnclear": "No lo entiendo",
  "points.card.stuckBlocked": "No me deja",
  "points.card.askInPsyche": "Preguntar en Psyche…",
  "points.card.letLook": "Que Psyche mire",
  "points.card.stop": "Detener",
  "points.card.hideNote": "Ocultar nota",
  "points.card.copy": "Copiar",
  "points.card.selfFill": "Esto lo rellenas tú: {label}",
  "points.card.selfFillPlain": "Esto lo rellenas tú",
  "points.card.payButton": "Este botón paga. Revisa el importe y decide tú.",
  "points.card.unknownValue": "Psyche no conoce este dato.",
  "points.card.scrollTo": "Desplázate hacia abajo hasta {label}",
  "points.card.menuBarTitle": "◉ Señalando: {app}",
  "points.card.stepFormat": "{n}/{total}",
  "points.card.visionBadge": "Usando una imagen de esta ventana",
  "points.card.followWindow": "Seguir esta ventana",
};
