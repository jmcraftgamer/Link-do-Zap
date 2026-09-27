class AIResponder {
  constructor() {
    this.conversationHistory = new Map();
    this.failedModels = new Map(); // modelKey -> timestamp of last failure
    this.FAILED_COOLDOWN = 5 * 60 * 1000; // 5 minutes cooldown for failed models
    this.defaultPrompt = `Voce e um jovem de 17 anos, homem, que gosta de celulares e tecnologia. Voce conversa no WhatsApp como uma pessoa normal, educada e que sabe puxar conversa.

REGRAS DE RESPOSTA (IMPORTANTE):
- Responda com NO MAXIMO 1 frase. 2 frases so se realmente necessario. NUNCA mais que 2 linhas.
- Se a pessoa mandar "oi" ou "ola", responda em 1 frase curta: "Oi, em que posso ajudar?".
- Nao faca listas, nao faca paragrafos, nao seja formal e NAO repita a pergunta da pessoa.
- Responda apenas o que foi perguntado. Nao adicione informacoes extras, nem explicacoes longas.

ESTILO DE CONVERSA:
- Use abreviacoes como "tmj" (tamo junto), "vlw" (valeu), "blz" (beleza), "td bem" (tudo bem) AS VEZES, nao sempre.
- Use "kkkkkk" ou "rsrsrs" quando a conversa for engraçada ou divertida.
- Seja descontraido, mas educado.
- Fale como um jovem normal no WhatsApp.`;
  }

  getPersonalities() {
    return {
      'padrao': this.defaultPrompt,
      'vendedor': `Voce e um vendedor experiente, educado, bom de conversa e divertido, treinado nas tecnicas de negociacao do FBI. Seu objetivo e guiar o cliente ate a compra usando empatia tactica, sem parecer um vendedor chato ou agressivo.

REGRAS DE RESPOSTA (IMPORTANTE):
- Responda com NO MAXIMO 1 frase (2 no maximo). NUNCA mais que 2 linhas. Sem preambulo, direto ao ponto.
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
- Responda com NO MAXIMO 1 frase (2 no maximo). NUNCA mais que 2 linhas. Sem preambulo, direto ao ponto.
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
- Responda com NO MAXIMO 1 frase (2 no maximo). NUNCA mais que 2 linhas. Sem preambulo, direto ao ponto.
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

    // Sempre por ultimo: o final do system prompt e o trecho que o modelo mais obedece.
    base += `

FORMATO DA RESPOSTA (LEIA POR ULTIMO - OBRIGATORIO):
- Responda com NO MAXIMO 1 frase. 2 frases so se realmente necessario. NUNCA mais de 2 linhas.
- Direto ao ponto: sem preambulo ("Claro!", "Olha", "Certo!"), sem repetir a pergunta da pessoa, sem fechar com frase de efeito.
- Saudacao ("oi", "ola", "bom dia") -> 1 frase: "Oi, em que posso ajudar?".
- Pergunta simples -> so a resposta, 1 frase: "Sai por R$ 50, quer que eu reserve?".
- Nao use listas, nao use marcadores e nao quebre linha: tudo em uma unica linha.
- UNICA EXCECAO a "nao use marcadores": quando o cliente pedir imagem ou link, os marcadores [SEND_IMAGE:id] e [SEND_LINK:id] sao OBRIGATORIOS. Sem eles nada e enviado.
- Economia de tokens: quanto mais curta e direta a resposta, melhor.`;

    return base;
  }

  getHistory(zapId, chatId) {
    const key = `${zapId}:${chatId}`;
    if (!this.conversationHistory.has(key)) {
      this.conversationHistory.set(key, []);
    }
    return this.conversationHistory.get(key);
  }

  addToHistory(zapId, chatId, role, content) {
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
    const key = `${zapId}:${chatId}`;
    this.conversationHistory.delete(key);
  }

  clearHistoryForZap(zapId) {
    const prefix = `${zapId}:`;
    for (const k of Array.from(this.conversationHistory.keys())) {
      if (k.startsWith(prefix)) this.conversationHistory.delete(k);
    }
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
      const keys = (Array.isArray(provider.apiKeys) && provider.apiKeys.length)
        ? provider.apiKeys
        : (Array.isArray(provider.keys) && provider.keys.length)
          ? provider.keys
          : (provider.apiKey ? [provider.apiKey] : []);
      if (!keys.length) return null;
      const sel = zap.apiKeySelections && zap.apiKeySelections[provider.id];
      const idx = (sel != null && sel >= 0 && sel < keys.length) ? sel : 0;
      return keys[idx] || keys[0];
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
    const modelId = models.find(id => id.includes('flash')) || models[0] || 'gemini-3.6-flash';
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

    this.addToHistory(zapId, chat.id, 'user', body);

    const history = this.getHistory(zapId, chat.id);
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

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.slice(-6)
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
        for (const model of provider.models) {
          const modelKey = `${provider.name}|${model.id}`;
          if (modelKey === primaryKey) continue;
          // Prefer free models
          fallbackQueue.push({
            provider,
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

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;
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
    const text = parts
      .filter(p => p && typeof p.text === 'string' && !p.thought)
      .map(p => p.text)
      .join('');

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
