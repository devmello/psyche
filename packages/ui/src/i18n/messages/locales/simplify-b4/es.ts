import type { Catalogue } from "../../index.ts";

/** Simplify batch B4: devices and pairing (es); merged into `../es.ts`. */
export const simplifyB4: Partial<Catalogue> = {
  "simplifyB4.devices.title": "Dispositivos",
  "simplifyB4.devices.description": "Los ordenadores y iPhone que pueden usar Psyche.",
  "simplifyB4.devices.details": "Detalles",
  "simplifyB4.devices.canDo": "Qué puede hacer",
  "simplifyB4.devices.canDoOf": "Qué puede hacer {name}",
  "simplifyB4.devices.hostKey": "Clave de este ordenador: {fingerprint}",
  "simplifyB4.devices.helpers": "Ayudantes",
  "simplifyB4.devices.helpersHint": "Las pequeñas apps que permiten a Psyche trabajar en un ordenador.",
  "simplifyB4.devices.noHelpers": "Aún no hay ayudantes. Un ayudante aparece aquí cuando Psyche se ejecuta en un ordenador.",
  "simplifyB4.server.title": "Red y acceso remoto",
  "simplifyB4.server.description": "Cómo llegan otros dispositivos a este ordenador y cómo usar Psyche fuera de casa.",
  "simplifyB4.server.away": "Usarlo fuera de casa",
  "simplifyB4.pairIphone.title": "Vincular iPhone",
  "simplifyB4.pairIphone.description": "Escanea un código con Psyche en tu iPhone. El iPhone y este ordenador deben estar en la misma Wi-Fi.",
  "simplifyB4.pairIphone.button": "Vincular iPhone",
  "simplifyB4.pairIphone.scan": "Abre Psyche en tu iPhone y escanea este código. Solo funciona una vez.",
  "simplifyB4.pairIphone.lanOn": "Al vincular se activó el acceso por red, para que tu iPhone encuentre este ordenador.",
  "simplifyB4.pairIphone.lanOff": "El acceso por red vuelve a estar desactivado.",
  "simplifyB4.pairIphone.turnOff": "Desactivar el acceso por red",
  "simplifyB4.pairIphone.enableFailed": "No se pudo activar el acceso por red: {reason}",
  "simplifyB4.pairIphone.turnOffFailed": "No se pudo desactivar el acceso por red: {reason}",
  "simplifyB4.pairIphone.noNetwork": "Ahora mismo no se puede llegar a este ordenador en tu red. Comprueba que la Wi-Fi esté activada e inténtalo de nuevo.",
};
