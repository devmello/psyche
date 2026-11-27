import type { Catalogue } from "../../index.ts";

/** Simplify batch B4: devices and pairing (es); merged into `../es.ts`. */
export const simplifyB4: Partial<Catalogue> = {
  "simplify.b4.devices.title": "Dispositivos",
  "simplify.b4.devices.description": "Los ordenadores y iPhone que pueden usar Psyche.",
  "simplify.b4.devices.details": "Detalles",
  "simplify.b4.devices.canDo": "Qué puede hacer",
  "simplify.b4.devices.canDoOf": "Qué puede hacer {name}",
  "simplify.b4.devices.hostKey": "Clave de este ordenador: {fingerprint}",
  "simplify.b4.devices.helpers": "Ayudantes",
  "simplify.b4.devices.helpersHint":
    "Las pequeñas apps que permiten a Psyche trabajar en un ordenador.",
  "simplify.b4.devices.noHelpers":
    "Aún no hay ayudantes. Un ayudante aparece aquí cuando Psyche se ejecuta en un ordenador.",
  "simplify.b4.server.title": "Red y acceso remoto",
  "simplify.b4.server.description":
    "Cómo llegan otros dispositivos a este ordenador y cómo usar Psyche fuera de casa.",
  "simplify.b4.server.away": "Usarlo fuera de casa",
  "simplify.b4.pairIphone.title": "Vincular iPhone",
  "simplify.b4.pairIphone.description":
    "Escanea un código con Psyche en tu iPhone. El iPhone y este ordenador deben estar en la misma Wi-Fi.",
  "simplify.b4.pairIphone.button": "Vincular iPhone",
  "simplify.b4.pairIphone.scan":
    "Abre Psyche en tu iPhone y escanea este código. Solo funciona una vez.",
  "simplify.b4.pairIphone.lanOn":
    "Al vincular se activó el acceso por red, para que tu iPhone encuentre este ordenador.",
  "simplify.b4.pairIphone.lanOff": "El acceso por red vuelve a estar desactivado.",
  "simplify.b4.pairIphone.turnOff": "Desactivar el acceso por red",
  "simplify.b4.pairIphone.enableFailed": "No se pudo activar el acceso por red: {reason}",
  "simplify.b4.pairIphone.turnOffFailed": "No se pudo desactivar el acceso por red: {reason}",
  "simplify.b4.pairIphone.noNetwork":
    "Ahora mismo no se puede llegar a este ordenador en tu red. Comprueba que la Wi-Fi esté activada e inténtalo de nuevo.",
};
