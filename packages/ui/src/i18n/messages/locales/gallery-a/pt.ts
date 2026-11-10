import type { Catalogue } from "../../index.ts";

/** gallery-a strings (pt); merged into `../pt.ts`. */
export const galleryA: Partial<Catalogue> = {
  "gallery.preset.airtable.example":
    "Liste os registros da minha base Projects marcados como bloqueados.",
  "gallery.preset.airtable.field.key.label": "Token de acesso pessoal",
  "gallery.preset.airtable.field.key.help":
    "Crie um token que possa ler as bases que você quer usar.",
  "gallery.preset.fetch.desc": "Busque uma página da web e leia como texto simples.",
  "gallery.preset.fetch.example": "Leia esta página e me dê os três pontos principais.",
  "gallery.preset.fetch.field.sites.label": "Sites que ele pode acessar",
  "gallery.preset.fetch.field.sites.help":
    "Nomes de host separados por vírgulas, como en.wikipedia.org. Se deixar vazio, só poderá acessar o registro de pacotes.",
  "gallery.preset.braveSearch.desc": "Pesquise na web, notícias e imagens com o Brave.",
  "gallery.preset.braveSearch.example":
    "Pesquise as notícias desta semana sobre modelos de IA de código aberto.",
  "gallery.preset.braveSearch.field.key.label": "Chave de API",
  "gallery.preset.braveSearch.field.key.help": "O plano gratuito basta para testar.",
  "gallery.preset.playwright.desc":
    "Controle um navegador separado para ler páginas e preencher formulários.",
  "gallery.preset.playwright.example": "Abra example.com e me diga o que a página diz.",
  "gallery.preset.playwright.field.sites.label": "Sites que ele pode acessar",
  "gallery.preset.playwright.field.sites.help":
    "Nomes de host separados por vírgulas que ele pode abrir. Deixe vazio para mantê-lo offline.",
  "gallery.preset.firecrawl.desc": "Extraia e rastreie sites e converta em texto limpo.",
  "gallery.preset.firecrawl.example":
    "Rastreie o site de documentação de example.com e resuma as seções principais.",
  "gallery.preset.firecrawl.field.key.label": "Chave de API",
  "gallery.preset.firecrawl.field.key.help": "Usada para extrair e rastrear sites para você.",
  "gallery.preset.time.desc": "Veja a hora atual e converta entre fusos horários.",
  "gallery.preset.time.example": "Que horas são em Tóquio quando são 9h em San Francisco?",
  "gallery.preset.homeAssistant.desc":
    "Veja e controle os dispositivos que você expõe no Home Assistant.",
  "gallery.preset.homeAssistant.example": "Quais luzes estão acesas agora?",
  "gallery.preset.homeAssistant.field.url.label": "Endereço do servidor",
  "gallery.preset.homeAssistant.field.url.help":
    "Ative a integração Model Context Protocol Server e copie o endereço dela em Ajustes, Sistema, IA. Deve começar com https://.",
  "gallery.preset.stripe.desc":
    "Consulte clientes, pagamentos e saldos. Somente leitura, definido pela sua chave restrita.",
  "gallery.preset.stripe.example": "Quanto cobrei nos últimos 30 dias?",
  "gallery.preset.stripe.field.key.label": "Chave restrita",
  "gallery.preset.stripe.field.key.help":
    "Crie uma chave restrita (começa com rk_) só com permissão de leitura. Outras chaves são recusadas aqui.",
  "settings.connectors.page.description":
    "Os apps e ferramentas que {persona} pode usar. Cada um pergunta antes de agir, a menos que você diga o contrário.",
  "settings.connectors.page.needsYou": "Precisa de você",
  "settings.connectors.page.connected": "Conectado",
  "settings.connectors.page.onThisMac": "Neste Mac",
  "settings.connectors.page.addMore": "Adicionar mais",
  "settings.connectors.page.addMore.hint":
    "E-mail, calendário, notas e ferramentas prontas. Cada uma pergunta antes de agir.",
  "settings.connectors.page.addMore.browse": "Ver todos",
  "settings.connectors.page.status.paused": "Pausado",
  "settings.connectors.page.status.notWorking": "Não funciona",
  "settings.connectors.page.status.signInExpired": "Sessão expirada",
  "settings.connectors.page.status.on": "Ativado",
  "settings.connectors.page.status.off": "Desativado",
  "settings.connectors.page.paused": "Pausado",
  "settings.connectors.page.open": "Abrir {name}",
  "settings.connectors.page.manage": "Gerenciar",
  "settings.connectors.page.fix.seeWhy": "Ver por quê",
  "settings.connectors.page.row.never": "Ainda não usado",
  "settings.connectors.page.row.lastUsed": "Usado {when}",
  "settings.connectors.page.row.unverified": "Não verificado",
  "settings.connectors.page.row.local": "Roda neste Mac",
  "settings.connectors.page.row.remote": "Conecta pela web",
  "settings.connectors.page.row.files":
    "{count, plural, =0 {Nenhuma pasta compartilhada} one {1 pasta compartilhada} other {# pastas compartilhadas}}",
  "settings.connectors.page.row.terminal.on": "Pode executar comandos",
  "settings.connectors.page.row.terminal.off": "Os comandos estão desativados",
  "settings.connectors.page.detail.label": "Detalhes de {name}",
  "settings.connectors.page.detail.about": "Sobre",
  "settings.connectors.page.detail.access": "Acesso",
  "settings.connectors.page.detail.source": "Origem",
  "settings.connectors.page.detail.technical": "Detalhes técnicos",
  "settings.connectors.page.detail.manage": "Pausar ou remover",
  "settings.connectors.page.detail.type": "Tipo",
  "settings.connectors.page.detail.removeHint":
    "Desconectar o pausa e mantém os ajustes. Remover o exclui.",
  "settings.connectors.page.source.builtIn": "Integrado ao Psyche",
  "settings.connectors.page.source.verified": "Editor verificado",
  "settings.connectors.page.source.unverified": "Ninguém verificou ainda",
  "settings.connectors.page.attention.signIn":
    "Sua sessão com {name} expirou. Entre novamente para que continue funcionando.",
  "settings.connectors.page.attention.error":
    "{name} não está funcionando agora. Tente entrar novamente; se continuar falhando, remova e adicione de volta.",
  "settings.connectors.page.attention.errorReason": "O que ele disse: {reason}",
  "settings.connectors.page.attention.server":
    "{name} não iniciou, então as ferramentas dele não estão disponíveis.",
  "settings.connectors.page.attention.serverHint":
    "Confira o comando ou endereço dele e os segredos abaixo, depois desative e ative novamente.",
  "settings.connectors.page.server.local": "Uma ferramenta que roda em uma sandbox neste Mac",
  "settings.connectors.page.server.remote": "Uma ferramenta que você acessa por endereço web",
  "settings.connectors.page.server.network": "Acessa a rede",
  "settings.connectors.page.server.noNetwork": "Sem rede",
  "settings.connectors.page.advanced": "Avançado",
  "settings.connectors.page.advanced.hint":
    "Seus próprios servidores de ferramentas e uma pesquisa no registro público.",
  "settings.connectors.page.advanced.custom": "Seu próprio servidor de ferramentas",
  "settings.connectors.page.advanced.customHint":
    "Execute qualquer servidor MCP na sandbox ou conecte-se a um por endereço web.",
  "settings.connectors.page.advanced.customAction": "Adicionar servidor",
  "settings.connectors.page.advanced.find": "Encontrar servidores online",
  "settings.connectors.page.gallery.title": "Adicionar um conector",
  "settings.connectors.page.gallery.intro":
    "Escolha algo para testar. Cada um pergunta antes de fazer qualquer coisa, e você pode removê-lo quando quiser.",
  "settings.connectors.page.gallery.noMatch": "Nada corresponde. Tente outra palavra.",
  "settings.connectors.page.gallery.back": "Voltar à galeria",
  "settings.connectors.page.gallery.community": "Comunidade",
  "onboarding.stepCount": "{n, number} de {total, number}",
  "onboarding.connectors.onThisMac": "Neste Mac",
  "onboarding.connectors.onThisMacHint":
    "Cada app pede permissão ao macOS ao conectar, uma de cada vez.",
  "onboarding.connectors.connectApps":
    "{n, plural, =0 {Conectar apps} one {Conectar # app} other {Conectar # apps}}",
  "onboarding.connectors.connecting": "Conectando {name}",
  "onboarding.connectors.accounts": "Contas",
  "onboarding.step.memory": "Memória e hábitos diários",
  "onboarding.about.lead":
    "Alguns fatos para o Psyche já começar conhecendo você. Tudo é opcional e fica em USER.md, que você pode editar quando quiser.",
  "onboarding.about.name": "Seu nome",
  "onboarding.about.nameHint": "Como o Psyche deve chamar você?",
  "onboarding.about.timeZone": "Fuso horário",
  "onboarding.about.timeZoneHint": "America/Sao_Paulo",
  "onboarding.about.work": "Trabalho ou estudos",
  "onboarding.about.workHint": "O que você faz, em poucas palavras",
  "onboarding.about.city": "Cidade onde mora",
  "onboarding.about.cityHint": "Onde você costuma estar",
  "onboarding.memory.lead":
    "Já tem um perfil no ChatGPT ou no Claude? Cole a exportação de memória dele ou a resposta a “O que você sabe sobre mim?”. Você revisa tudo antes de salvar.",
  "onboarding.memory.unavailable":
    "Importar não está disponível nesta janela. Você pode fazer isso depois em Alma.",
  "onboarding.memory.format": "De onde vem",
  "onboarding.memory.format.chatgpt": "ChatGPT",
  "onboarding.memory.format.claude": "Claude",
  "onboarding.memory.format.text": "Outro texto",
  "onboarding.memory.paste": "Texto da memória",
  "onboarding.memory.placeholder": "Cole aqui, ou envie um arquivo .txt, .md ou .json",
  "onboarding.memory.upload": "Enviar um arquivo",
  "onboarding.memory.review": "Revisar",
  "onboarding.memory.found":
    "Encontrados {n, number} itens para revisar ({skipped, number} ignorados). Desmarque o que não quiser guardar.",
  "onboarding.memory.items": "Itens a importar",
  "onboarding.memory.flagged": "Parece uma instrução",
  "onboarding.memory.edit": "Voltar ao texto",
  "onboarding.memory.save": "Salvar {n, number} na memória",
  "onboarding.memory.saved": "{n, number} itens salvos na memória.",
  "onboarding.memory.failed": "Isso não funcionou ({reason}).",
  "onboarding.habits.lead":
    "Cartões curtos no Início, de manhã e à noite. O Psyche só lê; nada é enviado sem a sua aprovação.",
  "onboarding.habits.brief": "Resumo diário",
  "onboarding.habits.briefHint": "Seu dia, toda manhã de dia útil.",
  "onboarding.habits.wrapup": "Fechamento da noite",
  "onboarding.habits.wrapupHint": "O que foi feito e o que passa para amanhã.",
  "onboarding.habits.followups": "Acompanhamento de pendências",
  "onboarding.habits.followupsHint": "Detecta as respostas que você ainda está esperando.",
  "onboarding.rerun.title": "Configurar novamente",
  "onboarding.rerun.description":
    "Percorra de novo a configuração inicial. As etapas já concluídas são ignoradas.",
  "onboarding.rerun.button": "Executar a configuração novamente",
  "onboarding.step.you": "Você e seu agente",
  "onboarding.step.stuff": "Suas coisas",
  "onboarding.step.safety": "Segurança",
  "onboarding.you.lead": "Tudo nesta página é opcional e você pode mudar depois.",
  "onboarding.you.agent": "Seu agente",
  "onboarding.you.customize": "Personalizar a aparência",
  "onboarding.you.more": "Mais sobre você",
  "onboarding.memory.habitsLead":
    "Escolha o que {name} faz a cada dia e o que guarda na memória. Tudo pode ser alterado nos Ajustes.",
  "onboarding.memory.bring": "Trazer a memória do ChatGPT ou do Claude",
  "onboarding.habits.title": "Todo dia",
  "onboarding.work.title": "Trabalho e tarefas",
  "onboarding.work.hint":
    "Mantém uma tarefa para tudo que tenha prazo: contas, aluguel, impostos, renovações, prazos de trabalho, lição de casa. {persona} lê só as listas e pastas que você escolher. Desativado até você dizer que sim.",
  "onboarding.work.remindHint":
    "Enviado com o seu fechamento da noite. Os títulos só aparecem para o que você mesmo adicionou.",
  "onboarding.work.later":
    "Escolha quais listas e pastas do Lembretes contam em Ajustes → Memória → Trabalho.",
  "onboarding.people.title": "Pessoas",
  "onboarding.people.label": "Incluir pessoas no meu resumo",
  "onboarding.people.hint":
    "Fatos sobre as pessoas que você conhece e com quem manter contato. Desativado, a menos que você ative.",
  "onboarding.people.needsBrief":
    "O resumo da manhã está desativado, então as pessoas ainda não vão aparecer. Ative para vê-las.",
  "onboarding.safety.lead":
    "Como as aprovações chegam até você e o que roda sozinho. O acesso aos seus arquivos, apps e tela não é pedido aqui: {name} pede no chat na primeira vez que precisar.",
  "onboarding.safety.touchId": "Touch ID para pagamentos",
  "onboarding.safety.touchId.checking": "Examinando o auxiliar do Mac…",
  "onboarding.safety.touchId.again": "Verificar novamente",
  "onboarding.safety.touchId.set": "Configurar",
  "onboarding.safety.touchId.setHint": "Os pagamentos pedem sua digital ou a senha do seu Mac.",
  "onboarding.safety.touchId.starting":
    "O auxiliar do Mac ainda está iniciando. Verifique novamente em instantes.",
  "onboarding.safety.touchId.noKey": "O auxiliar do Mac não tem chave do Touch ID ({reason}).",
  "onboarding.safety.touchId.register": "Registrar esta chave",
  "onboarding.safety.touchId.hint":
    "Registre uma vez a chave do auxiliar do Mac para que o Touch ID possa confirmar pagamentos.",
  "onboarding.safety.notifications": "Notificações",
  "onboarding.safety.asks":
    "Se você deixar {name} executar comandos neste Mac, os que só leem, como ls ou cat, rodam sem cartão. Todo o resto pergunta antes.",
  "onboarding.safety.sandbox": "Configurar uma sandbox para os comandos",
  "onboarding.safety.optional": "Opcional",
  "onboarding.done.on": "Ativado",
  "onboarding.done.off": "Desativado",
  "onboarding.done.daily": "Diário",
  "onboarding.done.work": "Acompanhamento do trabalho",
  "onboarding.done.people": "Pessoas no seu resumo",
  "onboarding.done.touchId": "Touch ID",
  "onboarding.done.touchIdSet": "Chave registrada",
  "onboarding.done.touchIdNot": "Ainda não registrada",
  "onboarding.done.modelKept": "Sem alterações",
  "onboarding.done.try": "Teste a seguir",
  "onboarding.done.try.search":
    "Faça uma pergunta em Pesquisar (⌘K). A resposta mostra de onde na sua vida ela veio.",
  "onboarding.done.try.home":
    "Abra o Início. “Para se atualizar” lista o que você pode ter deixado passar.",
  "onboarding.done.try.canDo":
    "Abra “O que você pode fazer?” no menu da engrenagem para ver tarefas prontas.",
  "capabilities.title": "O que você pode fazer?",
  "capabilities.lead":
    "Coisas para testar agora. Os cartões que precisam de uma conta ficam disponíveis quando ela está conectada.",
  "capabilities.available": "Pronto para testar",
  "capabilities.locked": "Conecte para desbloquear",
  "capabilities.connect": "Conectar contas",
  "capabilities.try": "Teste: {prompt}",
  "capabilities.addAutomation": "Adicionar: {name}",
  "capabilities.automationAdded": "Adicionado: {name}",
  "capabilities.automationFailed": "Não foi possível adicionar essa automação ({reason}).",
  "capabilities.open": "O que você pode fazer?",
  "capabilities.openHint": "Veja o que o Psyche pode fazer",
  "capabilities.brief.title": "Planeje meu dia",
  "capabilities.brief.desc": "Resumo da manhã com seu calendário, e-mails e lembretes.",
  "capabilities.brief.prompt1": "Me dê um resumo de hoje.",
  "capabilities.brief.prompt2": "No que devo me concentrar esta semana?",
  "capabilities.brief.auto": "Resumo da manhã às 7h30 nos dias úteis",
  "capabilities.meetings.title": "Prepare minhas reuniões",
  "capabilities.meetings.desc": "Quem estará lá, o que foi dito da última vez, o que perguntar.",
  "capabilities.meetings.prompt1": "Prepare-me para a minha próxima reunião.",
  "capabilities.meetings.prompt2": "Quais reuniões de hoje precisam de preparação?",
  "capabilities.inbox.title": "Faça a triagem da minha caixa de entrada",
  "capabilities.inbox.desc":
    "Separe o que precisa de resposta, o que pode esperar e o que ignorar.",
  "capabilities.inbox.prompt1": "Faça a triagem da minha caixa de entrada.",
  "capabilities.inbox.prompt2": "Redija respostas aos três e-mails mais urgentes.",
  "capabilities.inbox.auto": "Triagem da caixa de entrada às 8h nos dias úteis",
  "capabilities.reminders.title": "Lembretes e tarefas",
  "capabilities.reminders.desc": "Adicione, mova e revise lembretes em linguagem natural.",
  "capabilities.reminders.prompt1": "Lembre-me de ligar para o dentista na sexta.",
};
