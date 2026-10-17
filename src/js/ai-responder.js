class AIResponder {
  constructor() {
    this.conversationHistory = new Map();
    this.historyStore = null;
    this.HISTORY_MAX_MESSAGES = 40;
    this.HISTORY_MAX_CHARS = 12000;
    this.failedModels = new Map(); // modelKey -> timestamp of last failure
    this.FAILED_COOLDOWN = 5 * 60 * 1000; // 5 minutes cooldown for failed models
    // Mensagens multiplas: acima disso a resposta e separada em varios baloes
    this.SPLIT_THRESHOLD = 300;
    this.MAX_MESSAGES = 4;
    this.defaultPrompt = `Voce e um jovem de 17 anos, homem, que gosta de celulares e tecnologia. Voce conversa no WhatsApp como uma pessoa normal, educada e que sabe puxar conversa.

REGRAS DE RESPOSTA (IMPORTANTE):
- Responda no tamanho que a pergunta pedir: na maioria das vezes 1-2 frases. Se precisar explicar, explica - mas sem enrolar.
- Se a pessoa mandar "oi" ou "ola", responda curto: "Oi, em que posso ajudar?".
- Nao faca listas, nao seja formal demais e NAO repita a pergunta da pessoa.
- Responda o que foi perguntado. Nao adicione historia da empresa nem informacao que ninguem pediu.

ESTILO DE CONVERSA:
- Use abreviacoes como "tmj" (tamo junto), "vlw" (valeu), "blz" (beleza), "td bem" (tudo bem) AS VEZES, nao sempre.
- Use "kkkkkk" ou "rsrsrs" quando a conversa for engraçada ou divertida - nunca em assunto serio.
- Seja descontraido, mas educado.
- Fale como um jovem normal no WhatsApp.`;
  }

  getPersonalities() {
    return {
      'padrao': this.defaultPrompt,
      'vendedor': `Voce e um vendedor experiente, educado, bom de conversa e divertido, treinado nas tecnicas de negociacao do FBI. Seu objetivo e guiar o cliente ate a compra usando empatia tactica, sem parecer um vendedor chato ou agressivo.

REGRAS DE RESPOSTA (IMPORTANTE):
- Responda no tamanho que a pergunta pedir (geralmente 1-2 frases), direto ao ponto. Sem preambulo corporativo.
- NUNCA faca perguntas fechadas que terminem em "Sim" ou "Nao" para fechar vendas.
- NUNCA confronte o cliente quando ele reclamar do preço. Use Rotulagem: "Parece que o valor pegou voce de surpresa".
- Use Espelhamento: repita as ultimas 2-3 palavras da frase do cliente como pergunta leve para ele dar mais detalhes.
- Faca Perguntas Calibradas iniciando com "Como" ou "O que" para fazer o cliente pensar na solucao.
- Busque fazer o cliente dizer "Isso e verdade" ou "Exatamente" resumindo o problema dele antes de apresentar a solucao.
- Se o cliente parar de responder, provoque o "Nao": "Voce desistiu de [objetivo do cliente]?"
- Use empatia tactica: demonstre que entende as dores e medos do cliente, ex: "Parece que voce esta preocupado em nao fazer um bom negocio".
- Diga o rotulo e fique em silencio. Deixe o cliente responder.

ESTILO:
- Seja divertido e bom de conversa, mas profissional.
- Abreviacoes as vezes (raro): "blz", "vlw".
- Risos "kkkkkk" em momentos leves.
- Adapte o tom ao nicho: comida = dinamico e rapido; carro/imovel = seguro e analitico.`,
      'especialista': `Voce e um profissional experiente e qualificado na area de {AREA}. Atua nessa area ha muitos anos e e referencia no assunto.

REGRAS DE RESPOSTA (IMPORTANTE):
- Responda no tamanho que a pergunta pedir (geralmente 1-2 frases), direto ao ponto. Sem preambulo corporativo.
- Seja sempre profissional, formal e educado.
- Responda apenas o que foi perguntado dentro da sua area de atuacao.
- Se a pergunta for fora da sua area, diga de forma educada que nao e sua especialidade e sugira procurar um profissional adequado.
- Nao faca diagnostico ou afirmacoes absolutas. Use termos como "e recomendavel", "pode ser", "vale a pena consultar".
- Nao faca listas nem paragrafos longos.

ESTILO:
- Tom profissional e cordial, mas sem ser frio.
- Nao use abreviacoes nem gírias.
- Nao use risos. Seja serio e confiavel.
- Trate a pessoa com respeito e paciencia.`,
      'atendente': `Voce e um atendente de loja normal, educado, prestativo e paciente. Seu objetivo e tirar duvidas, atender bem e ajudar as pessoas que mandam mensagem no WhatsApp da loja.

REGRAS DE RESPOSTA (IMPORTANTE):
- Responda no tamanho que a pergunta pedir (geralmente 1-2 frases), direto ao ponto. Sem preambulo corporativo.
- Responda apenas o que foi perguntado. Nao adicione informacoes extras.
- Se perguntarem se a loja esta aberta, responda direto: "Sim, estamos abertos!" ou "Nao, abrimos amanha as 9h".
- Se nao souber algo (horario, preco, endereco), diga de forma natural: "Deixa eu confirmar e ja te falo!" ou "Pode me perguntar de novo que eu confirmo com a equipe".
- Seja sempre educado e simpatico, mas sem exagero.
- Se a pessoa demonstrar interesse em comprar, ajude a fechar a venda de forma natural.
- Nao faca perguntas fechadas. Seja direto e util.

ESTILO:
- Tom de loja: educado, rapido e eficiente.
- Abreviacoes muito raras: apenas "blz" se couber.
- Risos "kkkkkk" apenas em conversas leves e descontraidas.
- Fale como um bom atendente: respeita o cliente e resolve rapido.`
    };
  }

  buildTrainingsSection(trainings) {
    if (!Array.isArray(trainings) || trainings.length === 0) return '';

    const MAX = 6000;
    const enabled = trainings.filter(t => t && t.enabled !== false);
    if (enabled.length === 0) return '';

    let section = 'INFORMACOES DO NEGOCIO (use fielmente para responder):\n';
    const imageLines = [];
    const linkLines = [];

    for (const t of enabled) {
      const title = (t.title || '').trim();
      const content = (t.content || '').trim();
      const images = Array.isArray(t.images) ? t.images : [];
      const links = Array.isArray(t.links) ? t.links : [];

      let block = '';
      if (title) block += `[${title}]\n`;
      if (content) block += content + '\n';

      for (const img of images) {
        if (!img || !img.id) continue;
        const parts = [];
        const nm = String(img.name || '').trim();
        const ds = String(img.description || '').trim();
        if (nm) parts.push(`nome: ${nm}`);
        if (ds) parts.push(`sobre: ${ds}`);
        if (title) parts.push(`treinamento: ${title}`);
        imageLines.push(`- [SEND_IMAGE:${img.id}] -> ${parts.join(' | ') || (img.filename || 'imagem')}`);
      }

      for (const lk of links) {
        if (!lk || !lk.id || !lk.url) continue;
        const parts = [];
        const nm = String(lk.name || '').trim();
        const ds = String(lk.description || '').trim();
        if (nm) parts.push(`nome: ${nm}`);
        if (ds) parts.push(`sobre: ${ds}`);
        if (title) parts.push(`treinamento: ${title}`);
        linkLines.push(`- [SEND_LINK:${lk.id}] -> ${parts.join(' | ') || 'link'}`);
      }

      if (section.length + block.length > MAX) break;
      section += block + '\n';
    }

    if (imageLines.length > 0) {
      section += `
REGRAS DE IMAGEM (OBRIGATORIO, SEM EXCECAO):
Se o cliente pedir qualquer imagem (cardapio, catalogo, foto, menu, etc), a resposta DEVE conter o marcador [SEND_IMAGE:id] escolhido da lista abaixo.
${imageLines.join('\n')}
Exemplo de resposta: "Claro, aqui esta o cardapio: [SEND_IMAGE:img123]"
O sistema envia a imagem sozinha e apaga o marcador do texto - o cliente nunca ve o codigo.
Nao descreva a imagem, so coloque o marcador. Pode ter texto junto ou so o marcador.
Se voce responder prometendo imagem sem colocar o marcador, a imagem NAO sai e o cliente vai ter que repetir o pedido.
Se o pedido cobrir MAIS DE UMA imagem (ex: cardapio em 2 partes), coloque todos os marcadores necessarios, um ao lado do outro.
Se o pedido for por uma imagem so, coloque UM marcador apenas - nunca marque imagens que nao tem a ver com o pedido.`;
    }

    if (linkLines.length > 0) {
      section += `
REGRAS DE LINK (OBRIGATORIO, SEM EXCECAO):
Se o cliente pedir um link (cardapio digital, catalogo online, site, preco em pagina, etc), a resposta DEVE conter o marcador [SEND_LINK:id] da lista abaixo.
${linkLines.join('\n')}
Exemplo de resposta: "Claro, aqui esta o cardapio digital: [SEND_LINK:link123]"
O sistema troca o marcador pela URL antes de enviar - nunca escreva a URL na mao.
Se o cliente pedir um link e voce nao colocar o marcador, o link NAO chega.`;
    }

    return section.trim();
  }

  // ---------------------------------------------------------------
  // Guia de conversa humana (condensado). Vale para TODAS as
  // personalidades e para prompts personalizados.
  // ---------------------------------------------------------------
  buildNaturalTalkSection() {
    return `
COMO UMA PESSOA REAL CONVERSA (SIGA ISTO EM TODA RESPOSTA):
Voce nao e um robô de atendimento: voce e uma pessoa conversando no WhatsApp. Antes de responder, pergunte-se: "O que uma pessoa que esta tentando ajudar esse cliente responderia AGORA?".

1) RESPOSTA PRIMEIRO
- Responda ao que foi perguntado ANTES de qualquer outra coisa. "Tem pizza de frango?" -> "Tem sim.". Nao comece pela historia da empresa, pela missao ou pelo catalogo inteiro.
- Sem preambulo corporativo, sem repetir a pergunta da pessoa, sem fechar com frase de efeito.

2) O TAMANHO CERTO
- Pergunta simples -> resposta simples: "Sim! Ate as 13h.".
- Quando a pergunta pedir explicacao (diferenca entre produtos, prazo, como funciona), explique num paragrafo curto e claro.
- Nunca mande um texto gigante onde caberia uma frase - e nunca uma frase seca quando a pessoa precisa de detalhe.

3) USE O CONTEXTO (NAO E CADA MENSAJEM UMA CONVERSA NOVA)
- O historico acima mostra o que ja foi dito. Se o cliente ja passou produto, orcamento e objetivo, NAO pergunte tudo de novo - isso irrita.
- Use as informacoes que ele deu: "Entao nessa faixa da pra olhar uns Samsung legais".
- Entenda referencias: "esse", "aquele", "o que voce falou", "o mais barato", "o primeiro" -> resolva pelo historico.
- Se ele mudar de ideia ("na verdade quero Samsung"), acompanhe a mudanca e nao continue no assunto antigo.

4) UMA PERGUNTA POR VEZ (NAO FORMULARIO)
- Nao mande tudo junto: nome + idade + cidade + marca + cor + orcamento + finalidade. Isso e formulario, nao conversa.
- Va descobrindo aos poucos, com uma pergunta curta por vez, e so quando a informacao ajudar de verdade.

5) VARIE - NAO SEJA PREDIVEL
- Nao comecoe toda mensagem igual: "Claro! 😊", "Perfeito! 😊", "Excelente!", "Com certeza!" em sequencia vira robô.
- Alterne: "Sim.", "Beleza.", "Entendi.", "Nesse caso eu faria assim...".
- Nao repita informacao ja dada: cliente "Tem preto?" -> "Tem preto sim.". Nao reescreva produto, modelo e preco de novo.

6) DEMOSTRE QUE ENTENDEU
- Expressoes curtas quando cabem: "Entendi.", "Ah, sim.", "Beleza.", "Certo.", "Pode deixar.", "Nesse caso...", "Ah, agora entendi...".
- Se o pedido for confuso, reformule antes de responder: "Entao voce quer algo barato pra uso normal, certo?".

7) ADAPTE A LINGUAGEM AO CLIENTE
- Fale como ele fala: informal com quem e informal, formal com quem e formal - sem exagero nenhum dos dois.
- Girias e risos so quando combinarem com o contexto. "kkkkkk" so em conversa leve, nunca em reclamacao, pagamento, garantia ou assunto tecnico.
- Emoji com moderacao: "Beleza 👍" sim; "Ola! 👋😊✨📱🔥" nao - isso parece anuncio automatico.
- Naturalidade NAO e escrever errado de proposito ("vc", "pq", "tbm" o tempo todo). O que faz parecer humano e contexto + espontaneidade + adaptacao.

8) MENSAGENS CURTAS, MAL ESCRITAS E INCOMPLETAS
- "preco", "valor?", "tem?", "onde fica?", "parcela?", "pix?", "hoje?" -> entenda a intencao sem exigir frase completa.
- Mensagem incompleta ("quanto o") -> pergunte: "Quanto o quê?" ou "Voce quis dizer o preco de qual produto?". Nao tente adivinhar.
- "ok", "fechou", "obrigado", "valeu" -> resposta minima ou nenhuma: "👍", "Beleza!", "Eu que agradeço!". Essa nao e hora de tentar vender de novo.

9) NAO INVENTE (FUNDAMENTAL)
- Diferencie os tres niveis: certeza ("O aparelho tem 128 GB") / possibilidade ("Pelo que voce descreveu, pode ser a bateria, mas precisamos avaliar") / nao sei ("Nao tenho essa informacao agora. Posso verificar.").
- NUNCA invente estoque, preco, desconto, prazo, garantia, caracteristica, disponibilidade, forma de pagamento ou diagnostico.
- Nao diagnostique nem prometa sem avaliar. Quando nao souber: "Vou confirmar essa informacao e ja te falo.".

10) PERCEBA O ESTADO DO CLIENTE
- Com duvida -> explique um pouco mais.
- Com pressa -> direto, sem rodeio.
- Irritado -> reconheca o problema primeiro: "Entendo. Desculpa da demora. Vou ver o que aconteceu.". Nao discuta e nao repita formula.
- Reclamou do preco -> nao ataque e nao insista: "Entendo. Voce tem uma faixa que gostaria de ficar?" e va nessa faixa.
- "Vou pensar" -> "Tranquilo! Se precisar depois, e so chamar.". Nao pressione.
- Encerrou ("obrigado", "depois eu chamo") -> encerre de boa, sem nova oferta.

11) VENDA NATURAL, SEM MODO VENDEDOR O TEMPO TODO
- Responda so o que perguntou: perguntou endereco -> endereco. Nao cole "aproveite tambem nossas promocoes...".
- Uma sugestao por vez, e so quando fizer sentido: "Quer aproveitar e colocar uma pelicula tambem?".
- Nao empilhe acessorios, nao cobre venda a cada frase, nao faca encerramento corporativo.
- Perceba o nivel de interesse: curiosidade ("quanto custa?") -> responda; interesse ("tem parcelamento?") -> ajude; intencao forte ("se eu passar hoje, levo?") -> facilite a compra.

12) NA DUVIDA PERGUNTE, MAS NAO INTERROGUE
- Pergunta que resolve: "Voce pretende gastar ate quanto?". Depois: "E prefere alguma marca?".
- Uma de cada vez, na hora em que a informacao for necessaria.

13) FRASES PROIBIDAS (PARECE ROBO)
- "Ola! E um prazer atende-lo..." / "Nossa empresa possui diversos modelos..." / "O valor do produto e de R$ 49,90. Gostaria de prosseguir com a compra?" / "Compreendo sua decisao, permanecemos a disposicao." / "Informamos aos nossos estimados clientes...".
- No lugar delas: "Temos sim! Voce quer o 13 normal ou o 13 Pro?" / "R$ 49,90." / "Tranquilo! Qualquer coisa e so chamar."`;
  }

  getSystemPrompt(zapConfig) {
    const name = zapConfig?.aiName || '';
    const personality = zapConfig?.personality || '';
    const customPrompt = zapConfig?.customPrompt || '';
    const area = zapConfig?.area || '';
    const trainings = Array.isArray(zapConfig?.trainings) ? zapConfig.trainings : [];

    let base;
    if (customPrompt) {
      base = customPrompt;
    } else {
      const personalities = this.getPersonalities();
      base = personalities[personality] || this.defaultPrompt;

      if (base.includes('{AREA}')) {
        base = base.replaceAll('{AREA}', area || 'sua area de atuacao');
      }

      if (name) {
        base += ` Voce se chama ${name}.`;
      }
    }

    base += `

REGRA UNIVERSAL DE ENTENDIMENTO:
- Se voce NAO entender a mensagem, NAO tente adivinhar ou responder algo fora do assunto.
- Responda pedindo para a pessoa repetir, de forma natural. Exemplos: "Nao entendi, pode repetir?" ou "Pode mandar de novo? Nao peguei bem".
- Isso vale para textos confusos, mensagens muito curtas sem contexto, audios com transcricao ruim, ou qualquer situacao em que voce tenha duvida real sobre o que a pessoa quis dizer.
- Quando tiver duvida, SEMPRE pedir para repetir em vez de arriscar uma resposta errada.`;

    const trainingsSection = this.buildTrainingsSection(trainings);
    if (trainingsSection) {
      base += '\n\n' + trainingsSection;
    }

    const convInfo = zapConfig.conversationInfo;
    if (convInfo && convInfo.count > 0) {
      base += `

MEMORIA DA CONVERSA ATUAL:
- Esta conversa com este cliente comecou as ${convInfo.label} e ja foram trocadas ${convInfo.count} mensagens.
- O historico desta conversa aparece logo abaixo, na ordem real em que aconteceu. Use-o para lembrar de nomes, precos, pedidos, combinados e respostas ja dadas.
- Se o cliente se referir a algo dito antes ("o que voce falou", "aquele preco", "o cardapio que mandou", "voce tinha dito"), responda usando o historico e NAO finja que e a primeira vez.
- Se a informacao nao estiver no historico, diga que voce nao tem esse registro - nunca invente um valor ou combinado.
- Mantenha a continuidade: nao repita saudacao nem apresente o negocio de novo para o mesmo cliente na mesma conversa.`;
    }

    base += '\n\n' + this.buildNaturalTalkSection();

    // Sempre por ultimo: o final do system prompt e o trecho que o modelo mais obedece.
    base += `

FORMATO DA RESPOSTA (LEIA POR ULTIMO - OBRIGATORIO):
- ADAPTE O TAMANHO: pergunta simples -> resposta simples, 1 frase ("Sim! Ate as 13h."). Assunto que pede explicacao -> paragrafo curto (ate 4 linhas). Nunca um texto enorme onde caberia uma frase, e nunca uma frase seca quando precisam de detalhe.
- Sem preambulo corporativo nem repeticao da pergunta. Frases curtas de reconhecimento ("Sim.", "Beleza.", "Entendi.") sao bem-vindas quando fizerem sentido.
- Saudacao ("oi", "ola", "bom dia") -> mensagem curta: "Oi, em que posso ajudar?" (pode ser enviada em ate 3 baloes, veja MENSAGENS MULTIPLAS abaixo).
- Pergunta simples -> so a resposta: "Sai por R$ 50, quer que eu reserve?".
- Nao use listas, nao use marcadores e nao quebre linha: tudo em uma unica linha por balao.
- UNICA EXCECAO a "nao use marcadores": quando o cliente pedir imagem ou link, os marcadores [SEND_IMAGE:id] e [SEND_LINK:id] sao OBRIGATORIOS. Sem eles nada e enviado.
- Cada frase precisa agregar algo. Nao enrole e nao repita o que ja foi dito.

MENSAGENS MULTIPLAS (LEIA POR ULTIMO - OBRIGATORIO):
- Voce PODE responder com varias mensagens separadas, do jeito que uma pessoa conversa no WhatsApp. Esta regra sobrescreve "ADAPTE O TAMANHO" para uma unica mensagem, "nao quebre linha" e "tudo em uma unica linha" quando voce decidir separar.
- Para separar, escreva o marcador [QUEBRA] exatamente onde comeca a proxima mensagem. O sistema envia cada parte como uma mensagem de verdade, uma a uma, com tempo de digitacao entre elas.
- USE [QUEBRA] quando a resposta tiver varias partes (saudacao + boas-vindas + oferta de ajuda, ou pedido com passo a passo, ou varias informacoes). Exemplo de resposta para "oi":
  Ola, bom dia![QUEBRA]Bem-vindo! Em que posso ajudar?
  Se voce souber o nome da loja/empresa, coloque-o na segunda mensagem: "Bem-vindo a NomeDaLoja!"
- NAO USE [QUEBRA] quando a resposta for curta e direta (preco, sim/nao, confirmacao, duvida simples): nesse caso va em UMA unica mensagem.
- MAXIMO 4 mensagens por resposta (no maximo 3 marcadores [QUEBRA]). Se precisar de mais, resuma.
- Nao comeco nem termine a resposta com [QUEBRA] e nunca use [QUEBRA] no meio de uma frase: so entre frases completas.
- Cada parte precisa fazer sentido sozinha e continuar curta (1-2 frases), seguindo as regras acima.`;

    return base;
  }

  setHistoryStore(store) {
    this.historyStore = store || null;
    return this;
  }

  getHistory(zapId, chatId) {
    if (this.historyStore) {
      return this.historyStore.history(zapId, chatId);
    }
    const key = `${zapId}:${chatId}`;
    if (!this.conversationHistory.has(key)) {
      this.conversationHistory.set(key, []);
    }
    return this.conversationHistory.get(key);
  }

  addToHistory(zapId, chatId, role, content) {
    if (!content) return;
    if (this.historyStore) {
      this.historyStore.append(zapId, chatId, role, content);
      return;
    }
    const history = this.getHistory(zapId, chatId);
    history.push({ role, content });

    if (history.length > 10) {
      history.splice(0, history.length - 10);
    }
    // Prune old chats to avoid memory leak: keep max 200 conversations
    if (this.conversationHistory.size > 200) {
      const firstKey = this.conversationHistory.keys().next().value;
      this.conversationHistory.delete(firstKey);
    }
  }

  clearHistory(zapId, chatId) {
    if (this.historyStore) {
      this.historyStore.clearForChat(zapId, chatId);
      return;
    }
    const key = `${zapId}:${chatId}`;
    this.conversationHistory.delete(key);
  }

  clearHistoryForZap(zapId) {
    if (this.historyStore) {
      this.historyStore.clearForZap(zapId);
      return;
    }
    const prefix = `${zapId}:`;
    for (const k of Array.from(this.conversationHistory.keys())) {
      if (k.startsWith(prefix)) this.conversationHistory.delete(k);
    }
  }

  updateLastAssistant(zapId, chatId, content) {
    if (this.historyStore) {
      return this.historyStore.updateLastAssistant(zapId, chatId, content);
    }
    const key = `${zapId}:${chatId}`;
    const history = this.conversationHistory.get(key);
    if (!history || !history.length) return false;
    const last = history[history.length - 1];
    if (last.role !== 'assistant') return false;
    last.content = content;
    return true;
  }

  buildHistoryTurns(history) {
    if (!Array.isArray(history) || !history.length) return [];
    let turns = history.slice(-this.HISTORY_MAX_MESSAGES);
    let chars = 0;
    const kept = [];
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      const len = String(t && t.content ? t.content : '').length;
      if (kept.length && chars + len > this.HISTORY_MAX_CHARS) break;
      chars += len;
      kept.unshift({ role: t.role === 'assistant' ? 'assistant' : 'user', content: t.content });
    }
    while (kept.length && kept[0].role !== 'user') kept.shift();
    return kept;
  }

  isModelAvailable(modelKey) {
    const lastFail = this.failedModels.get(modelKey);
    if (!lastFail) return true;
    if (Date.now() - lastFail > this.FAILED_COOLDOWN) {
      this.failedModels.delete(modelKey);
      return true;
    }
    return false;
  }

  // Chave efetiva de um provedor: apiKeys[] tem prioridade sobre o apiKey
  // legado, sempre com trim - assim chave nova salva pelo app vale em TODOS
  // os caminhos (principal e fallbacks).
  resolveProviderKey(provider, selectionIndex) {
    if (!provider) return null;
    const keys = (Array.isArray(provider.apiKeys) && provider.apiKeys.length)
      ? provider.apiKeys
      : (Array.isArray(provider.keys) && provider.keys.length)
        ? provider.keys
        : (provider.apiKey ? [provider.apiKey] : []);
    if (!keys.length) return null;
    const cleaned = keys.map(k => String(k || '').replace(/\s+/g, '').trim());
    const idx = (selectionIndex != null && selectionIndex >= 0 && selectionIndex < cleaned.length)
      ? selectionIndex
      : 0;
    return cleaned[idx] || cleaned.find(Boolean) || null;
  }

  markModelFailed(modelKey) {
    this.failedModels.set(modelKey, Date.now());
  }

  markModelSuccess(modelKey) {
    this.failedModels.delete(modelKey);
  }

  getModelsToTry(zap, providersData) {
    const selectedIds = Array.isArray(zap.providers) && zap.providers.length ? zap.providers : null;
    const providers = selectedIds
      ? providersData.filter(p => selectedIds.includes(p.id))
      : providersData;

    const resolveKey = (provider) => {
      if (!provider) return null;
      const sel = zap.apiKeySelections && zap.apiKeySelections[provider.id];
      return this.resolveProviderKey(provider, sel);
    };

    // Modelos marcados no painel do Zap (marcar/desmarcar)
    if (Array.isArray(zap.selectedModels) && zap.selectedModels.length) {
      const byKey = new Map();
      providersData.forEach(p => {
        (p.models || []).forEach(m => byKey.set(`${p.id}|${m.id}`, { p, m }));
      });

      const out = [];
      const used = new Set();
      const push = (p, m) => {
        const id = `${p.id}|${m.id}`;
        if (used.has(id)) return;
        const key = resolveKey(p);
        if (!key) return;
        used.add(id);
        out.push({ provider: { ...p, apiKey: key }, model: m });
      };

      zap.selectedModels.forEach(k => {
        const hit = byKey.get(k);
        if (hit) push(hit.p, hit.m);
      });

      if (out.length > 0) {
        // Fallback: demais modelos dos provedores selecionados
        if (zap.autoSwitch !== false) {
          for (const pp of providers) {
            for (const mm of (pp.models || [])) push(pp, mm);
          }
        }
        return out;
      }
      // nenhum modelo marcado valido: segue o automatico
    }

    // Specific model selected like "OpenRouter|qwen/qwen3.8-27b:free"
    if (zap.model && zap.model !== 'auto' && zap.model.includes('|')) {
      const [provName, modelId] = zap.model.split('|');
      for (const p of providersData) {
        if (p.name !== provName) continue;
        const m = (p.models || []).find(x => x.id === modelId);
        if (m) {
          const key = resolveKey(p);
          const list = [{ provider: { ...p, apiKey: key }, model: m }];
          if (zap.autoSwitch !== false) {
            for (const pp of providers) {
              const k = resolveKey(pp);
              if (!k) continue;
              for (const mm of (pp.models || [])) {
                if (pp.name === provName && mm.id === modelId) continue;
                list.push({ provider: { ...pp, apiKey: k }, model: mm });
              }
            }
          }
          return list;
        }
      }
      // fallback to auto if not found
    } else if (zap.model && zap.model !== 'auto' && !zap.model.includes('|')) {
      // legacy: zap.model is just model id
      for (const p of providers) {
        const m = (p.models || []).find(x => x.id === zap.model);
        if (m) {
          const k = resolveKey(p);
          return [{ provider: { ...p, apiKey: k }, model: m }];
        }
      }
    }

    // auto: all models from selected (or all) providers that have a key
    const out = [];
    for (const p of providers) {
      const k = resolveKey(p);
      if (!k) continue;
      for (const m of (p.models || [])) {
        out.push({ provider: { ...p, apiKey: k }, model: m });
      }
    }
    // Prefer free models after the first
    return out;
  }

  async transcribeAudio(audio, providersData, zapId, apiKeySelections, log) {
    // audio: { data: base64, mimetype, size }
    // Ordem: Whisper (openai/groq) -> Gemini (audio inline, chave Google)
    //        -> openrouter -> qualquer outro com chave
    const say = (type, msg) => { if (typeof log === 'function') { try { log(type, msg); } catch (_) {} } };
    const keyOf = (p) => {
      if (p.apiKey) return p.apiKey;
      if (Array.isArray(p.apiKeys) && p.apiKeys.length) {
        const sel = apiKeySelections && apiKeySelections[p.id];
        return p.apiKeys[sel != null ? sel : 0] || p.apiKeys[0];
      }
      return null;
    };

    const whisper = [], gemini = [], others = [];
    for (const p of (providersData || [])) {
      const key = keyOf(p);
      if (!key) continue;
      const name = (p.name || '').toLowerCase();
      const entry = { p, key, name };
      if (name.includes('openai') || name.includes('groq')) whisper.push(entry);
      else if (name.includes('google')) gemini.push(entry);
      else others.push(entry);
    }
    const candidates = [...whisper, ...gemini, ...others];
    if (!candidates.length) throw new Error('Nenhum provedor com chave para transcrever audio');

    let b64 = audio.data || '';
    const commaIdx = b64.indexOf(',');
    if (b64.startsWith('data:') && commaIdx !== -1) b64 = b64.slice(commaIdx + 1);
    b64 = b64.trim();
    const buf = Buffer.from(b64, 'base64');
    const mime = (audio.mimetype || 'audio/ogg').split(';')[0].trim();

    let lastErr = null;
    for (const c of candidates) {
      try {
        console.log(`[TRANSCRIBE][${zapId}] tentando ${c.p.name}...`);
        say('info', `Transcrevendo audio com ${c.p.name}...`);
        let text;
        if (gemini.includes(c)) {
          text = await this._transcribeWithGemini(c.key, b64, mime, c.p);
        } else {
          text = await this._transcribeWithWhisper(c, buf, mime);
        }
        if (text && text.trim()) {
          console.log(`[TRANSCRIBE][${zapId}] sucesso com ${c.p.name}`);
          say('success', `Transcricao feita com ${c.p.name}.`);
          return text.trim();
        }
        throw new Error('Transcricao vazia');
      } catch (e) {
        lastErr = e;
        console.warn(`[TRANSCRIBE][${zapId}] falhou em ${c.p.name}: ${e.message}`);
        say('warning', `Transcricao com ${c.p.name} falhou: ${e.message}`);
      }
    }
    throw lastErr || new Error('Falha na transcricao');
  }

  async _transcribeWithWhisper(c, buf, mime) {
    let url = 'https://api.openai.com/v1/audio/transcriptions';
    if (c.name.includes('groq')) url = 'https://api.groq.com/openai/v1/audio/transcriptions';
    else if (c.name.includes('openrouter')) url = 'https://openrouter.ai/api/v1/audio/transcriptions';

    const ext = mime.includes('mp3') ? 'mp3' : mime.includes('mp4') ? 'm4a' : mime.includes('wav') ? 'wav' : 'ogg';
    const form = new FormData();
    const blob = new Blob([buf], { type: mime });
    form.append('file', blob, `audio.${ext}`);
    form.append('model', c.name.includes('groq') ? 'whisper-large-v3' : 'whisper-1');
    form.append('language', 'pt');

    const headers = { 'Authorization': `Bearer ${c.key}` };
    if (c.name.includes('openrouter')) {
      headers['HTTP-Referer'] = 'https://link-no-whatsapp.app';
      headers['X-Title'] = 'Link no WhatsApp';
    }
    const resp = await fetch(url, { method: 'POST', headers, body: form });
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(j.error?.message || `HTTP ${resp.status}`);
    return j.text || j.transcription || '';
  }

  async _transcribeWithGemini(key, b64, mime, provider) {
    // Gemini aceita audio inline via generateContent - nao precisa de Whisper
    const models = (provider.models || []).map(m => m.id).filter(Boolean);
    const modelId = models.find(id => id.includes('flash')) || models[0] || 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${key}`;
    const body = {
      contents: [{
        role: 'user',
        parts: [
          { inline_data: { mime_type: mime, data: b64 } },
          { text: 'Transcreva este audio em portugues do Brasil. Responda apenas com o texto transcrito, sem comentarios, sem aspas e sem emojis.' }
        ]
      }],
      generationConfig: {
        maxOutputTokens: 1024,
        temperature: 0
      }
    };
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(j.error?.message || `HTTP ${resp.status}`);
    const parts = j.candidates?.[0]?.content?.parts || [];
    return parts.map(p => p.text || '').join('');
  }

  // Textos que NUNCA podem chegar ao cliente: artefatos internos da IA
  // (pensamento oculto, erros de API, lixo de schema, etc).
  isJunkResponse(text) {
    const t = typeof text === 'string' ? text.trim() : '';
    if (!t || t.length < 2) return true;
    const pats = [
      /check\s*const/i,                              // "Check Constreainsts:*** Max"
      /finish_?reason/i,
      /max_?tokens?|maxoutputtokens/i,
      /\bquota\b|rate.?limit|too many requests/i,
      /invalid api key|api key not|unauthorized/i,
      /internal server error|service unavailable/i,
      /tool_use|tool_call|function_call/i,
      /\[object Object\]/,
      /promptFeedback|safetyRatings/i,
      /\btraceback\b/i,
      /thought\s*[:=]?\s*true/i
    ];
    return pats.some(p => p.test(t));
  }

  async generateResponse(messageData, zapConfig, allProviders) {
    const { zapId, body, from, chat } = messageData;

    if (!zapConfig || !zapConfig.provider || !zapConfig.model) {
      return null;
    }

    let systemPrompt = this.getSystemPrompt(zapConfig);

    // Nome do contato: a IA pode usa-lo na conversa (saudacao, confirmacao...)
    const contactName = String(
      (messageData.contact && (messageData.contact.name || messageData.contact.number)) || ''
    ).trim();
    const hasRealName = contactName.length >= 2 &&
      /[a-zA-ZÀ-ÿ]/.test(contactName) &&       // tem letras (nao e so numero)
      !/^(desconhecido|eu \(autochat\))$/i.test(contactName) &&
      contactName !== String(from || '').split('@')[0];
    if (hasRealName) {
      systemPrompt += `

NOME DO CLIENTE: ${contactName}
- Use o nome do cliente de forma natural quando fizer sentido (saudacao, ao confirmar pedido, ao despedir).
- Exemplos: "Oi ${contactName.split(' ')[0]}, em que posso ajudar?" ou "Fechado, ${contactName.split(' ')[0]}!".
- NAO repita o nome em toda frase - no maximo uma vez por resposta.`;
    }

    const priorTurns = this.buildHistoryTurns(this.getHistory(zapId, chat.id));
    const messages = [
      { role: 'system', content: systemPrompt },
      ...priorTurns,
      { role: 'user', content: body }
    ];

    // Build fallback list: primary model first, then all others
    const fallbackQueue = [];

    // Primary model
    const primaryKey = `${zapConfig.provider.name}|${zapConfig.model.id}`;
    fallbackQueue.push({
      provider: zapConfig.provider,
      model: zapConfig.model,
      key: primaryKey
    });

    // Add all other models from all providers as fallback
    if (allProviders && Array.isArray(allProviders)) {
      for (const provider of allProviders) {
        if (!provider.models) continue;
        // Chave efetiva do provedor (apiKeys[] > apiKey legado) - sem isso,
        // fallbacks usariam chave antiga morta mesmo com chave nova salva
        const effKey = this.resolveProviderKey(provider);
        if (!effKey) continue;
        for (const model of provider.models) {
          const modelKey = `${provider.name}|${model.id}`;
          if (modelKey === primaryKey) continue;
          // Prefer free models
          fallbackQueue.push({
            provider: { ...provider, apiKey: effKey },
            model,
            key: modelKey,
            free: model.free || false
          });
        }
      }
    }

    // Sort fallbacks: free models first after primary
    fallbackQueue.sort((a, b) => {
      if (a.key === primaryKey) return -1;
      if (b.key === primaryKey) return 1;
      if (a.free && !b.free) return -1;
      if (!a.free && b.free) return 1;
      return 0;
    });

    // Try each model
    let lastError = null;
    for (const entry of fallbackQueue) {
      if (!this.isModelAvailable(entry.key)) {
        console.log(`[FALLBACK] Pulando ${entry.key} (falhou recentemente)`);
        continue;
      }

      try {
        console.log(`[FALLBACK] Tentando ${entry.provider.name} / ${entry.model.id}...`);
        const response = await this.callAI(entry.provider, entry.model, messages);
        const text = typeof response === 'string' ? response.trim() : '';

        if (text.length > 0) {
          if (this.isJunkResponse(text)) {
            lastError = 'Resposta invalida (texto de sistema/erro) - descartada';
            this.markModelFailed(entry.key);
            console.log(`[FALLBACK] ${entry.key} retornou texto invalido - NAO enviado ao cliente: "${text.substring(0, 80)}"`);
            continue;
          }
          this.markModelSuccess(entry.key);
          this.addToHistory(zapId, chat.id, 'user', body);
          this.addToHistory(zapId, chat.id, 'assistant', text);
          console.log(`[FALLBACK] Sucesso com ${entry.provider.name} / ${entry.model.id}`);
          return text;
        }
      } catch (error) {
        lastError = error;
        this.markModelFailed(entry.key);
        console.log(`[FALLBACK] Falha em ${entry.provider.name} / ${entry.model.id}: ${error.message}`);
      }
    }

    console.error(`[FALLBACK] Todos os modelos falharam. Ultimo erro:`, lastError?.message);
    return null;
  }

  async callAI(provider, model, messages) {
    const providerName = provider.name.toLowerCase();
    const apiKey = provider.apiKey;

    if (providerName.includes('openrouter')) {
      return this.callOpenRouter(model.id, apiKey, messages);
    }

    if (providerName.includes('google')) {
      return this.callGoogleAI(model.id, apiKey, messages);
    }

    if (providerName.includes('openai') || providerName.includes('groq') || providerName.includes('deepseek') || providerName.includes('mistral')) {
      return this.callOpenAICompatible(providerName, model.id, apiKey, messages);
    }

    // Fallback: try OpenAI-compatible for any other provider (anthropic via openrouter, etc.)
    // If model id looks like provider/model (openrouter style), use OpenRouter
    if (model.id && model.id.includes('/')) {
      return this.callOpenRouter(model.id, apiKey, messages);
    }
    return this.callOpenAICompatible(providerName, model.id, apiKey, messages);
  }

  // Resposta cortada no meio (finish_reason=length / MAX_TOKENS): corta na
  // ultima frase completa. Se nao houver nenhuma frase completa, devolve null
  // e o chamador falha - assim NUNCA um texto pela metade vai ao cliente.
  finishTruncated(text) {
    const t = String(text || '').trim();
    if (!t) return null;
    let cut = -1;
    for (let i = t.length - 1; i >= 0; i--) {
      const c = t[i];
      if (c === '.' || c === '!' || c === '?' || c === '…') { cut = i + 1; break; }
    }
    if (cut < 10) return null;
    const out = t.slice(0, cut).trim();
    return out.length >= 10 ? out : null;
  }

  // ---------------------------------------------------------------
  // Mensagens multiplas: a IA marca onde separar com [QUEBRA] e aqui
  // isso vira 1..4 baloes. Regras:
  //  - se a IA usou [QUEBRA], respeita a separacao dela
  //  - se nao usou e o texto e curto, manda TUDO em 1 mensagem
  //  - se nao usou e o texto e grande, separa por frases (nunca no meio de palavra)
  //  - NUNCA mais de MAX_MESSAGES mensagens
  // ---------------------------------------------------------------
  splitMessages(text) {
    const t = typeof text === 'string' ? text.trim() : '';
    if (!t) return [];

    const SPLIT_RE = /\s*\[(?:QUEBRA|BREAK|NOVA[_\s-]?MENSAGEM|MSG)\]\s*/i;
    let parts;
    if (SPLIT_RE.test(t)) {
      parts = t.split(SPLIT_RE);
    } else if (t.length > this.SPLIT_THRESHOLD) {
      parts = this.packSentences(t);
    } else {
      parts = [t];
    }

    parts = parts
      .map(p => String(p || '')
        .replace(/\[(?:QUEBRA|BREAK|NOVA[_\s-]?MENSAGEM|MSG)\]/gi, '') // sobra de marcador
        .replace(/\s+/g, ' ')
        .trim())
      .filter(Boolean);

    parts = this.breakLongParts(parts);
    return this.clampToMax(parts);
  }

  // Frases completas (nunca corta no meio de uma palavra)
  splitSentences(text) {
    return String(text || '')
      .split(/(?<=[.!?…])\s+|\n+/)
      .map(s => s.trim())
      .filter(Boolean);
  }

  // Texto grande sem [QUEBRA]: distribui as frases em 2..4 baloes equilibrados
  packSentences(text) {
    const sentences = this.splitSentences(text);
    if (sentences.length <= 1) return [text];

    const target = Math.max(Math.ceil(text.length / this.MAX_MESSAGES), Math.ceil(this.SPLIT_THRESHOLD / 2));
    const out = [];
    let cur = '';
    for (const s of sentences) {
      if (cur && (cur.length + 1 + s.length) > target && out.length < this.MAX_MESSAGES - 1) {
        out.push(cur);
        cur = '';
      }
      cur = cur ? `${cur} ${s}` : s;
    }
    if (cur) out.push(cur);
    return out.length ? out : [text];
  }

  // Uma parte ainda enorme (a IA mandou 1 bloco so) -> abre pelo meio,
  // sempre na fronteira de frase mais proxima do centro
  breakLongParts(parts) {
    const out = parts.slice();
    while (out.length < this.MAX_MESSAGES) {
      let idx = -1;
      for (let i = 0; i < out.length; i++) {
        if (out[i].length > this.SPLIT_THRESHOLD && (idx < 0 || out[i].length > out[idx].length)) idx = i;
      }
      if (idx < 0) break;

      const sentences = this.splitSentences(out[idx]);
      if (sentences.length < 2) break; // nao da pra separar sem cortar frase

      const total = out[idx].length;
      let acc = 0;
      let cut = 1;
      let bestDiff = Infinity;
      for (let i = 0; i < sentences.length - 1; i++) {
        acc += sentences[i].length + 1;
        const diff = Math.abs(acc - total / 2);
        if (diff < bestDiff) { bestDiff = diff; cut = i + 1; }
      }

      const a = sentences.slice(0, cut).join(' ').trim();
      const b = sentences.slice(cut).join(' ').trim();
      if (!a || !b) break;
      out.splice(idx, 1, a, b);
    }
    return out;
  }

  // Teto absoluto: se passou, junta o excesso na ultima mensagem
  clampToMax(parts) {
    if (parts.length <= this.MAX_MESSAGES) return parts;
    const head = parts.slice(0, this.MAX_MESSAGES - 1);
    const tail = parts.slice(this.MAX_MESSAGES - 1).join(' ');
    return head.concat(tail);
  }

  async callOpenRouter(modelId, apiKey, messages) {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://link-no-whatsapp.app',
        'X-Title': 'Link no WhatsApp'
      },
      body: JSON.stringify({
        model: modelId,
        messages,
        max_tokens: 2048,
        temperature: 0.6
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error?.message || `Erro HTTP: ${response.status}`);
    }

    const choice = Array.isArray(data.choices) ? data.choices[0] : null;
    const content = typeof choice?.message?.content === 'string' ? choice.message.content : '';
    if (!content) return '';
    if (choice?.finish_reason === 'length') {
      const complete = this.finishTruncated(content);
      if (!complete) throw new Error('Resposta cortada pelo limite de tokens (sem frase completa)');
      return complete;
    }
    return content;
  }

  async callGoogleAI(modelId, apiKey, messages) {
    // Mapeamento defensivo de IDs de modelos: se o usuário ou banco antigo tiver IDs legados/inexistentes
    let effectiveModel = modelId;
    if (modelId === 'gemini-3.6-flash') effectiveModel = 'gemini-2.5-flash';
    else if (modelId === 'gemini-3.5-flash-lite' || modelId === 'gemini-3.1-flash-lite') effectiveModel = 'gemini-2.5-flash-lite';

    // Gemini requires role: "user" | "model". Map assistant -> model
    const contents = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }));

    const systemInstruction = messages.find(m => m.role === 'system');

    const body = {
      contents,
      generationConfig: {
        maxOutputTokens: 2048,
        temperature: 0.6
      }
    };

    if (systemInstruction) {
      body.systemInstruction = {
        parts: [{ text: systemInstruction.content }]
      };
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${effectiveModel}:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error?.message || `Erro HTTP: ${response.status}`);
    }

    const cand = Array.isArray(data.candidates) ? data.candidates[0] : null;
    if (!cand) {
      const reason = (data.promptFeedback && (data.promptFeedback.blockReason || data.promptFeedback.blockReasonMessage)) || 'sem candidatos';
      throw new Error(`Gemini sem resposta: ${reason}`);
    }

    const parts = (cand.content && Array.isArray(cand.content.parts)) ? cand.content.parts : [];
    // So o texto visivel: partes com thought=true sao pensamento oculto da IA
    // (pode conter coisas como "Check Constreainsts:...") e NUNCA vao ao cliente.
    let text = parts
      .filter(p => p && typeof p.text === 'string' && !p.thought)
      .map(p => p.text)
      .join('');

    // Fallback: se o modelo respondeu com thought mas não separou em partes explícitas,
    // ou se todas as partes foram filtradas mas há texto limpo disponível
    if (!text.trim() && parts.length > 0) {
      const rawText = parts.map(p => (p && typeof p.text === 'string') ? p.text : '').join('');
      const cleaned = rawText.replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim();
      if (cleaned) text = cleaned;
    }

    if (!text.trim()) {
      throw new Error(`Gemini sem texto visivel (finishReason=${cand.finishReason || 'desconhecido'})`);
    }

    // Cortado no meio (tokens esgotados pelo thinking ou pelo limite): so
    // envia se terminar em frase completa, senao falha e outro modelo e tentado.
    const fr = String(cand.finishReason || '');
    if (/MAX_TOKENS|LENGTH/i.test(fr)) {
      const complete = this.finishTruncated(text);
      if (!complete) throw new Error(`Resposta cortada pelo limite de tokens (finishReason=${fr})`);
      return complete;
    }
    return text;
  }

  async callOpenAICompatible(providerName, modelId, apiKey, messages) {
    const baseUrl = providerName.includes('groq') ? 'https://api.groq.com/openai' :
                    providerName.includes('deepseek') ? 'https://api.deepseek.com' :
                    providerName.includes('mistral') ? 'https://api.mistral.ai' :
                    'https://api.openai.com';

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: modelId,
        messages,
        max_tokens: 2048,
        temperature: 0.6
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error?.message || `Erro HTTP: ${response.status}`);
    }

    const choice = Array.isArray(data.choices) ? data.choices[0] : null;
    const content = typeof choice?.message?.content === 'string' ? choice.message.content : '';
    if (!content) return '';
    if (choice?.finish_reason === 'length') {
      const complete = this.finishTruncated(content);
      if (!complete) throw new Error('Resposta cortada pelo limite de tokens (sem frase completa)');
      return complete;
    }
    return content;
  }
}

module.exports = AIResponder;
