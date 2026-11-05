import type { Catalogue } from "../../index.ts";

/** Password presence on Linux (es); merged into `../es.ts`. */
export const passwordPresence: Partial<Catalogue> = {
  "blocks.approval.password.needsAuth":
    "Necesita tu contraseña o una clave de acceso para aprobarse.",
  "blocks.approval.password.waiting":
    "Escribe tu contraseña en el diálogo del sistema para aprobar {code}",
  "blocks.approval.password.waitingShort": "Esperando tu contraseña…",
  "blocks.approval.password.onceOnly":
    "Las aprobaciones con contraseña desde esta ventana son solo por una vez.",
  "blocks.approval.status.allowedOncePassword":
    "Permitido una vez (las aprobaciones con contraseña desde esta ventana son solo por una vez)",
  "blocks.approval.password.noUnsandboxed":
    "Ejecutar un comando sin el sandbox no se puede aprobar con contraseña desde esta ventana. Configura el sandbox en su lugar",
  "blocks.approval.password.cancelled":
    "Se canceló el diálogo de contraseña, así que no se aprobó nada",
  "blocks.approval.password.failed":
    "No se aceptó la contraseña, así que no se aprobó nada. Inténtalo de nuevo.",
  "blocks.approval.password.unavailableHere":
    "Aprueba en este equipo o con una clave de acceso desde otro dispositivo.",
  "blocks.approval.password.agentMissing":
    "Este escritorio no tiene diálogo de contraseña. Instala un agente de polkit como polkit-gnome o lxpolkit, o usa una clave de acceso.",
  "blocks.approval.password.policyMissing":
    "La política de contraseña de Psyche no está instalada en este equipo. Ejecuta la configuración única de Psyche o usa una clave de acceso.",
  "blocks.approval.password.notEnforced":
    "Una regla de polkit en este equipo aprueba Psyche sin contraseña, así que no puede confirmar que fuiste tú. Quita la regla o usa una clave de acceso.",
  "blocks.approval.password.unreachable":
    "El servicio de contraseñas del sistema no está disponible. Inténtalo de nuevo o usa una clave de acceso.",
  "settings.devices.password.title": "Aprobaciones con contraseña",
  "settings.devices.password.description":
    "Antes de aprobar una acción delicada, Psyche pide tu contraseña en el diálogo del propio sistema. La contraseña nunca llega a Psyche.",
  "settings.devices.password.state.ready": "Listo",
  "settings.devices.password.state.policyMissing": "Política no instalada",
  "settings.devices.password.state.notEnforced": "Desactivado",
  "settings.devices.password.state.noSession": "Sin sesión de escritorio",
  "settings.devices.password.state.agentMissing": "Sin diálogo de contraseña",
  "settings.devices.password.state.unavailable": "No disponible",
  "settings.devices.password.detail.ready":
    "Psyche pide tu contraseña en el diálogo del sistema cuando apruebas una acción delicada.",
  "settings.devices.password.detail.policyMissing":
    "La política de contraseña de Psyche no está instalada en este equipo. Ejecuta la configuración única de Psyche.",
  "settings.devices.password.detail.notEnforced":
    "Una regla de polkit en este equipo aprueba Psyche sin contraseña. Las aprobaciones con contraseña están desactivadas hasta que se quite.",
  "settings.devices.password.detail.noSession":
    "Las aprobaciones con contraseña necesitan una sesión de escritorio activa en este equipo. Abre Psyche allí.",
  "settings.devices.password.detail.agentMissing":
    "Este escritorio no tiene diálogo de contraseña. Instala un agente de polkit como polkit-gnome o lxpolkit.",
  "settings.devices.password.detail.unavailable":
    "Psyche no pudo conectar con el servicio de contraseñas del sistema.",
  "settings.devices.password.x11Warning":
    "Esta es una sesión X11. Otros programas pueden leer lo que escribes aquí, así que una contraseña es un obstáculo, no una barrera. Una sesión Wayland es más segura.",
};
