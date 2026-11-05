import type { Catalogue } from "../../index.ts";

/** settings-a strings (pt); merged into `../pt.ts`. */
export const settingsA: Partial<Catalogue> = {
  "settings.page.daily.description":
    "Seu resumo e fechamento do dia, automações, habilidades e os especialistas que {persona} pode chamar.",
  "settings.page.permissions.description":
    "O que {persona} pode fazer neste Mac sem perguntar, e onde sempre para para perguntar a você.",
  "settings.page.data.description":
    "O que fica neste Mac, por quanto tempo é guardado, exportações, backups e recomeçar do zero.",
  "settings.page.devices.description":
    "Seus outros dispositivos, o servidor Gateway e como falar com {persona} quando você está fora.",
  "settings.page.about.description": "Versões, verificações de integridade e logs.",
  "settings.essentials.title": "Essenciais",
  "settings.essentials.description":
    "As poucas escolhas que a maioria das pessoas faz, cada uma com um padrão seguro. {persona} pergunta quando precisa de mais.",
  "settings.essentials.more": "Mais",
  "settings.essentials.moreIn": "Mais em {place}",
  "settings.essentials.model.title": "Modelo",
  "settings.essentials.model.thinksWith": "{persona} pensa com",
  "settings.essentials.model.ready": "Pronto",
  "settings.essentials.model.noKey": "Precisa de uma chave",
  "settings.essentials.model.none": "Nenhum modelo ainda",
  "settings.essentials.model.noneHint":
    "{persona} precisa de um modelo para poder responder. Adicione uma chave ou use um modelo neste Mac.",
  "settings.essentials.model.setUp": "Configurar um modelo",
  "settings.essentials.read.title": "O que {persona} pode ler",
  "settings.essentials.read.hint":
    "Desativado até você ativar algum. O que é lido é indexado neste Mac para encontrar coisas para você, e a memória também aprende com isso, a menos que você desative em Memória → Fontes.",
  "settings.essentials.asks.title": "Com que frequência {persona} pergunta antes",
  "settings.essentials.interrupt.title": "Quando {persona} pode interromper você",
  "settings.essentials.interrupt.quietHint":
    "De {from} até {until}, as notificações esperam na caixa de entrada.",
  "settings.essentials.interrupt.briefHint": "Um resumo curto no Feed às {time}.",
  "settings.essentials.memory.title": "Memória",
  "settings.essentials.memory.remember": "Deixar {persona} lembrar de nossos chats",
  "settings.essentials.memory.rememberHint":
    "Desativado pausa a memória: nada novo é lembrado nem indexado dos chats até você reativar.",
  "settings.essentials.rest":
    "Todo o resto, e um controle mais fino de cada um destes, está nas páginas abaixo. A busca nos ajustes encontra qualquer um.",
  "settings.searchModel.title": "Modelo para a pesquisa",
  "settings.searchModel.description":
    "Qual modelo lê as perguntas, escreve os cartões de contexto e reordena os resultados.",
  "settings.searchModel.utility": "Seu modelo utilitário",
  "settings.searchModel.utilityHint":
    "O modelo pequeno definido em Modelos. Se for um modelo na nuvem, o texto que ele lê vai para esse provedor.",
  "settings.searchModel.apple":
    "Usar o modelo no dispositivo da Apple para tarefas de pesquisa privadas",
  "settings.searchModel.appleName": "Modelo no dispositivo da Apple",
  "settings.searchModel.appleHint":
    "O texto fica neste Mac: nada para baixar, sem chave, nada enviado para a nuvem. Ele lê cerca de {k}k tokens por vez, então textos longos são ignorados. Se não conseguir responder, essa tarefa é ignorada. Nunca recorre a um modelo na nuvem.",
  "settings.searchModel.apple.why.off":
    "O Apple Intelligence está desativado. Ative nos Ajustes do Sistema, em Apple Intelligence e Siri.",
  "settings.searchModel.apple.why.os": "Este Mac precisa do macOS 26 ou posterior.",
  "settings.searchModel.apple.why.device":
    "Este Mac ou esta região não oferece suporte ao Apple Intelligence.",
  "settings.searchModel.apple.why.notReady":
    "A Apple ainda está preparando o modelo. Tente novamente daqui a pouco.",
  "settings.searchModel.apple.why.unknown": "O modelo não está disponível agora.",
  "settings.searchModel.apple.whySkipped": "Até lá, essas tarefas são ignoradas.",
  "settings.searchModel.apple.host":
    "Este é um ajuste de {host}. O modelo roda em {host}, não neste computador, e a mudança vale para todas as janelas.",
  "settings.searchModel.apple.ready": "Pronto neste Mac",
  "settings.searchModel.apple.needsAi": "Precisa do Apple Intelligence",
  "settings.searchModel.apple.notReady": "Preparando",
  "settings.searchModel.apple.notOnThisMac": "Indisponível neste Mac",
  "settings.searchModel.apple.unavailable": "Indisponível agora",
  "settings.search.advancedHint": "Qual modelo lê suas perguntas",
  "settings.search.description":
    "O que o Psyche indexa para encontrar coisas para você, e qual mecanismo usa na web.",
  "settings.nav.specialists": "Especialistas",
  "settings.nav.notifications": "Notificações",
  "settings.nav.people": "Pessoas e privacidade",
  "settings.key.appearance.showInDock": "Mostrar no Dock quando não há janelas abertas",
  "settings.key.appearance.openAtLogin": "Abrir o Psyche ao iniciar a sessão",
  "settings.key.browser.useSignedInSessions": "Usar minhas sessões iniciadas",
  "settings.key.exec.srtPath": "Local do srt",
  "settings.key.search.model.engine": "Modelo para a pesquisa",
  "settings.key.search.semantic.enabled": "Pesquisa semântica (no dispositivo)",
  "settings.key.search.cards.enabled": "Cartões de contexto para a pesquisa",
  "settings.semanticSearch.cardsHint":
    "Um modelo pequeno na nuvem escreve um resumo curto de cada item salvo. Limitado a cerca de 200.000 tokens por dia.",
  "settings.key.search.encrypt": "Criptografar o índice de pesquisa",
  "settings.semanticSearch.encryptHint":
    "Mantém o índice de pesquisa ilegível sem uma chave guardada separadamente. Vale a partir da próxima inicialização e reconstrói o índice uma vez.",
  "settings.semanticSearch.encrypt.on": "Índice criptografado",
  "settings.semanticSearch.encrypt.pending":
    "Aguardando o auxiliar do Mac abrir o índice criptografado",
  "settings.semanticSearch.encrypt.unavailable": "Não criptografado: {why}",
  "settings.key.search.rerank.enabled":
    "Reordenar os melhores resultados com um modelo pequeno na nuvem",
  "settings.semanticSearch.rerankHint":
    "Um modelo pequeno na nuvem coloca os melhores resultados primeiro. Os 20 trechos principais saem deste Mac. Desativado por padrão.",
  "settings.key.search.runOnBattery": "Indexar na bateria",
  "settings.key.search.queryModel.enabled": "Ler as perguntas com um modelo pequeno",
  "settings.semanticSearch.queryModelHint":
    "Um modelo pequeno na nuvem deduz os filtros de tempo, pessoa e fonte. Só a pergunta é enviada, nunca os seus itens.",
  "settings.key.search.semantic.engine": "Mecanismo de embeddings",
  "settings.key.search.semantic.allowCloud": "Permitir um serviço de embeddings na nuvem",
  "settings.key.memory.recall.mode": "Como a memória é recuperada",
  "settings.key.widgets.remoteImages": "Imagens remotas nos widgets",
  "settings.key.ui.map.tiles": "Blocos do mapa",
  "settings.key.ui.map.styleUrl": "URL do estilo do mapa",
  "settings.key.ui.map.styleUrlDark": "URL do estilo do mapa (escuro)",
  "settings.key.teaching.enabled": "Aprender com o seu feedback",
  "settings.key.teaching.implicit": "Observar edições, desfazeres e dispensas",
  "settings.key.teaching.paused": "Pausar o aprendizado",
  "settings.key.teaching.weeklyCard": "Cartão semanal “O que aprendi”",
  "settings.key.memory.graph": "Pessoas e projetos",
  "settings.key.memory.everything": "Memória em segundo plano",
  "settings.key.agent.showReasoning": "Mostrar o raciocínio enquanto trabalha",
  "settings.key.data.reasoningRetentionDays": "Guardar o raciocínio por",
  "settings.key.notifications.quietHours.enabled": "Horário de silêncio",
  "settings.key.notifications.quietHours.start": "Silêncio a partir das",
  "settings.key.notifications.quietHours.end": "Silêncio até as",
  "settings.notifications.title": "Notificações",
  "settings.notifications.description": "Quando o Psyche pode interromper você.",
  "settings.notifications.group.quietHours": "Horário de silêncio",
  "settings.notifications.quietHours.hint":
    "Retém as notificações até o horário terminar. Aprovações urgentes continuam chegando.",
  "settings.key.ui.onboarding.progress": "Progresso da introdução",
  "settings.key.permissions.liftedFloors": "Ações permitidas sem perguntar para {id}",
  "settings.key.specialists.maxConcurrent": "Especialistas ao mesmo tempo",
  "settings.key.specialists.monthlyCapUsd": "Gasto mensal com especialistas",
  "settings.key.specialists.showInFeed": "Mostrar resultados dos especialistas no Feed",
  "settings.key.specialists.enabled": "{role} ativado",
  "settings.key.specialists.model": "Modelo de {role}",
  "settings.key.specialists.budget": "Orçamento de {role}",
  "settings.key.specialists.maxMode": "Modo de permissão de {role}",
  "settings.credentials.payments.description":
    "Um cartão de uso único, depois que você aprova cada compra. Os números do cartão nunca chegam ao Psyche.",
  "settings.approval.presenceUnavailable":
    "Esta janela não consegue confirmar que é você. Aprove a mudança no app Psyche do seu Mac (Touch ID) ou de um dispositivo com chave-senha. Nada muda até lá.",
  "settings.doctor.gateway": "Gateway",
  "settings.doctor.gatewayOk": "Respondendo.",
  "settings.doctor.model": "Modelo",
  "settings.doctor.noModel": "Nenhum modelo escolhido ainda. Adicione um em Ajustes → Modelos.",
  "settings.doctor.sandbox": "Sandbox",
  "settings.doctor.noSandbox":
    "Nenhuma sandbox disponível, então os comandos continuam bloqueados.",
  "settings.doctor.memory": "Memória",
  "settings.doctor.memoryPaused": "A memória está pausada: nada novo é lembrado.",
  "settings.doctor.memoryOk": "{files, plural, one {# arquivo} other {# arquivos}} na memória.",
  "settings.appearance.description": "Vale para todos os dispositivos que você emparelhou.",
  "settings.appearance.colors": "Cores",
  "settings.appearance.colorsHint": "Claro ou escuro, e sua cor de destaque.",
  "settings.appearance.comfort": "Conforto",
  "settings.appearance.comfortHint": "Mais suave para os olhos e com menos movimento.",
  "settings.appearance.backgroundHint":
    "Se o Psyche continua em execução quando você fecha a janela.",
  "settings.appearance.advancedHint":
    "Tom de cinza, cor personalizada, direção do texto, verificação de contraste",
  "settings.appearance.fineTune": "Ajuste fino das cores",
  "settings.appearance.fineTuneHint": "Para quem quer uma aparência exata.",
  "settings.appearance.contrastCheck": "Verificação de contraste",
  "settings.appearance.contrastCheckHint": "Quão legível é cada tema, passo a passo.",
  "settings.appearance.background": "Segundo plano",
  "settings.appearance.showInDockHint":
    "Desativado, o Psyche continua em execução pela barra de menus quando a última janela é fechada.",
  "settings.appearance.openAtLoginHint":
    "Inicia o Psyche na barra de menus quando você entra, para que as automações agendadas sempre possam ser executadas.",
  "settings.appearance.glass.hint":
    "Deixa o conteúdo aparecer através de menus, popovers e do campo de mensagem.",
  "settings.browser.description":
    "{persona} navega em sua própria janela. O modo Chrome real usa um perfil separado no qual você entra uma vez.",
  "settings.browser.signedIn.title": "Sites com sessão iniciada",
  "settings.browser.signedIn.description":
    "Sites nos quais você iniciou sessão no navegador do Psyche. As tarefas reutilizam esses logins.",
  "settings.browser.signedIn.auto": "encontrado automaticamente",
  "settings.browser.useSignedIn.title": "Sessões iniciadas",
  "settings.browser.useSignedIn.description":
    "{persona} continua usando seu login no mesmo site. Gravar, comprar e enviar continuam perguntando antes.",
  "settings.browser.useSignedIn.label": "Deixar o Psyche usar minhas sessões iniciadas",
  "settings.browser.useSignedIn.hint":
    "Ativado por padrão. Desativado abre cada site sem sessão, exceto os que você escolheu manter com sessão iniciada.",
  "settings.browser.signedIn.none": "Ainda não há sites com sessão iniciada.",
  "settings.browser.signedIn.viaHosts": "Também com sessão iniciada por meio de {hosts}",
  "settings.browser.signedIn.forget": "Sair / esquecer",
  "settings.browser.signedIn.loadFailed":
    "O Psyche não conseguiu listar os sites com sessão iniciada ({reason}).",
  "settings.browser.signedIn.forgetFailed":
    "O Psyche não conseguiu encerrar a sessão em {site} ({reason}).",
  "settings.computerUse.appsHint": "Até onde o Psyche pode ir em cada app.",
  "settings.connectors.catalog.appleShortcuts": "Atalhos",
  "settings.connectors.catalog.obsidian": "Obsidian",
  "settings.connectors.trust.verified": "verificado",
  "settings.connectors.filter.label": "Mostrar",
  "settings.connectors.filter.all": "Todos",
  "settings.connectors.filter.apps": "Apps",
  "settings.connectors.filter.mcp": "Servidores MCP",
  "settings.connectors.configureFailed":
    "O Psyche não conseguiu salvar os ajustes de {name}: {reason}",
  "settings.shortcuts.title": "Seus atalhos",
  "settings.shortcuts.loading": "Lendo seus atalhos deste Mac…",
  "settings.shortcuts.none": "Ainda não há atalhos no app Atalhos.",
  "settings.shortcuts.noHelper":
    "Abra o Psyche no seu Mac para ver seus atalhos: o auxiliar os lê.",
  "settings.shortcuts.failed": "O Psyche não conseguiu ler seus atalhos.",
  "settings.shortcuts.hint":
    "Desativado: nunca executa. Perguntar: um cartão a cada vez. Permitir: executa sem perguntar, só para atalhos que apenas leem.",
  "settings.shortcuts.rule.off": "Desativado",
  "settings.shortcuts.rule.ask": "Perguntar",
  "settings.shortcuts.rule.allow": "Permitir",
  "settings.shortcuts.actions": "Ações do Psyche",
  "settings.shortcuts.install": "Instalar",
  "settings.shortcuts.installNamed": "Instalar {name}",
  "settings.shortcuts.installed": "Instalado",
  "settings.trusted.title.reminders": "Suas listas do Lembretes",
  "settings.trusted.title.notes": "Suas pastas do Notas",
  "settings.trusted.title.calendar": "Seus calendários",
  "settings.trusted.none.reminders": "Ainda não há listas no Lembretes.",
  "settings.trusted.none.notes": "Ainda não há pastas no Notas.",
  "settings.trusted.none.calendar": "Ainda não há calendários.",
  "settings.trusted.loading": "Lendo-os deste Mac…",
  "settings.trusted.noHelper": "Abra o Psyche no seu Mac para vê-los: o auxiliar os lê.",
  "settings.trusted.failed": "O Psyche não conseguiu lê-los neste Mac.",
  "settings.trusted.toggle": "Minha: tratar como confiável",
  "settings.trusted.shared": "Compartilhada",
  "settings.trusted.hint":
    "Ler dela não fará o chat perguntar de novo. Ative só para listas que ninguém mais possa editar.",
  "settings.obsidian.vault": "Pasta do cofre",
  "settings.obsidian.newVault": "Pasta do novo cofre",
  "settings.obsidian.noVault": "Nenhum cofre escolhido",
  "settings.obsidian.vaultHint":
    "O Psyche lê o cofre por meio de uma pasta compartilhada (Ajustes → Permissões → Acesso): compartilhe-a e depois use-a.",
  "settings.obsidian.share": "Compartilhar esta pasta",
  "settings.obsidian.shared": "Compartilhada",
  "settings.obsidian.useVault": "Usar este cofre",
  "settings.obsidian.change": "Trocar de cofre…",
  "settings.obsidian.daily": "Pasta de notas diárias",
  "settings.obsidian.dailyPlaceholder": "Dos ajustes de notas diárias do Obsidian",
  "settings.connectors.can.title": "O que {persona} pode fazer",
  "settings.connectors.can.label": "O que {persona} pode fazer com {name}",
  "settings.connectors.can.alwaysAsks": "Sempre pergunta antes",
};
