import type { Catalogue } from "../../index.ts";

/** settings-c strings (pt); merged into `../pt.ts`. */
export const settingsC: Partial<Catalogue> = {
  "settings.searchSources.excludeFolders": "Nunca indexar estas pastas",
  "settings.searchSources.excludeFoldersPlaceholder": "~/Documents/Private",
  "settings.searchSources.indexSize": "Tamanho do índice de pesquisa: {size}",
  "settings.semanticSearch.title": "Pesquisa por significado",
  "settings.semanticSearch.description":
    "Encontre coisas pelo significado além das palavras, tudo neste Mac.",
  "settings.semanticSearch.enabledHint":
    "Baixa um modelo de 118 MB na primeira vez. Ao desativar, o índice de significados é excluído.",
  "settings.semanticSearch.engine.builtin": "Modelo integrado",
  "settings.semanticSearch.engine.builtinHint":
    "Multilingual E5 small, cerca de 100 idiomas, roda no processador deste Mac.",
  "settings.semanticSearch.engine.router": "Meu servidor de modelos local",
  "settings.semanticSearch.engine.routerHint":
    "Usa o modelo de embeddings definido em Funções, por exemplo Ollama ou LM Studio neste Mac.",
  "settings.semanticSearch.state.off": "Desativado: a pesquisa compara palavras",
  "settings.semanticSearch.state.starting": "Iniciando…",
  "settings.semanticSearch.state.downloading": "Baixando o modelo: {received} de {total} MB",
  "settings.semanticSearch.state.indexing": "Indexando significados: {done} de {total}",
  "settings.semanticSearch.state.ready":
    "Ativado: {n, plural, one {# trecho indexado} other {# trechos indexados}}",
  "settings.semanticSearch.state.readyCloud":
    "Ativado, com um serviço na nuvem: {n, plural, one {# trecho indexado} other {# trechos indexados}}",
  "settings.semanticSearch.allowCloudHint":
    "Só se o modelo de embeddings for um serviço na nuvem. Seus chats, tarefas e o texto da Biblioteca são enviados a ele. Desativado mantém tudo neste Mac.",
  "settings.semanticSearch.state.noModel":
    "Nenhum modelo de embeddings definido em Funções. Escolha um ou use o modelo integrado.",
  "settings.semanticSearch.state.cloudBlocked":
    "O modelo de embeddings em Funções é um serviço na nuvem. A pesquisa semântica só usa modelos deste Mac.",
  "settings.semanticSearch.state.error": "Parado: {reason}",
  "settings.webSearch.description":
    "Como o agente pesquisa coisas na web. Páginas da web nunca são tratadas como instruções suas.",
  "settings.data.description":
    "Tudo o que {persona} guarda fica neste computador. Nada é enviado para treinamento.",
  "settings.data.advancedHint": "Mapas e imagens nos widgets",
  "settings.data.keep": "Por quanto tempo é guardado",
  "settings.data.keepHint":
    "Raciocínios e reproduções de tarefas mais antigos são excluídos automaticamente.",
  "settings.data.danger": "Excluir e recomeçar do zero",
  "settings.memoryControls.title": "Básico",
  "settings.memoryControls.description":
    "Escolha o que {persona} lembra e de onde aprende. Cada opção pode ser desativada a qualquer momento.",
  "settings.learning.title": "Aprender com o feedback",
  "settings.learning.implicit": "Observar edições, desfazeres e dispensas",
  "settings.learning.implicitHint":
    "Enviar um rascunho editado ou desfazer uma ação conta como feedback.",
  "settings.learning.signals": "Sinais",
  "settings.learning.signal.draftEdits": "Edições de rascunhos",
  "settings.learning.signal.undo": "Desfazer",
  "settings.learning.signal.approvalEdits": "Edições de aprovações",
  "settings.learning.signal.dismissals": "Dispensas",
  "settings.learning.paused": "Pausar o aprendizado",
  "settings.learning.pausedHint":
    "Enquanto ativado, nada é lido nem gravado, e nada é recuperado depois.",
  "settings.learning.weeklyCard": "Cartão semanal “O que aprendi”",
  "settings.learning.weeklyCardHint":
    "Uma publicação no Feed aos domingos, só quando há algo para revisar.",
  "settings.learning.open": "O que {persona} aprendeu",
  "settings.learning.openButton": "Abrir Crescimento",
  "settings.learning.forgetAll": "Esquecer tudo o que {persona} aprendeu",
  "settings.learning.forgetAllTitle": "Esquecer tudo o que {persona} aprendeu com você?",
  "settings.learning.forgetAllBody":
    "As notas, a Alma e as habilidades voltam ao que você escreveu. Digite “{phrase}” para confirmar.",
  "settings.learning.forgetPhrase": "esquecer",
  "settings.learning.forgetAllGo": "Esquecer tudo",
  "settings.learning.forgotAll":
    "{lessons, plural, one {# lição esquecida} other {# lições esquecidas}} e {events, plural, one {# evento de feedback} other {# eventos de feedback}}.",
  "settings.data.reasoningRetentionHint":
    "Por quanto tempo o raciocínio completo de cada etapa é guardado. Desativado mantém um resumo de uma linha.",
  "settings.data.recallModeHint":
    "Seus arquivos de memória em Markdown continuam sendo a fonte de verdade. Os embeddings deixam cada turno encontrar lembranças pelo significado.",
  "settings.data.recallMode.markdown": "Só Markdown",
  "settings.data.recallMode.markdownHint":
    "Lê os arquivos e compara palavras. Nada extra para executar.",
  "settings.data.recallMode.embeddings": "Markdown mais embeddings",
  "settings.data.recallMode.embeddingsHint":
    "Usa a mesma escolha de embeddings da Pesquisa. O modelo é carregado quando necessário e liberado quando ocioso.",
  "settings.data.recallState.off": "Só Markdown.",
  "settings.data.encryptMemory": "Criptografar a memória no disco",
  "settings.data.encryptMemoryHint":
    "Guarda o que {persona} sabe sobre pessoas em um arquivo criptografado, com a chave no seu cofre. Ao desativar, tudo é copiado de volta primeiro.",
  "settings.data.encryptMemory.restart": "Ativa na próxima vez que o Psyche iniciar.",
  "settings.data.encryptMemory.on": "Criptografada.",
  "settings.data.encryptMemory.pending": "Aguardando a chave do auxiliar do Mac.",
  "settings.data.encryptMemory.unavailable": "Indisponível: {why}",
  "settings.data.encryptMemory.offDone":
    "A memória voltou ao banco de dados principal; o arquivo criptografado foi excluído.",
  "settings.data.recallState.semantic":
    "Recuperando por significado e palavras: {vectors} de {chunks} trechos de memória indexados.",
  "settings.data.recallState.modelMissing":
    "O modelo de embeddings ainda não foi baixado, então a recuperação só compara palavras. Ative a Pesquisa semântica em Ajustes → Conectores e fontes → Pesquisa para baixá-lo.",
  "settings.data.recallState.cloudBlocked":
    "O serviço de embeddings não tem permissão para receber sua memória, então a recuperação só compara palavras.",
  "settings.data.recallState.textOnly":
    "Nenhum modelo de embeddings disponível, então a recuperação só compara palavras.",
  "settings.data.replayRetentionHint":
    "As telas que {persona} viu enquanto trabalhava, para a linha do tempo. Desativado não guarda nenhuma.",
  "settings.devices.presenceKey.keychain":
    "Chave do Touch ID (chaveiro), conforme informado pelo auxiliar",
  "settings.devices.presenceKey.enclaveKeychainAcl":
    "Chave do Touch ID (Secure Enclave, guardada no chaveiro de login e legível apenas pelo auxiliar), conforme informado pelo auxiliar",
  "settings.devices.presenceKey.enclaveFile":
    "Chave do Touch ID (arquivo do Secure Enclave, esta versão não tem perfil de provisionamento), conforme informado pelo auxiliar",
  "settings.devices.presenceKey.unknown": "Chave do Touch ID (tipo não informado pelo auxiliar)",
  "settings.devices.touchId.none":
    "Ainda não há chave do Touch ID. Cartões que exigem Touch ID não podem ser aprovados até uma ser registrada.",
  "settings.devices.touchId.bundled": "O Psyche Helper deste app mostra a chave",
  "settings.devices.touchId.notBundled":
    "Este auxiliar não é o que vem com este app, então a chave dele não pode ser registrada aqui.",
  "settings.devices.touchId.untrusted":
    "A chave do Touch ID no chaveiro não foi usada porque não é possível provar que é do auxiliar do Psyche: outra coisa a alterou ou adicionou. Redefina-a executando o auxiliar com --reset-presence-key (veja a documentação de segurança) e registre a nova chave.",
  "settings.devices.touchId.accessDenied":
    "O macOS não permitiu que o auxiliar do Psyche usasse sua chave do Touch ID no chaveiro. Abra o Psyche de novo e escolha Sempre permitir quando o macOS perguntar.",
  "settings.devices.touchId.noBundledKey":
    "O Psyche Helper deste app não tem chave do Touch ID ({reason}).",
  "settings.devices.touchId.register": "Registrar esta chave",
  "settings.devices.touchId.remove": "Remover chave",
  "settings.devices.touchId.manualLabel": "ID da chave",
  "settings.devices.touchId.manualHint":
    "Execute psyche-helper --print-identity no Mac e cole o presenceKeyId que ele imprime.",
  "settings.devices.touchId.allowDevFileKey": "Permitir uma chave do Touch ID de desenvolvimento",
  "settings.devices.touchId.devFileKey":
    "Esta versão não tem perfil de provisionamento, então a chave dela é um arquivo do Secure Enclave. Qualquer app executado como você poderia pedir que ela assine por trás do próprio aviso de Touch ID. Somente para desenvolvimento.",
  "settings.files.execHost": "Executar comandos neste Mac",
  "settings.files.execHostHint":
    "Deixa {persona} executar comandos nas suas pastas compartilhadas, na sandbox. Comandos que podem alterar arquivos perguntam antes.",
  "settings.files.execHostSwitch": "Permitir comandos neste Mac",
  "settings.files.readOnlyQuiet": "Executar comandos somente leitura sem perguntar",
  "settings.files.readOnlyQuietHint":
    "Comandos básicos de arquivos e informações que só leem, como ls, cat ou wc, rodam na sandbox sem cartão. Todo o resto pergunta, git incluído, e também cada comando depois que {persona} lê algo de fora.",
  "settings.files.revoke": "Revogar",
  "settings.files.description":
    "{persona} só acessa o que você permite, e pergunta no chat quando precisa de mais.",
  "settings.files.foldersHint":
    "Somente leitura deixa {persona} abrir e pesquisar uma pasta; leitura e gravação deixa salvar alterações. Revogar tem efeito imediato.",
  "settings.files.addYourself": "Adicionar uma pasta você mesmo",
  "settings.files.addYourselfHint":
    "Normalmente não é necessário: {persona} pergunta quando uma tarefa precisa de uma pasta. Pastas adicionadas começam somente leitura.",
  "settings.access.title": "A que {persona} pode ter acesso",
  "settings.access.listLabel": "A que {persona} pode ter acesso",
  "settings.access.empty":
    "Nada ainda. Quando {persona} precisa de uma pasta ou de um app, pergunta a você no chat, e o que você permitir aparece aqui.",
  "settings.access.scope.always": "Sempre",
  "settings.access.scope.conversation": "Este chat",
  "settings.access.scope.limited": "Por enquanto",
  "settings.access.used": "usado {when}",
  "settings.access.revokeNamed": "Revogar {name}",
  "settings.access.loadLabel": "ao que o Psyche pode ter acesso",
  "settings.access.loadFailed": "O Psyche não conseguiu carregar a que pode ter acesso ({reason}).",
  "settings.access.unchanged": "O acesso não mudou.",
  "settings.model.advancedHint": "Limites de contexto, modelos locais",
  "settings.permissions.subject.prepNotes": "Notas com o título “Prep:” (preparação de reuniões)",
  "settings.permissions.specificConnectors":
    "As permissões de um conector específico são definidas na página dele em Conectores.",
  "settings.permissions.openConnectors": "Abrir Conectores",
  "settings.persona.description": "Como {name} aparece e se apresenta.",
  "settings.persona.whileWorking": "Enquanto trabalha",
  "settings.persona.showReasoningHint":
    "Mostra o raciocínio de {persona} enquanto trabalha. Nunca é salvo.",
  "settings.connectors.page.onHost": "Em {host}",
  "settings.connectors.page.row.onHost": "Em {host}",
  "settings.computerUse.remote":
    "O uso do computador funciona em {host}. Peça de lá ou use o navegador.",
  "settings.gateways.title": "Gateways neste computador",
  "settings.gateways.description":
    "Use o Psyche neste computador com o Gateway de outro, como o seu Mac de casa. Só um Gateway fica ativo por vez, e trocar reinicia o Psyche.",
  "settings.gateways.loadLabel": "Gateways salvos",
  "settings.gateways.thisMac": "Este Mac",
  "settings.gateways.active": "Conectado",
  "settings.gateways.pinned": "Identidade fixada",
  "settings.gateways.notPinned": "Fixa a identidade na primeira conexão",
  "settings.gateways.switch": "Trocar",
  "settings.gateways.switchTo": "Trocar para {name}",
  "settings.gateways.switchTitle": "Trocar para {name}?",
  "settings.gateways.switchKeep":
    "O Psyche reinicia em {name}. O Psyche neste Mac continua em execução, então as automações dele continuam.",
  "settings.gateways.switchOnly": "Trocar",
  "settings.gateways.switchAndStop": "Trocar e parar o Psyche neste Mac",
  "settings.gateways.pairAgain": "Emparelhar novamente",
  "settings.gateways.pairAgainNamed": "Emparelhar novamente com {name}",
  "settings.gateways.forget": "Esquecer",
  "settings.gateways.forgetNamed": "Esquecer {name}",
  "settings.gateways.add": "Adicionar um Gateway",
  "settings.gateways.addressLabel": "Link de emparelhamento ou endereço",
  "settings.gateways.addressPlaceholder": "studio-mac.your-tailnet.ts.net",
  "settings.gateways.nameLabel": "Nome (opcional)",
  "settings.gateways.addHint":
    "Cole o link de emparelhamento do Mac que executa o Psyche (Ajustes, Servidor e acesso remoto, Emparelhar outro computador). Sem link, digite o endereço do Tailscale dele, https://<host>.<tailnet>.ts.net; este computador então pede para emparelhar, e o proprietário aprova lá.",
  "settings.gateways.newLink": "Chegou um novo link de emparelhamento. Usá-lo?",
  "settings.gateways.useNewLink": "Usar",
  "settings.gateways.ignoreNewLink": "Ignorar",
  "settings.gateways.fromLink":
    "Aberto de um link de emparelhamento. Confira e clique em Adicionar Gateway. O Psyche pede que você confirme o endereço antes de conectar.",
  "settings.gateways.adding": "Adicionar Gateway",
  "settings.gateways.problem.empty": "Digite o endereço do Gateway.",
  "settings.gateways.problem.invalid": "Esse não é um endereço que o Psyche possa usar.",
  "settings.gateways.problem.needs_full_name":
    "Use o nome completo, como studio-mac.your-tailnet.ts.net. Um nome curto não pode ser verificado.",
  "settings.gateways.problem.needs_https":
    "Use um endereço https://. O http simples só funciona por um túnel SSH neste computador.",
  "settings.gateways.problem.has_path": "Use só o endereço, sem caminho.",
  "settings.gateways.problem.has_credentials": "Remova qualquer nome de usuário ou senha.",
  "settings.gateways.problem.link_not_a_pairing_link": "Isso não é um link de emparelhamento.",
  "settings.gateways.problem.link_unsupported_version":
    "Esse link de emparelhamento é de uma versão mais recente do Psyche. Atualize o Psyche neste computador e tente novamente.",
  "settings.gateways.problem.link_malformed":
    "Esse link de emparelhamento está danificado. Copie-o de novo do Mac que o criou.",
  "settings.gateways.problem.link_extra_fields":
    "Esse link de emparelhamento tem algo que o Psyche não entende, então não é usado.",
  "settings.gateways.problem.link_bad_field":
    "Esse link de emparelhamento está danificado. Copie-o de novo do Mac que o criou.",
  "settings.gateways.problem.link_lan":
    "Este link de emparelhamento é de um computador da sua rede local, mas não traz o certificado dele, então não é usado. Nesse Mac, crie um novo: Emparelhar outro computador, Desta rede.",
  "settings.gateways.problem.link_not_lan":
    "Esse link de emparelhamento indica um endereço que não está em uma rede local, então não é usado.",
  "settings.gateways.problem.link_pin_mismatch":
    "Este Gateway já está salvo com outra identidade. Use antes “Emparelhar novamente” nele e depois adicione o link.",
  "settings.gateways.problem.failed": "Não foi possível adicionar o Gateway. Nada mudou.",
  "settings.gateways.problem.declined": "A adição do Gateway foi cancelada.",
  "settings.gateways.problem.actionFailed": "Isso não funcionou. Nada mudou.",
  "settings.remote.title": "Permitir outros computadores",
  "settings.remote.description":
    "Deixe o Psyche em outro computador usar o Gateway deste Mac por meio do Tailscale. O Gateway fica neste Mac e só escuta o Tailscale; o Tailscale Serve é a única entrada.",
  "settings.remote.step1":
    "Instale o Tailscale neste Mac e no outro computador, e entre nos dois na mesma tailnet.",
  "settings.remote.step2":
    "No Terminal deste Mac, publique o Gateway na sua tailnet. É Serve, não Funnel.",
  "settings.remote.copyCommand": "Copiar comando",
  "settings.remote.copied": "Copiado",
  "settings.remote.step3":
    "Informe ao Gateway o endereço dele. No config.json, na pasta de dados do Psyche, defina:",
  "settings.remote.step4":
    "Reinicie o Psyche. Depois, no outro computador, adicione este Mac como Gateway. Ele mostra um código de emparelhamento e a impressão digital de uma chave: compare-os com o pedido em “Aguardando emparelhamento” aqui e aprove.",
  "settings.remote.funnel":
    "Nunca ative o Tailscale Funnel para isto. Ele colocaria o Gateway na internet pública.",
  "settings.remote.admin":
    "Um computador que emparelha recebe leitura, gravação e aprovações. Admin continua desativado, a menos que você marque ao aprovar, e cada alteração de admin ainda exige o seu Touch ID aqui.",
  "settings.remote.address": "Endereço público",
  "settings.remote.addressUnset": "Não definido",
  "settings.remote.proxy": "Proxy confiável",
  "settings.remote.on": "Ativado",
  "settings.remote.off": "Desativado",
  "settings.remote.fingerprint": "Chave deste Gateway",
  "settings.remote.fingerprintHint":
    "Compare-a com a impressão digital que o outro computador mostra ao conectar pela primeira vez.",
  "settings.remote.loadLabel": "Identidade do Gateway",
  "settings.remote.clientNote":
    "Este computador é cliente de {host}. O acesso remoto é configurado em {host}.",
  "settings.pair.title": "Emparelhar outro computador",
  "settings.pair.description":
    "Crie um link de emparelhamento, ou um código QR, para o Psyche em outro computador. Funciona uma vez, por dez minutos, e o computador que o usar fica emparelhado com o acesso que você marcar aqui, sem segunda aprovação.",
  "settings.pair.needsAddress":
    "Defina primeiro o endereço público deste Mac (etapa 3 acima) e depois crie um link de emparelhamento.",
  "settings.pair.scopes": "O que o outro computador pode fazer",
  "settings.pair.adminHint":
    "Admin permite alterar ajustes de segurança, dispositivos e o cofre, e continua desativado, a menos que você marque. Cada alteração de admin ainda exige o seu Touch ID aqui.",
  "settings.pair.make": "Criar um link de emparelhamento",
  "settings.pair.resultRegion": "Link de emparelhamento e código QR",
  "settings.pair.qrLabel": "Código QR do link de emparelhamento de {host}",
  "settings.pair.scan":
    "No outro computador, escolha “Adicionar um Gateway” e cole este link para {host}.",
  "settings.pair.expires": "Expira {when}.",
  "settings.pair.linkLabel": "Link de emparelhamento",
  "settings.pair.copy": "Copiar link",
  "settings.pair.gives": "Depois de usado, esse computador recebe: {scopes}.",
  "settings.pair.compare":
    "Ele verifica a chave deste Mac antes de usar o link: {fingerprint}. Você pode comparar.",
  "settings.pair.secret":
    "Quem tiver este link nos próximos dez minutos pode emparelhar um computador. Não o publique nem o envie a ninguém em quem você não confiaria para este Mac.",
  "settings.pair.live": "Links de emparelhamento não usados",
  "settings.pair.unused": "Ainda não usado",
  "settings.pair.revoke": "Revogar",
  "settings.pair.revokeNamed": "Revogar o link de emparelhamento criado {when}",
  "settings.pair.madeToast": "Link de emparelhamento criado. Funciona uma vez, por dez minutos.",
  "settings.pair.usedToast": "Um computador emparelhou com o seu link.",
  "settings.pair.gone": "O link de emparelhamento não é mais válido, então não é mais exibido.",
  "settings.pair.err.noAddress":
    "Este Mac ainda não tem endereço público, então não há nada para colocar em um link.",
  "settings.pair.err.tooMany":
    "Já existem três links de emparelhamento não usados. Revogue um ou espere expirar.",
  "settings.pair.err.forbidden":
    "Só o Psyche no próprio Host, emparelhado como admin, pode criar um link de emparelhamento.",
  "settings.pair.err.failed": "Não foi possível criar um link de emparelhamento ({reason}).",
};
