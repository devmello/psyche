import type { Catalogue } from "../../index.ts";

/** Linux access in Settings → Computer use (es); merged into `../es.ts`. */
export const linuxAccess: Partial<Catalogue> = {
  "settings.computerUse.linux.screen.name": "Acceso a la pantalla y a la entrada",
  "settings.computerUse.linux.screen.allowed": "Permitido hasta que lo revoques",
  "settings.computerUse.linux.screen.asks": "Pregunta la primera vez que lo uses",
  "settings.computerUse.linux.screen.notNeeded": "No hace falta en X11",
  "settings.computerUse.linux.screen.unavailable": "No disponible",
  "settings.computerUse.linux.screen.why":
    "{persona} ve tu pantalla y usa el ratón y el teclado mediante el cuadro de permisos de tu escritorio. Lo apruebas una sola vez.",
  "settings.computerUse.linux.revoke": "Revocar",
  "settings.computerUse.linux.revokeLabel": "Revocar el acceso a la pantalla y a la entrada",
  "settings.computerUse.linux.warning.x11":
    "En X11, cualquier aplicación puede leer tu pantalla y tus pulsaciones de teclas, incluida tu contraseña cuando apruebas algo.",
  "settings.computerUse.linux.warning.wlroots":
    "En este escritorio, cualquier aplicación puede leer tu pantalla y escribir por ti sin preguntar. Psyche no puede añadir un paso de consentimiento.",
  "settings.computerUse.linux.accessibility":
    "Las aplicaciones que abras a partir de ahora mostrarán su estructura a Psyche. Puede que las que ya estén abiertas necesiten reiniciarse.",
  "settings.computerUse.linux.headless":
    "Hace falta una sesión gráfica en este ordenador. Inicia sesión en el escritorio y vuelve a intentarlo.",
};
