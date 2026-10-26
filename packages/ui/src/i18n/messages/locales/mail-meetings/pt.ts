import type { Catalogue } from "../../index.ts";

/** Mail and meeting settings and onboarding strings (pt); merged into `../pt.ts`. */
export const mailMeetings: Partial<Catalogue> = {
  "settings.nav.mail": "E-mail e reuniões",
  "settings.mail.title": "E-mail e reuniões",
  "settings.mail.description":
    "O que a Wren faz com seu e-mail e sua agenda. Ela salva rascunhos e propõe ações; nada é enviado, compartilhado, aceito ou recusado sem a sua aprovação.",
  "settings.mail.quietHours": "O horário de silêncio fica em Notificações.",
  "settings.mail.loadFailed": "Não foi possível carregar os ajustes de e-mail e reuniões.",

  "settings.mail.group.master": "Tudo de uma vez",
  "settings.mail.group.accounts": "Contas",
  "settings.mail.group.digest": "Resumo da caixa de entrada",
  "settings.mail.group.followups": "Pendências",
  "settings.mail.group.style": "Estilo de escrita",
  "settings.mail.group.scheduling": "Agendamento",
  "settings.mail.group.prep": "Preparação de reuniões",
  "settings.mail.group.notes": "Notas de reuniões",
  "settings.mail.group.polling": "Verificação de novos e-mails",

  "settings.mail.paused.hint": "Pausa todas as tarefas de e-mail e reuniões até você reativar.",
  "settings.mail.readOnly.hint":
    "Resumos e preparações continuam chegando. A Wren não propõe ações nem cria rascunhos.",

  "settings.mail.accounts.none": "Nenhuma conta de e-mail conectada. Conecte uma em Conectores.",
  "settings.mail.accounts.use": "Usar {account} no resumo e nas pendências",
  "settings.mail.accounts.connect": "Abrir Conectores",

  "settings.mail.digest.time": "Horário",
  "settings.mail.digest.days": "Dias",
  "settings.mail.digest.days.weekdays": "Dias úteis",
  "settings.mail.digest.days.everyday": "Todos os dias",
  "settings.mail.digest.onlyWhenNeeded.hint":
    "Em dias tranquilos, o resumo vai para o Feed sem notificação.",
  "settings.mail.digest.rules": "Regras de remetentes",
  "settings.mail.digest.rulesHint": "Quem é sempre arquivado, sempre permitido ou filtrado.",
  "settings.mail.digest.openRules": "Abrir",
  "settings.mail.digest.openRulesAsk": "Mostre-me mail/RULES.md.",

  "settings.mail.followups.waitDays": "Esperar antes de mostrar",
  "settings.mail.followups.days":
    "{n, plural, one {# dia útil} many {# de dias úteis} other {# dias úteis}}",
  "settings.mail.followups.showTwice.hint": "Depois de dois resumos, ela fica em silêncio.",

  "settings.mail.voice.learn.hint":
    "A Wren lê apenas o que você escreveu nos e-mails enviados, sem texto citado nem assinaturas. O perfil fica neste Mac, em mail/VOICE.md.",
  "settings.mail.voice.profile": "Perfil de escrita",
  "settings.mail.voice.view": "Ver",
  "settings.mail.voice.edit": "Editar",
  "settings.mail.voice.reset": "Redefinir",
  "settings.mail.voice.viewAsk": "Mostre-me mail/VOICE.md.",
  "settings.mail.voice.editAsk": "Quero editar mail/VOICE.md.",
  "settings.mail.voice.resetAsk":
    "Redefina meu perfil de estilo de escrita: apague mail/VOICE.md e mail/voice-samples.jsonl.",
  "settings.mail.voice.localModel.hint": "Rascunhos no seu estilo nunca saem deste Mac.",
  "settings.mail.voice.localModel.none": "Usar o modelo principal",
  "settings.mail.voice.localModel.empty": "Nenhum modelo local configurado.",

  "settings.mail.schedule.hours": "Horário de trabalho",
  "settings.mail.schedule.hoursHint":
    "Vem de USER.md. Os horários são oferecidos dentro deste período, em dias úteis.",
  "settings.mail.schedule.hoursFrom": "De",
  "settings.mail.schedule.hoursTo": "Até",
  "settings.mail.schedule.buffer.hint": "Intervalo mantido entre reuniões ao oferecer horários.",
  "settings.mail.schedule.minutes":
    "{n, plural, one {# minuto} many {# de minutos} other {# minutos}}",
  "settings.mail.schedule.noBuffer": "Nenhum",
  "settings.mail.schedule.focusTime.hint": "Sugerir reservar um bloco para trabalho focado.",
  "settings.mail.schedule.link.hint": "Opcional. Incluído nas respostas quando você tiver um.",

  "settings.mail.prep.scope.hint": "Ignora reuniões apenas com a sua própria equipe.",
  "settings.mail.prep.leadMin": "Preparar antes da reunião",
  "settings.mail.prep.notifyMin": "Avisar antes de começar",
  "settings.mail.prep.saveToNotes.hint": "Também guarda a nota de preparação no seu app de notas.",
  "settings.mail.prep.dailyCap": "Máximo de preparações por dia",
  "settings.mail.prep.calendars": "A preparação cobre as agendas que você conectou em Conectores.",

  "settings.mail.notes.enabled.hint":
    "Não faz nada até você adicionar áudio: um Memorando de Voz, um arquivo ou uma gravação que você iniciar.",
  "settings.mail.notes.folder": "Pasta de gravações",
  "settings.mail.notes.folder.hint":
    "Uma pasta que a Wren pode ler. Conceda acesso em Acesso a arquivos.",
  "settings.mail.notes.folder.placeholder": "~/Documents/Recordings",
  "settings.mail.notes.tasksApp": "Adicionar itens de ação a",
  "settings.mail.notes.tasksApp.reminders": "Lembretes",
  "settings.mail.notes.tasksApp.things": "Things",
  "settings.mail.notes.recap.hint": "Salva um e-mail de resumo como rascunho após cada reunião.",
  "settings.mail.notes.consent.hint":
    "Exibida antes de cada gravação que você iniciar. Você a fala ou a cola na chamada.",
  "settings.mail.notes.consent.default": "Estou gravando isto para as minhas notas. Tudo bem?",
  "settings.mail.notes.cloud.hint":
    "As transcrições contêm falas de outras pessoas. Desativado, os resumos usam um modelo local, ou perguntam antes.",

  "settings.mail.poll.active": "Enquanto você está ativo",
  "settings.mail.poll.idle": "Nos demais momentos",
  "settings.mail.poll.hint":
    "Com que frequência a Wren procura novos e-mails. Mais rápido gasta mais bateria.",

  "settings.key.workflows.paused": "Pausar todos os fluxos de e-mail e reuniões",
  "settings.key.workflows.readOnly": "Somente leitura (apenas resumos e preparação)",
  "settings.key.mail.accounts": "Usar {account} no resumo e nas pendências",
  "settings.key.mail.digest.enabled": "Resumo da caixa de entrada",
  "settings.key.mail.digest.time": "Horário do resumo",
  "settings.key.mail.digest.days": "Dias do resumo",
  "settings.key.mail.digest.onlyWhenNeeded": "Avisar só quando algo precisar de você",
  "settings.key.mail.followups.enabled": "Acompanhar respostas que você aguarda",
  "settings.key.mail.followups.waitDays": "Espera das pendências",
  "settings.key.mail.followups.showTwice": "Mostrar cada pendência no máximo duas vezes",
  "settings.key.mail.voice.enabled": "Aprender com e-mails enviados",
  "settings.key.mail.draft.localModel": "Rascunhar com modelo local",
  "settings.key.mail.schedule.hoursStart": "Início do horário de trabalho",
  "settings.key.mail.schedule.hoursEnd": "Fim do horário de trabalho",
  "settings.key.mail.schedule.bufferMin": "Intervalo entre reuniões",
  "settings.key.mail.schedule.focusTime": "Oferecer tempo de foco",
  "settings.key.mail.schedulingLink": "Link de agendamento",
  "settings.key.mail.poll.activeMin": "Verificação de e-mail com uso ativo",
  "settings.key.mail.poll.idleMin": "Verificação de e-mail nos demais momentos",
  "settings.key.meetings.prep.enabled": "Preparação de reuniões",
  "settings.key.meetings.prep.scope": "Só reuniões com pessoas de fora do meu domínio",
  "settings.key.meetings.prep.leadMin": "Antecedência da preparação",
  "settings.key.meetings.prep.notifyMin": "Antecedência do aviso de preparação",
  "settings.key.meetings.prep.saveToNotes": "Salvar preparação também em Notas",
  "settings.key.meetings.prep.dailyCap": "Máximo de preparações por dia",
  "settings.key.meetings.notes.enabled": "Notas de reuniões a partir de gravações",
  "settings.key.meetings.notes.folder": "Pasta de gravações",
  "settings.key.meetings.notes.tasksApp": "Adicionar itens de ação a",
  "settings.key.meetings.notes.recapDraft": "Rascunhar e-mail de resumo",
  "settings.key.meetings.notes.consentLine": "Frase de consentimento de gravação",
  "settings.key.meetings.notes.cloudSummary": "Resumir com modelo na nuvem",

  "onboarding.step.mail": "E-mail e reuniões",
  "onboarding.mail.title": "{name} pode deixar você em dia com e-mails e reuniões",
  "onboarding.mail.lead":
    "Escolha o que quiser. Nada roda até você continuar, e tudo pode ser mudado em Ajustes.",
  "onboarding.mail.digest": "Resumo matinal da caixa de entrada às 7h30",
  "onboarding.mail.digestHint": "Um resumo por dia do que precisa de você. Nunca envia nada.",
  "onboarding.mail.prep": "Notas de preparação antes de reuniões com pessoas de fora da sua equipe",
  "onboarding.mail.prepHint":
    "Quem são, o que está em aberto, o que vocês conversaram da última vez.",
  "onboarding.mail.followups": "Acompanhar respostas que você aguarda",
  "onboarding.mail.followupsHint": "Aparecem só no resumo. Sem avisos separados.",
  "onboarding.mail.voice": "Aprender meu estilo de escrita com e-mails enviados",
  "onboarding.mail.voiceHint":
    "Lê apenas o que você escreveu, sem texto citado nem assinaturas. Fica neste Mac e você pode ver, editar ou redefinir.",
  "onboarding.mail.notes": "Notas de reuniões a partir de gravações",
  "onboarding.mail.notesHint":
    "Não faz nada até você adicionar áudio. Áudios e transcrições nunca são enviados nem usados para treinamento.",
  "onboarding.mail.summary":
    "{n, plural, =0 {Nada ativado} one {# item ativado} many {# de itens ativados} other {# itens ativados}}",
  "onboarding.mail.done": "E-mail e reuniões",
  "onboarding.mail.doneOff": "Desativado. Você pode ativar em Ajustes.",
  "onboarding.mail.doneOn":
    "{n, plural, one {# fluxo ativado} many {# de fluxos ativados} other {# fluxos ativados}}",
};
