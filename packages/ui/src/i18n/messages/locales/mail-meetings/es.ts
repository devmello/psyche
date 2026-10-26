import type { Catalogue } from "../../index.ts";

/** Mail and meeting settings and onboarding strings (es); merged into `../es.ts`. */
export const mailMeetings: Partial<Catalogue> = {
  "settings.nav.mail": "Correo y reuniones",
  "settings.mail.title": "Correo y reuniones",
  "settings.mail.description":
    "Lo que Wren hace con tu correo y tu calendario. Guarda borradores y propone acciones; no se envía, comparte, acepta ni rechaza nada sin tu aprobación.",
  "settings.mail.quietHours": "Las horas de silencio están en Notificaciones.",
  "settings.mail.loadFailed": "No se pudieron cargar los ajustes de correo y reuniones.",

  // Group titles
  "settings.mail.group.master": "Todo a la vez",
  "settings.mail.group.accounts": "Cuentas",
  "settings.mail.group.digest": "Resumen de la bandeja de entrada",
  "settings.mail.group.followups": "Seguimientos",
  "settings.mail.group.style": "Estilo de escritura",
  "settings.mail.group.scheduling": "Programación",
  "settings.mail.group.prep": "Preparación de reunión",
  "settings.mail.group.notes": "Notas de reunión",
  "settings.mail.group.polling": "Comprobar correo nuevo",

  // Master switches
  "settings.mail.paused.hint":
    "Detiene todas las tareas de correo y reuniones hasta que las vuelvas a activar.",
  "settings.mail.readOnly.hint":
    "Los resúmenes y las preparaciones siguen llegando. Wren no propone acciones ni escribe borradores.",

  // Accounts
  "settings.mail.accounts.none":
    "No hay ninguna cuenta de correo conectada. Conecta una en Conectores.",
  "settings.mail.accounts.use": "Usar {account} en el resumen y los seguimientos",
  "settings.mail.accounts.connect": "Abrir Conectores",

  // Inbox digest
  "settings.mail.digest.time": "Hora",
  "settings.mail.digest.days": "Días",
  "settings.mail.digest.days.weekdays": "Días laborables",
  "settings.mail.digest.days.everyday": "Todos los días",
  "settings.mail.digest.onlyWhenNeeded.hint":
    "Los días tranquilos, el resumen llega a Novedades sin aviso.",
  "settings.mail.digest.rules": "Reglas de remitentes",
  "settings.mail.digest.rulesHint": "Quién se archiva siempre, se permite siempre o se revisa.",
  "settings.mail.digest.openRules": "Abrir",
  "settings.mail.digest.openRulesAsk": "Muéstrame mail/RULES.md.",

  // Follow-ups
  "settings.mail.followups.waitDays": "Espera antes de que aparezca",
  "settings.mail.followups.days": "{n, plural, one {# día laborable} other {# días laborables}}",
  "settings.mail.followups.showTwice.hint": "Tras dos resúmenes, deja de mostrarse.",

  // Writing style
  "settings.mail.voice.learn.hint":
    "Wren solo lee lo que escribiste en el correo enviado, sin el texto citado ni las firmas. El perfil se queda en este Mac, en mail/VOICE.md.",
  "settings.mail.voice.profile": "Perfil de estilo",
  "settings.mail.voice.view": "Ver",
  "settings.mail.voice.edit": "Editar",
  "settings.mail.voice.reset": "Restablecer",
  "settings.mail.voice.viewAsk": "Muéstrame mail/VOICE.md.",
  "settings.mail.voice.editAsk": "Déjame editar mail/VOICE.md.",
  "settings.mail.voice.resetAsk":
    "Restablece mi perfil de estilo de escritura: borra mail/VOICE.md y mail/voice-samples.jsonl.",
  "settings.mail.voice.localModel.hint": "Los borradores con tu estilo nunca salen de este Mac.",
  "settings.mail.voice.localModel.none": "Usar el modelo principal",
  "settings.mail.voice.localModel.empty": "No hay ningún modelo local configurado.",

  // Scheduling
  "settings.mail.schedule.hours": "Horario laboral",
  "settings.mail.schedule.hoursHint":
    "Viene de USER.md. Los huecos se ofrecen dentro de este horario, en días laborables.",
  "settings.mail.schedule.hoursFrom": "Desde",
  "settings.mail.schedule.hoursTo": "Hasta",
  "settings.mail.schedule.buffer.hint":
    "Margen que se deja alrededor de las reuniones al ofrecer horas.",
  "settings.mail.schedule.minutes": "{n, plural, one {# minuto} other {# minutos}}",
  "settings.mail.schedule.noBuffer": "Ninguno",
  "settings.mail.schedule.focusTime.hint": "Sugerir reservar un bloque para trabajo concentrado.",
  "settings.mail.schedule.link.hint": "Opcional. Se ofrece en las respuestas si tienes uno.",

  // Meeting prep
  "settings.mail.prep.scope.hint": "Omite las reuniones que son solo con tu propio equipo.",
  "settings.mail.prep.leadMin": "Preparar antes de la reunión",
  "settings.mail.prep.notifyMin": "Avisarme antes de que empiece",
  "settings.mail.prep.saveToNotes.hint":
    "También guarda la nota de preparación en tu app de notas.",
  "settings.mail.prep.dailyCap": "Máximo de preparaciones al día",
  "settings.mail.prep.calendars":
    "La preparación abarca los calendarios que conectaste en Conectores.",

  // Meeting notes
  "settings.mail.notes.enabled.hint":
    "No hace nada hasta que añadas audio: una nota de voz, un archivo o una grabación que inicies.",
  "settings.mail.notes.folder": "Carpeta de grabaciones",
  "settings.mail.notes.folder.hint":
    "Una carpeta que Wren puede leer. Concede el acceso en Acceso a archivos.",
  "settings.mail.notes.folder.placeholder": "~/Documents/Recordings",
  "settings.mail.notes.tasksApp": "Añadir tareas a",
  "settings.mail.notes.tasksApp.reminders": "Recordatorios",
  "settings.mail.notes.tasksApp.things": "Things",
  "settings.mail.notes.recap.hint":
    "Guarda como borrador un correo de resumen después de cada reunión.",
  "settings.mail.notes.consent.hint":
    "Se muestra antes de cada grabación que inicias. La dices tú o la pegas en la llamada.",
  "settings.mail.notes.consent.default": "Estoy grabando esto para mis notas. ¿Te parece bien?",
  "settings.mail.notes.cloud.hint":
    "Las transcripciones contienen palabras de otras personas. Desactivado, los resúmenes usan un modelo local, o preguntar antes.",

  // Polling
  "settings.mail.poll.active": "Mientras estás activo",
  "settings.mail.poll.idle": "En otro caso",
  "settings.mail.poll.hint": "Cada cuánto busca Wren correo nuevo. Más a menudo gasta más batería.",

  // Setting-key labels
  "settings.key.workflows.paused": "Pausar todos los flujos de correo y reuniones",
  "settings.key.workflows.readOnly": "Solo lectura (solo resúmenes y preparación)",
  "settings.key.mail.accounts": "Usar {account} en el resumen y los seguimientos",
  "settings.key.mail.digest.enabled": "Resumen de la bandeja de entrada",
  "settings.key.mail.digest.time": "Hora del resumen",
  "settings.key.mail.digest.days": "Días del resumen",
  "settings.key.mail.digest.onlyWhenNeeded": "Avisar solo cuando algo te necesite",
  "settings.key.mail.followups.enabled": "Seguir las respuestas que esperas",
  "settings.key.mail.followups.waitDays": "Espera del seguimiento",
  "settings.key.mail.followups.showTwice": "Mostrar cada seguimiento como máximo dos veces",
  "settings.key.mail.voice.enabled": "Aprender del correo enviado",
  "settings.key.mail.draft.localModel": "Escribir borradores con un modelo local",
  "settings.key.mail.schedule.hoursStart": "Inicio del horario laboral",
  "settings.key.mail.schedule.hoursEnd": "Fin del horario laboral",
  "settings.key.mail.schedule.bufferMin": "Margen entre reuniones",
  "settings.key.mail.schedule.focusTime": "Ofrecer tiempo de concentración",
  "settings.key.mail.schedulingLink": "Enlace de programación",
  "settings.key.mail.poll.activeMin": "Comprobación de correo en actividad",
  "settings.key.mail.poll.idleMin": "Comprobación de correo en otro caso",
  "settings.key.meetings.prep.enabled": "Preparación de reunión",
  "settings.key.meetings.prep.scope": "Solo reuniones con personas ajenas a mi dominio",
  "settings.key.meetings.prep.leadMin": "Antelación de la preparación",
  "settings.key.meetings.prep.notifyMin": "Antelación del aviso de preparación",
  "settings.key.meetings.prep.saveToNotes": "Guardar también la preparación en Notas",
  "settings.key.meetings.prep.dailyCap": "Máximo de preparaciones al día",
  "settings.key.meetings.notes.enabled": "Notas de reunión a partir de grabaciones",
  "settings.key.meetings.notes.folder": "Carpeta de grabaciones",
  "settings.key.meetings.notes.tasksApp": "Añadir tareas a",
  "settings.key.meetings.notes.recapDraft": "Escribir un borrador de correo de resumen",
  "settings.key.meetings.notes.consentLine": "Frase de consentimiento de grabación",
  "settings.key.meetings.notes.cloudSummary": "Resumir con un modelo en la nube",

  // Onboarding decision screen
  "onboarding.step.mail": "Correo y reuniones",
  "onboarding.mail.title": "{name} puede ponerte al día con el correo y las reuniones",
  "onboarding.mail.lead":
    "Elige lo que quieras. Nada se ejecuta hasta que continúes, y puedes cambiarlo todo en Ajustes.",
  "onboarding.mail.digest": "Resumen matinal de la bandeja de entrada a las 7:30",
  "onboarding.mail.digestHint": "Un resumen al día de lo que te necesita. Nunca envía nada.",
  "onboarding.mail.prep": "Notas de preparación antes de reuniones con personas ajenas a tu equipo",
  "onboarding.mail.prepHint": "Quiénes son, qué queda pendiente, de qué hablasteis la última vez.",
  "onboarding.mail.followups": "Seguir las respuestas que esperas",
  "onboarding.mail.followupsHint": "Solo se muestra en el resumen. Sin avisos aparte.",
  "onboarding.mail.voice": "Aprender mi estilo de escritura del correo enviado",
  "onboarding.mail.voiceHint":
    "Solo lee lo que escribiste, sin el texto citado ni las firmas. Se queda en este Mac y puedes verlo, editarlo o restablecerlo.",
  "onboarding.mail.notes": "Notas de reunión a partir de grabaciones",
  "onboarding.mail.notesHint":
    "No hace nada hasta que añadas audio. El audio y las transcripciones nunca se suben ni se usan para entrenar.",
  "onboarding.mail.summary":
    "{n, plural, =0 {Nada activado} one {# cosa activada} other {# cosas activadas}}",
  "onboarding.mail.done": "Correo y reuniones",
  "onboarding.mail.doneOff": "Desactivado. Puedes activarlo en Ajustes.",
  "onboarding.mail.doneOn": "{n, plural, one {# flujo activado} other {# flujos activados}}",
  "settings.mail.schedule.link.placeholder": "https://",
};
