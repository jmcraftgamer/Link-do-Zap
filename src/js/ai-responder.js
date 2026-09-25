class AIResponder {
  constructor() {
    this.conversationHistory = new Map();
    this.failedModels = new Map(); // modelKey -> timestamp of last failure
    this.FAILED_COOLDOWN = 5 * 60 * 1000; // 5 minutes cooldown for failed models
    this.defaultPrompt = `Voce e um jovem de 17 anos, homem, que gosta de celulares e tecnologia. Voce conversa no WhatsApp como uma pessoa normal, educada e que sabe puxar conversa.

REGRAS DE RESPOSTA (IMPORTANTE):
- Respostas curtas: maximo 1-2 frases. NUNCA mais que 2 linhas.
- Se a pessoa mandar "oi", responda algo como "Oi, tudo bem?" ou "Oii, e ai?"
- Nao faca listas, nao faca paragrafos, nao seja formal.
- Responda apenas o que foi perguntado. Nao adicione informacoes extras.

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
- Respostas curtas: maximo 1-2 frases. NUNCA mais que 2 linhas.
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
- Respostas curtas: maximo 1-2 frases. NUNCA mais que 2 linhas.
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
- Respostas curtas: maximo 1-2 frases. NUNCA mais que 2 linhas.
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

    for (const t of enabled) {
      const title = (t.title || '').trim();
      const content = (t.content || '').trim();
      const images = Array.isArray(t.images) ? t.images : [];

      let block = '';
      if (title) block += `[${title}]\n`;
      if (content) block += content + '\n';

      for (const img of images) {
        if (!img || !img.id) continue;
        const label = (img.description || img.filename || 'imagem').trim();
        const titleHint = title ? ` (treinamento: ${title})` : '';
        imageLines.push(`- [SEND_IMAGE:${img.id}] -> ${label}${titleHint}`);
      }

      if (section.length + block.length > MAX) break;
      section += block + '\n';
    }

    if (imageLines.length > 0) {
      section += `
IMAGENS DISPONIVEIS PARA ENVIAR:
Quando o cliente pedir uma imagem (cardapio, catalogo, foto, etc), inclua o marcador [SEND_IMAGE:id] exatamente na resposta. O sistema envia a imagem automaticamente e a marcacao sera removida do texto.
${imageLines.join('\n')}
Exemplo de resposta: "Claro! Aqui esta o cardapio: [SEND_IMAGE:img123]"
Nao descreva a imagem - envie o marcador e pronto. Pode mandar texto junto ou so o marcador.`;
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

      base += `

REGRA UNIVERSAL DE ENTENDIMENTO:
- Se voce NAO entender a mensagem, NAO tente adivinhar ou responder algo fora do assunto.
- Responda pedindo para a pessoa repetir, de forma natural. Exemplos: "Nao entendi, pode repetir?" ou "Pode mandar de novo? Nao peguei bem".
- Isso vale para textos confusos, mensagens muito curtas sem contexto, audios com transcricao ruim, ou qualquer situacao em que voce tenha duvida real sobre o que a pessoa quis dizer.
- Quando tiver duvida, SEMPRE pedir para repetir em vez de arriscar uma resposta errada.`;
    }

    const trainingsSection = this.buildTrainingsSection(trainings);
    if (trainingsSection) {
      base += '\n\n' + trainingsSection;
    }

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
      if (provider.apiKey) return provider.apiKey;
      if (Array.isArray(provider.apiKeys) && provider.apiKeys.length) {
        const sel = zap.apiKeySelections && zap.apiKeySelections[provider.id];
        const idx = sel != null ? sel : 0;
        return provider.apiKeys[idx] || provider.apiKeys[0];
      }
      if (Array.isArray(provider.keys) && provider.keys.length) {
        const sel = zap.apiKeySelections && zap.apiKeySelections[provider.id];
        const idx = sel != null ? sel : 0;
        return provider.keys[idx] || provider.keys[0];
      }
      return null;
    };

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

  async transcribeAudio(audio, providersData, zapId, apiKeySelections) {
    // audio: { data: base64, mimetype, size }
    // Try OpenAI Whisper via any provider with key, prefer openai/groq/openrouter
    const candidates = [];
    for (const p of (providersData || [])) {
      const name = (p.name || '').toLowerCase();
      let key = p.apiKey;
      if (!key && Array.isArray(p.apiKeys) && p.apiKeys.length) {
        const sel = apiKeySelections && apiKeySelections[p.id];
        key = p.apiKeys[sel != null ? sel : 0] || p.apiKeys[0];
      }
      if (!key) continue;
      if (name.includes('openai') || name.includes('groq') || name.includes('openrouter')) candidates.push({ p, key, name });
    }
    // fallback any provider with key
    if (candidates.length === 0) {
      for (const p of (providersData || [])) {
        let key = p.apiKey;
        if (!key && Array.isArray(p.apiKeys) && p.apiKeys.length) key = p.apiKeys[0];
        if (key) { candidates.push({ p, key, name: (p.name||'').toLowerCase() }); break; }
      }
    }
    if (candidates.length === 0) throw new Error('Nenhum provedor com chave para transcrever audio');

    let b64 = audio.data || '';
    const commaIdx = b64.indexOf(',');
    if (b64.startsWith('data:') && commaIdx !== -1) b64 = b64.slice(commaIdx + 1);
    const buf = Buffer.from(b64.trim(), 'base64');
    // Try each candidate via OpenAI-compatible transcription endpoint
    let lastErr = null;
    for (const c of candidates) {
      try {
        // Use OpenAI Whisper API: POST /v1/audio/transcriptions with multipart
        // For simplicity, use Groq/OpenAI endpoint if available, else OpenRouter
        let url = 'https://api.openai.com/v1/audio/transcriptions';
        if (c.name.includes('groq')) url = 'https://api.groq.com/openai/v1/audio/transcriptions';
        else if (c.name.includes('openrouter')) url = 'https://openrouter.ai/api/v1/audio/transcriptions';

        const form = new FormData();
        // Node 18+ has global FormData/Blob
        const blob = new Blob([buf], { type: audio.mimetype || 'audio/ogg' });
        form.append('file', blob, 'audio.ogg');
        form.append('model', c.name.includes('groq') ? 'whisper-large-v3' : 'whisper-1');
        form.append('language', 'pt');

        const headers = { 'Authorization': `Bearer ${c.key}` };
        if (c.name.includes('openrouter')) {
          headers['HTTP-Referer'] = 'https://link-no-whatsapp.app';
          headers['X-Title'] = 'Link no WhatsApp';
        }
        const resp = await fetch(url, { method: 'POST', headers, body: form });
        const j = await resp.json();
        if (!resp.ok) throw new Error(j.error?.message || `HTTP ${resp.status}`);
        const text = j.text || j.transcription || '';
        if (text && text.trim()) return text.trim();
        throw new Error('Transcricao vazia');
      } catch (e) { lastErr = e; continue; }
    }
    throw lastErr || new Error('Falha na transcricao');
  }

  async generateResponse(messageData, zapConfig, allProviders) {
    const { zapId, body, from, chat } = messageData;

    if (!zapConfig || !zapConfig.provider || !zapConfig.model) {
      return null;
    }

    this.addToHistory(zapId, chat.id, 'user', body);

    const history = this.getHistory(zapId, chat.id);
    const systemPrompt = this.getSystemPrompt(zapConfig);

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

        if (response && response.trim().length > 0) {
          this.markModelSuccess(entry.key);
          this.addToHistory(zapId, chat.id, 'assistant', response);
          console.log(`[FALLBACK] Sucesso com ${entry.provider.name} / ${entry.model.id}`);
          return response;
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
        max_tokens: 350,
        temperature: 0.8
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error?.message || `Erro HTTP: ${response.status}`);
    }

    return data.choices?.[0]?.message?.content || '';
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
        maxOutputTokens: 350,
        temperature: 0.8
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

    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
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
        max_tokens: 350,
        temperature: 0.8
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error?.message || `Erro HTTP: ${response.status}`);
    }

    return data.choices?.[0]?.message?.content || '';
  }
}

module.exports = AIResponder;
