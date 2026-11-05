import type { Catalogue } from "../../index.ts";

/** settings-b strings (pt); merged into `../pt.ts`. */
export const settingsB: Partial<Catalogue> = {
  "settings.connectors.can.asksByDefault": "Pregunta antes, a menos que você permita",
  "settings.connectors.can.lifted": "Executa sem perguntar",
  "settings.connectors.can.liftWhat": "{action} em {name}",
  "settings.connectors.can.readOnly":
    "Desativado enquanto {name} está conectado somente para leitura",
  "settings.connectors.can.mail.read.title": "Ler e-mails",
  "settings.connectors.can.mail.read.lines":
    "Ler e pesquisar e-mails, inclusive os não lidos · Ver contagens de não lidos por caixa · Usar o e-mail que você selecionou",
  "settings.connectors.can.mail.draft.title": "Redigir e-mails",
  "settings.connectors.can.mail.draft.lines":
    "Redigir novos e-mails, respostas e encaminhamentos (salvos, não enviados)",
  "settings.connectors.can.mail.organize.title": "Organizar e-mails",
  "settings.connectors.can.mail.organize.lines":
    "Marcar como lido, sinalizar, arquivar e mover · Salvar anexos",
  "settings.connectors.can.mail.send.title": "Enviar e-mails",
  "settings.connectors.can.mail.send.lines": "Enviar e-mails e rascunhos salvos",
  "settings.connectors.can.notes.read.title": "Ler notas",
  "settings.connectors.can.notes.read.lines": "Encontrar, listar e ler notas e pastas",
  "settings.connectors.can.notes.create.title": "Escrever notas",
  "settings.connectors.can.notes.create.lines": "Criar notas e acrescentar conteúdo",
  "settings.connectors.can.reminders.read.title": "Ler lembretes",
  "settings.connectors.can.reminders.read.lines": "Ver o que vence, está atrasado e sinalizado",
  "settings.connectors.can.reminders.write.title": "Alterar lembretes",
  "settings.connectors.can.reminders.write.lines": "Adicionar, concluir e sinalizar lembretes",
  "settings.connectors.can.calendar.read.title": "Ler seu calendário",
  "settings.connectors.can.calendar.read.lines":
    "Ver eventos, participantes e links de reuniões · Encontrar horários livres",
  "settings.connectors.can.calendar.write.title": "Alterar seu calendário",
  "settings.connectors.can.calendar.write.lines": "Adicionar, mover e alterar eventos",
  "settings.connectors.grant.allowed":
    "Permitido nos Ajustes do Sistema → Privacidade e Segurança → {grant}",
  "settings.connectors.grant.automation": "Automação → {app}",
  "settings.connectors.grant.calendars": "Calendários",
  "settings.connectors.grant.reminders": "Lembretes",
  "settings.connectors.grant.contacts": "Contatos",
  "settings.connectors.grant.photos": "Fotos",
  "settings.connectors.app.mail": "Mail",
  "settings.connectors.app.notes": "Notas",
  "settings.connectors.app.music": "Música",
  "settings.connectors.app.safari": "Safari",
  "settings.connectors.app.chrome": "Google Chrome",
  "settings.connectors.app.things": "Things",
  "settings.connectors.app.shortcuts": "Atalhos",
  "settings.connectors.try.title": "Experimente",
  "settings.connectors.try.mail.unread": "O que não foi lido hoje?",
  "settings.connectors.try.mail.reminder": "Crie um lembrete a partir do e-mail que selecionei",
  "settings.connectors.try.mail.reply": "Redija uma resposta ao último e-mail da Dana",
  "settings.connectors.try.notes.find": "Encontre minha nota sobre o offsite",
  "settings.connectors.try.notes.append": "Adicione as decisões de hoje à minha nota do offsite",
  "settings.connectors.try.reminders.due": "O que vence hoje?",
  "settings.connectors.try.reminders.add": "Lembre-me de ligar para o dentista amanhã às 9h",
  "settings.connectors.try.calendar.today": "O que tenho no calendário hoje?",
  "settings.connectors.try.calendar.focus": "Reserve duas horas para foco amanhã de manhã",
  "settings.connectors.actionFailed":
    "O Psyche não conseguiu alterar {name} ({reason}). Nada mudou.",
  "settings.mcp.badge": "MCP",
  "settings.mcp.showDetails": "Mostrar detalhes",
  "settings.mcp.hideDetails": "Ocultar detalhes",
  "settings.sandbox.setUp": "Configurar a sandbox",
  "settings.mcp.sandboxHelp": "Servidores de comando precisam de uma sandbox neste Mac.",
  "settings.sandbox.title": "Configurar a sandbox",
  "settings.sandbox.why":
    "Os comandos rodam no seu Mac com seus arquivos, mas não podem ler seu cofre, suas chaves nem os dados privados do Psyche.",
  "settings.sandbox.whyHow":
    "Usa o srt, o runtime de sandbox da Anthropic, sobre a própria sandbox do macOS. Não precisa de máquina virtual.",
  "settings.sandbox.privacy":
    "O Psyche não instala nada por conta própria. Você executa cada etapa abaixo, ou abre o download você mesmo.",
  "settings.sandbox.checking": "Examinando este Mac…",
  "settings.sandbox.checkAgain": "Verificar novamente",
  "settings.sandbox.done": "Pronto",
  "settings.sandbox.copy": "Copiar",
  "settings.sandbox.copied": "Copiado",
  "settings.sandbox.ready": "Pronto",
  "settings.sandbox.srt.ready":
    "O srt está configurado em {path}. É possível adicionar servidores de comando.",
  "settings.sandbox.srt.missing.title": "Instalar o srt",
  "settings.sandbox.srt.missing.body":
    "O srt vem do npm. Se o comando pedir permissão para gravar, execute-o com os direitos da sua própria conta; o Psyche nunca o executa por você.",
  "settings.sandbox.srt.install": "Instale com o npm",
  "settings.sandbox.srt.link": "Ler sobre o srt no GitHub",
  "settings.sandbox.srt.thenCheck": "Depois verifique novamente",
  "settings.sandbox.srt.thenCheckBody":
    "O Psyche encontra o srt no seu PATH, nas pastas do Homebrew e do npm, sem reiniciar.",
  "settings.sandbox.srt.broken":
    "Não é possível usar o srt em {path}: {problem, select, not_absolute {o caminho deve começar com /} not_executable {não há nenhum programa executável ali} other {não foi encontrado}}.",
  "settings.sandbox.srt.fromEnv":
    "PSYCHE_SRT_PATH define este local, então não pode ser alterado aqui.",
  "settings.sandbox.srt.installButton": "Instalar com o Psyche",
  "settings.sandbox.srt.reinstallButton": "Reinstalar",
  "settings.sandbox.srt.updateButton": "Atualizar o srt",
  "settings.sandbox.srt.installOr": "Ou deixe o Psyche instalar para você",
  "settings.sandbox.srt.installConfirm.title": "Instalar o srt {version}?",
  "settings.sandbox.srt.installConfirm.body":
    "O Psyche vai baixar {package} {version} e suas dependências do registro do npm (registry.npmjs.org), conferir cada arquivo com um checksum embutido nesta versão do Psyche e descompactá-los com o próprio Node. Nada é instalado no sistema todo, nenhum script de instalação é executado e nenhuma senha é necessária.",
  "settings.sandbox.srt.installConfirm.where": "Será colocado em {dir}",
  "settings.sandbox.srt.installConfirm.go": "Instalar",
  "settings.sandbox.srt.installConfirm.cancel": "Cancelar",
  "settings.sandbox.srt.installing": "Instalando o srt…",
  "settings.sandbox.srt.installed": "Instalado pelo Psyche: srt {version}.",
  "settings.sandbox.srt.installFailed": "Não foi possível instalar o srt: {reason}",
  "settings.sandbox.srt.updateAvailable":
    "Esta versão do Psyche inclui um srt mais recente ({version}); {installed} está instalado.",
  "settings.sandbox.srt.choose": "O srt está em outro lugar",
  "settings.sandbox.srt.path": "Caminho completo do srt",
  "settings.sandbox.srt.use": "Usar este srt",
  "settings.sandbox.srt.useHint":
    "Ao salvar, você precisa confirmar neste dispositivo, porque isso decide o que executa seus comandos.",
  "settings.sandbox.containers.title": "Isolamento mais forte (opcional)",
  "settings.sandbox.containers.body":
    "Um runtime de contêineres executa o código em sua própria máquina Linux, sem acesso aos arquivos do seu Mac: para o código que o agente executa e algumas conversões de arquivos. Os servidores de comando continuam usando o srt, a menos que o Gateway esteja configurado para usar contêineres.",
  "settings.sandbox.containers.ready": "{runtime} está em execução.",
  "settings.sandbox.runtime.appleContainer": "Apple container",
  "settings.sandbox.runtime.docker": "Docker",
  "settings.sandbox.runtime.podman": "Podman",
  "settings.sandbox.missing.title": "Instalar {runtime}",
  "settings.sandbox.missing.appleContainer":
    "O runtime de contêineres da Apple dá a cada sandbox sua própria VM leve. Precisa do macOS 26 em Apple silicon e de um instalador que você aprova com a senha do Mac.",
  "settings.sandbox.missing.docker":
    "Docker via Colima é gratuito e leve; o Docker Desktop é a opção de apontar e clicar.",
  "settings.sandbox.step.download": "Baixe e abra o instalador",
  "settings.sandbox.step.downloadLink": "Abrir as versões do Apple container",
  "settings.sandbox.step.start": "Inicie",
  "settings.sandbox.step.install": "Instale com o Homebrew",
  "settings.sandbox.step.orDesktop": "Ou baixe o Docker Desktop e abra-o uma vez",
  "settings.sandbox.step.desktopLink": "Abrir o download do Docker Desktop",
  "settings.sandbox.stopped.title": "{runtime} está instalado, mas não está em execução",
  "settings.sandbox.stopped.appleContainer":
    "Inicie o serviço do sistema dele e verifique novamente.",
  "settings.sandbox.stopped.docker":
    "Inicie o daemon do Docker (abra o Docker Desktop ou execute o comando abaixo) e verifique novamente.",
  "settings.sandbox.stopped.podman": "Inicie a máquina do Podman e verifique novamente.",
  "settings.sandbox.restart.title": "{runtime} está em execução. Reinicie o Gateway para usá-lo",
  "settings.sandbox.restart.body":
    "O Gateway procurou um runtime de contêineres ao iniciar e não encontrou nenhum. Reinicie-o e ele passará a usar {runtime}.",
  "settings.sandbox.restart.step": "Reiniciar o Gateway",
  "settings.sandbox.without":
    "Sem o srt, o Psyche ainda pode usar servidores por URL e seus conectores, mas não pode executar servidores de comando MCP locais.",
  "settings.mcp.off": "Desativado",
  "settings.mcp.turnedOn": "{name} está ativado.",
  "settings.mcp.turnedOff": "{name} está desativado.",
  "settings.mcp.tools.title": "Ferramentas",
  "settings.mcp.tools.hint":
    "{off, plural, =0 {O Psyche pode usar todas as ferramentas.} one {# ferramenta está fora do alcance do Psyche.} other {# ferramentas estão fora do alcance do Psyche.}} Desativar uma não reinicia o servidor.",
  "settings.mcp.tools.loadFailed": "Não foi possível carregar as ferramentas: {reason}",
  "settings.mcp.tools.off": "Este servidor está desativado. Ative-o para ver as ferramentas dele.",
  "settings.mcp.tools.notConnected":
    "Este servidor não está conectado, então não lista ferramentas.",
  "settings.mcp.tools.none": "Este servidor não tem ferramentas.",
  "settings.mcp.secrets.title": "Segredos",
  "settings.mcp.secrets.intro":
    "Chaves com as quais este servidor inicia. Ficam no seu cofre; o Psyche só mostra se cada uma está definida.",
  "settings.mcp.secrets.loadFailed": "Não foi possível carregar os segredos: {reason}",
  "settings.mcp.secrets.set": "Definido",
  "settings.mcp.secrets.unset": "Não definido",
  "settings.mcp.secrets.replace": "Substituir",
  "settings.mcp.secrets.setIt": "Definir um valor",
  "settings.mcp.secrets.replaceFor": "Substituir {name}",
  "settings.mcp.secrets.plain":
    "Fica nos ajustes do servidor, não no cofre. Ao substituí-lo, ele vai para o cofre.",
  "settings.mcp.secrets.newValue": "Novo valor para {name}",
  "settings.mcp.secrets.hint": "Salvo no seu cofre; depois o servidor reinicia com ele.",
  "settings.mcp.secrets.replaced": "{name} foi substituído. O servidor reinicia com o novo valor.",
  "settings.mcp.danger.title": "Zona de perigo",
  "settings.mcp.danger.disable": "Desativar este servidor",
  "settings.mcp.danger.disableHint":
    "Mantém os ajustes, mas o interrompe. As ferramentas dele somem e as permissões que você deu a elas terminam.",
  "settings.mcp.danger.disableAction": "Desativar",
  "settings.mcp.danger.enable": "Ativar este servidor",
  "settings.mcp.danger.enableHint": "Inicia-o de novo. Os segredos dele pedem a sua aprovação.",
  "settings.mcp.danger.enableAction": "Ativar",
  "settings.mcp.danger.remove": "Remover este servidor",
  "settings.mcp.danger.removeHint": "Exclui os ajustes dele. Os segredos no seu cofre permanecem.",
  "settings.mcp.json.toggle": "Colar JSON",
  "settings.mcp.json.label": "JSON do servidor",
  "settings.mcp.json.hint":
    "O formato usual de mcpServers. Chaves e tokens vão para o seu cofre, não para os ajustes.",
  "settings.mcp.json.fill": "Preencher o formulário",
  "settings.mcp.json.choose": "Qual servidor?",
  "settings.mcp.json.empty": "Cole primeiro o JSON de um servidor.",
  "settings.mcp.json.invalid": "Isso não é um JSON válido.",
  "settings.mcp.json.shape": "Esperava-se um objeto JSON com uma entrada mcpServers.",
  "settings.mcp.json.noServers": "Nenhum servidor com comando ou URL nesse JSON.",
  "settings.mcp.json.secrets":
    "{n, plural, one {# segredo} other {# segredos}} do JSON irão para o seu cofre: {names}.",
  "settings.mcp.json.ignored": "Não transferido: {names}.",
  "settings.searchSources.title": "Fontes de pesquisa",
  "settings.searchSources.description":
    "O que o Psyche lê para o seu índice de pesquisa. Tudo fica desativado até você ativar; o índice permanece neste Mac. Ativar uma fonte também deixa a memória aprender com ela, a menos que você desative em Memória → Fontes (Memória e Contatos são exceções: não se aprende com nenhuma das duas).",
  "settings.searchSources.hint.mail":
    "Assunto, remetente, destinatários, data e texto dos seus e-mails no Apple Mail. Respostas citadas são ignoradas.",
  "settings.searchSources.hint.messages":
    "Suas conversas do iMessage, por chat e dia. Mensagens de outras pessoas nunca são tratadas como instruções.",
  "settings.searchSources.hint.notes": "O título e o texto das suas notas do Apple Notas.",
  "settings.searchSources.hint.calendar":
    "Eventos dos últimos três anos e dos próximos doze meses: título, horário, local, participantes e notas.",
  "settings.searchSources.hint.reminders": "Lembretes e suas listas, datas de vencimento e notas.",
  "settings.searchSources.hint.contacts":
    "Seus Contatos da Apple: nome, apelido, empresa, cargo, e-mails, telefones, cidade e país de cada endereço, e aniversário. Endereços de rua, notas e grupos nunca são lidos. O agente não pode pesquisar até você permitir, e essa chave cobre só este índice: o que a Memória aprendeu sobre pessoas e as páginas delas com e-mails ou números seguem o acesso do agente próprio da Memória.",
  "settings.searchSources.hint.files":
    "Arquivos de texto, código, PDF, Word e Excel em pastas que você compartilhou. Imagens são indexadas pelo nome.",
  "settings.searchSources.hint.browser":
    "Páginas que o navegador do Psyche lê para você, guardadas por 90 dias. Páginas privadas, de login e de pagamento nunca são guardadas.",
  "settings.searchSources.hint.transcripts":
    "Notas de voz e reuniões, separadas por falante. As palavras de outras pessoas nunca são tratadas como instruções.",
  "settings.searchSources.hint.memory":
    "O que o Psyche lembra: suas pessoas, projetos, trabalhos com prazo e eventos, e os fatos que o Psyche aceitou. Fica de fora tudo o que é sensível, ainda aguarda revisão, foi aprendido de uma fonte em que o agente não pode pesquisar ou é mantido privado. A memória não aprende com este índice, e precisa estar ativada.",
  "settings.searchSources.runOnBatteryHint":
    "Permite que a indexação, Reconstruir e a leitura de texto em imagens continuem enquanto o Mac está na bateria, em ritmo mais suave. Gasta mais bateria. O Modo de Pouca Energia ainda pausa a indexação.",
  "settings.searchSources.cannotEnable": "Ainda não pode ser ativado: {why}",
  "settings.searchSources.cannotAgent": "O agente ainda não pode pesquisar aqui: {why}",
  "settings.searchSources.state.off": "Desativado: não é lido",
  "settings.searchSources.state.unavailable": "Ativado, mas indisponível: {why}",
  "settings.searchSources.state.error": "Problema: {why}",
  "settings.searchSources.state.indexing":
    "Indexando: {n, plural, one {# item} other {# itens}} até agora",
  "settings.searchSources.state.idle": "Atualizado: {n, plural, one {# item} other {# itens}}",
  "settings.searchSources.neverIndexed": "Ainda não indexado",
  "settings.searchSources.lastIndexed": "Última indexação {when}",
  "settings.searchSources.rebuild": "Reconstruir",
  "settings.searchSources.rebuildLabel": "Reconstruir {source}",
  "settings.searchSources.rebuilding": "Reconstruindo…",
  "settings.searchSources.rebuild.turnOnFirst": "Ative {source} primeiro",
  "settings.searchSources.rebuild.starting": "Reconstruindo {source}…",
  "settings.searchSources.rebuild.progress":
    "Reconstruindo {source}: {n, plural, one {# item lido} other {# itens lidos}} até agora. Continua em segundo plano.",
  "settings.searchSources.rebuild.done":
    "{source} reconstruído: {n, plural, one {# item} other {# itens}}.",
  "settings.searchSources.rebuild.failed": "Não foi possível reconstruir {source}: {why}",
  "settings.searchSources.agent": "Deixar o agente do Psyche pesquisar aqui",
  "settings.searchSources.agentLabel": "Pesquisa do agente em {source}",
  "settings.searchSources.ocr": "Ler texto em imagens (OCR)",
  "settings.searchSources.ocrHint":
    "Lê capturas de tela e PDFs digitalizados com o Apple Vision, uma página por vez, na tomada (ou na bateria com “Indexar na bateria” ativado). Nada sai do seu Mac.",
  "settings.searchSources.ocrLabel": "Ler texto em imagens de {source}",
  "settings.searchSources.processing": "Processamento",
  "settings.searchSources.processingLabel": "Processamento de {source}",
  "settings.searchSources.processing.cloud": "Modelo na nuvem (atual)",
  "settings.searchSources.processing.local": "Modelo local",
  "settings.searchSources.processing.none": "Nenhum: sem resumos",
  "settings.searchSources.excludeContacts": "Nunca indexar estes contatos",
  "settings.searchSources.excludeContactsHint":
    "Endereços de e-mail, números de telefone ou nomes, separados por vírgulas",
};
