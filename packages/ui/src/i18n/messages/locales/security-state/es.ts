import type { Catalogue } from "../../index.ts";

/** The security-records banner and review panel (es); merged into `../es.ts`. */
export const securityState: Partial<Catalogue> = {
  "web.security.banner.changed":
    "Psyche deshizo un cambio en sus registros de seguridad hecho fuera de la app.",
  "web.security.banner.untrusted":
    "La comprobación de los registros de seguridad de Psyche falló. Los cambios que amplían el acceso están bloqueados.",
  "web.security.banner.recovery":
    "{count, plural, one {Un cambio de seguridad pedido en este Mac se aplica el {when} salvo que lo canceles.} other {# cambios de seguridad pedidos en este Mac están en espera. El siguiente se aplica el {when}.}}",
  "web.security.banner.notice":
    "{count, plural, one {1 aviso de seguridad por revisar.} other {# avisos de seguridad por revisar.}}",
  "web.security.review": "Revisar",
  "web.security.hide": "Ocultar",
  "web.security.panel.label": "Registros de seguridad",
  "web.security.alert.changed":
    "Un programa de este Mac cambió {count, plural, one {1 registro de seguridad} other {# registros de seguridad}} sin pasar por Psyche. Psyche {count, plural, one {lo restauró} other {los restauró}}. Si no fuiste tú, revisa el Mac en busca de software no deseado.",
  "web.security.alert.untrusted":
    "La comprobación de los registros de seguridad de Psyche falló. Los dispositivos nuevos, los ajustes de seguridad y las aprobaciones con Touch ID están bloqueados. Revisa tus dispositivos y luego ejecuta psyched security reseal en el Mac; se aplica a las 24 horas.",
  "web.security.alert.firstSeal":
    "Psyche ahora comprueba sus registros de seguridad ({devices, plural, one {1 dispositivo vinculado} other {# dispositivos vinculados}}). Un cambio hecho fuera de Psyche se deshace y se muestra aquí. Revisa tus dispositivos una vez.",
  "web.security.alert.resealed": "Psyche volvió a sellar sus registros de seguridad.",
  "web.security.alert.restored":
    "Psyche arrancó desde una copia de seguridad restaurada y selló sus registros de seguridad tal como están. Si no restauraste ninguna copia, revisa tus dispositivos.",
  "web.security.alert.firstAdmin":
    "Un comando en este Mac convirtió {name} en el primer dispositivo administrador. Si no fuiste tú, revócalo en Dispositivos.",
  "web.security.alert.requested": "Pedido en este Mac: {action} Se aplica el {when}.",
  "web.security.alert.applied": "Aplicado: {action}",
  "web.security.alert.cancelled": "Cancelado: {action}",
  "web.security.alert.failed": "No se pudo aplicar: {action}",
  "web.security.op.devicesApprove": "aprobar el dispositivo {name}.",
  "web.security.op.devicesGrant": "cambiar lo que puede hacer {name}.",
  "web.security.op.presenceReset":
    "borrar la clave que protege los pagos hasta que se registre una nueva.",
  "web.security.op.sealReset": "aceptar los registros de seguridad actuales tal como están.",
  "web.security.device": "un dispositivo",
  "web.security.deviceKey": "{name} (clave {fingerprint})",
  "web.security.change":
    "{change, select, added {Añadido} modified {Cambiado} other {Eliminado}}: {what}",
  "web.security.more": "{count, plural, one {y 1 más} other {y # más}}",
  "web.security.ack": "Marcar como revisado",
  "web.security.approveNow": "Aprobar ahora",
  "web.security.cancel": "Cancelar solicitud",
  "web.security.needsApprovalPresence":
    "Aprueba la tarjeta con Touch ID o una llave de acceso y vuelve a pulsar el botón.",
  "web.security.needsApproval": "Aprueba la tarjeta y luego pulsa el botón otra vez.",
  "web.security.failed": "No funcionó: {message}",
  "settings.security.title": "Registros de seguridad",
  "settings.security.description":
    "Si los registros de seguridad de Psyche están intactos, qué cambió sin ti y las solicitudes pendientes de aplicarse.",
  "settings.security.status.sealed": "Intactos",
  "settings.security.status.untrusted": "Sin confianza",
  "settings.security.empty": "Nada que revisar. No hay avisos ni solicitudes en espera.",
  "settings.security.approvalLabel": "Cambio de seguridad",
  "settings.security.approve.title": "¿Aplicar este cambio ahora?",
  "settings.security.approve.body": "La solicitud se aplica ahora en lugar del {when}: {action}",
  "settings.security.approve.confirm": "Aplicar ahora",
  "settings.security.cancel.title": "¿Cancelar esta solicitud?",
  "settings.security.cancel.body": "El cambio no se hará y la solicitud se descarta: {action}",
  "settings.security.keep": "Mantenerla",
};
