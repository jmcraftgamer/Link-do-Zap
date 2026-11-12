// Pipeline de mensagem recebida -> IA -> envio.
// Porte fiel de `processMessage` do main.js, mas sem depender de Electron:
// tudo que era global agora vem por injecao (deps).
const path = require('path');
const fs = require('fs');

const { resolveReplyMedia } = require('../../js/media-resolver');
const { verifyMessage } = require('../../js/message-guard');
const { isWithinWorkHours } = require('../../js/work-hours');

const MEMORY_DAYS = 3;
const MEMORY_MAX_CHARS = 6000;
const QUOTE_CHANCE = 0.35;

function defaultResolveProviderKey(provider) {
  if (!provider) return null;
  if (provider.apiKey) return { ...provider, apiKey: provider.apiKey };
  if (Array.isArray(provider.apiKeys) && provider.apiKeys.length) {
    const k = provider.apiKeys.find((key) => key && key.trim());
    if (k) return { ...provider, apiKey: k };
  }
  if (Array.isArray(provider.keys) && provider.keys.length) {
    const k = provider.keys.find((key) => key && key.trim());
    if (k) return { ...provider, apiKey: k };
  }
  return provider;
}

function memoryFileText(contactName, zapId, chatId, body) {
  const head = [
    'MEMORIA DE CONVERSAS',
    `Cliente: ${contactName || chatId}`,
    `Zap: ${zapId}    Contato: ${chatId}`,
    `Gerado em: ${new Date().toISOString()}`,
    `Periodo: ultimos ${MEMORY_DAYS} dias`,
    '------------------------------------------------------------'
  ].join('\n');
  return `${head}\n${body}\n`;
}

function createMessagePipeline(deps) {
  const getWhatsapp = deps.getWhatsapp || (() => null);
  const getAiResponder = deps.getAiResponder || (() => null);
  const getConversationStore = deps.getConversationStore || (() => null);
  const loadZaps = deps.loadZaps || (() => []);
  const loadProviders = deps.loadProviders || (() => []);
  const loadTrainings = deps.loadTrainings || (() => ({}));
  const checkBilling = deps.checkBillingActive || (() => ({ active: true, reason: 'no_plan' }));
  const isServerPaused = deps.isServerPaused || (() => false);
  const isServerMode = deps.isServerMode || (() => false);
  const log = deps.log || (() => {});
  const paths = deps.paths || {};
  const typing = deps.typing;
  const resolveProviderKey = deps.resolveProviderKey || defaultResolveProviderKey;

  if (!typing) throw new Error('createMessagePipeline: dependencia typing obrigatoria');

  // Fila por conversa: mensagens do MESMO chat sao processadas na ordem em que
  // chegaram. Sem isso a IA poderia responder a segunda antes da primeira.
  const chatQueues = new Map();

  async function sendErrorToWhatsApp(zapId, chatId, msg) {
    const manager = getWhatsapp();
    try {
      const clientData = manager && manager.clients ? manager.clients.get(String(zapId)) : null;
      const chat = clientData && clientData.chats ? clientData.chats.get(chatId) : null;
      if (chat && chat.sendStateTyping) {
        try { await chat.clearState(); } catch (_) {}
      }
    } catch (_) {}
    try {
      await manager.sendMessage(String(zapId), chatId, msg, { source: 'ai' });
      log(zapId, 'warning', 'Mensagem de erro enviada ao contato');
    } catch (e) {
      log(zapId, 'error', `Nao foi possivel enviar mensagem de erro: ${e.message}`);
    }
  }

  async function transcribeAudio(audio, providersData, zapId, apiKeySelections) {
    const responder = getAiResponder();
    if (responder && typeof responder.transcribeAudio === 'function') {
      const logFn = (type, msg) => log(zapId, type, msg);
      return await responder.transcribeAudio(audio, providersData, zapId, apiKeySelections, logFn);
    }
    const anyProvider = (providersData || []).find((p) =>
      p.apiKey || (Array.isArray(p.apiKeys) && p.apiKeys[0]));
    if (!anyProvider) throw new Error('Nenhum provedor com chave para transcrever audio');
    throw new Error('Transcricao de audio nao configurada');
  }

  async function processMessage(messageData) {
    const manager = getWhatsapp();
    const aiResponder = getAiResponder();
    const conversationStore = getConversationStore();
    const { zapId, body, from, to, fromMe, chat, contact, audio } = messageData;
    const contactName = contact?.name || from;
    const chatId = chat?.id || from;
    const audioFailed = !!messageData.audioFailed;
    const triggerTs = messageData.timestamp || Math.floor(Date.now() / 1000);

    // ================= GRUPOS: CORTE NO TOPO =================
    const jidRef = String(chatId || from || to || '');
    const isGroupMsg = !!messageData.isGroup ||
      !!(chat && chat.isGroup) ||
      jidRef.includes('@g.us') ||
      jidRef.includes('@newsletter') ||
      jidRef.includes('@broadcast');
    if (isGroupMsg) {
      console.log(`[GRUPO] mensagem de grupo nao processada (zap ${zapId}) - IA bloqueada`);
      return { ok: false, reason: 'group' };
    }

    // Bot desligado pelo painel.
    if (!isServerMode() && isServerPaused()) {
      log(zapId, 'info', 'Servidor desligado pelo painel - IA ignorada.');
      return { ok: false, reason: 'paused' };
    }

    if (fromMe) {
      if (!messageData.selfChat) {
        log(zapId, 'info', 'Ignorada: mensagem enviada por mim para outro contato.');
        return { ok: false, reason: 'from_me' };
      }
      log(zapId, 'ai', `Autochat: IA iniciando para o proprio numero (${(to || from || '').split('@')[0]}): "${body}"`);
    } else {
      log(zapId, 'ai', `IA iniciando para ${contactName}: "${body}"`);
    }

    const zapsData = loadZaps();
    const providersData = loadProviders();
    const trainingsAll = loadTrainings();
    const zapTrainings = trainingsAll[String(zapId)] || [];
    const zap = zapsData.find((z) => String(z.id) === String(zapId));

    if (!zap) {
      log(zapId, 'error', 'Zap nao encontrado no arquivo.');
      return { ok: false, reason: 'zap_not_found' };
    }
    if (zap.enabled === false) {
      log(zapId, 'warning', 'Zap desativado. Ignorando mensagem.');
      return { ok: false, reason: 'zap_disabled' };
    }
    // ================= PLANO DE PAGAMENTO =================
    const billing = checkBilling(zap);
    if (!billing.active && billing.reason !== 'own_use' && billing.reason !== 'no_plan') {
      log(zapId, 'warning', 'Zap suspenso por atraso de pagamento (mes ' + billing.todayKey + '). Mensagem ignorada.');
      return { ok: false, reason: 'billing', billing };
    }
    if (zap.autoReply === false) {
      log(zapId, 'warning', 'Auto-reply desativado para este Zap');
      return { ok: false, reason: 'auto_reply_off' };
    }

    // Horario de atendimento
    if (zap.workHours && zap.workHours.enabled === true && !isWithinWorkHours(zap.workHours)) {
      log(zapId, 'info', `Fora do horario de atendimento (${zap.workHours.start}-${zap.workHours.end}) - mensagem ignorada, nao enviada a IA.`);
      return { ok: false, reason: 'work_hours' };
    }
    // Contatos bloqueados
    if (zap.blockedContacts && zap.blockedContacts.length) {
      const fromNumber = (from || '').split('@')[0];
      const isBlocked = zap.blockedContacts.some((b) => {
        if (!b) return false;
        if (b.includes('@')) return b === from || b.split('@')[0] === fromNumber;
        return b === fromNumber || b === from;
      });
      if (isBlocked) {
        log(zapId, 'warning', `Contato ${contactName} nao autorizado para IA. Ignorando.`);
        return { ok: false, reason: 'blocked_contact' };
      }
    }

    const enabledTrainings = zapTrainings.filter((t) => t && t.enabled !== false);
    log(zapId, 'info', `Config: modelo=${zap.model || 'auto'}, personalidade=${zap.personality || 'padrao'}, treinos=${enabledTrainings.length}`);

    let convResult = null;
    if (conversationStore) {
      try {
        convResult = conversationStore.ensure(zapId, chatId, Date.now());
        if (convResult.created) {
          log(zapId, 'info', `Nova conversa iniciada com ${contactName} (historico anterior: ${conversationStore.countFor(zapId, chatId) - 1} conversa(s))`);
        }
      } catch (e) {
        log(zapId, 'warning', `Memoria indisponivel: ${e.message}`);
        convResult = null;
      }
    }
    // ---- Memoria de conversas (ultimos 3 dias) ----
    let memoryText = '';
    try {
      if (conversationStore) {
        memoryText = conversationStore.memoryText(zapId, chatId, { days: MEMORY_DAYS, maxChars: MEMORY_MAX_CHARS });
      }
    } catch (e) {
      log(zapId, 'warning', `Memoria indisponivel: ${e.message}`);
    }
    if (memoryText) {
      try {
        const mdir = path.join(paths.getDataDir(), 'memorias', String(zapId));
        fs.mkdirSync(mdir, { recursive: true });
        const safeChat = String(chatId).replace(/[^A-Za-z0-9@._-]/g, '_');
        const mfile = path.join(mdir, `${safeChat}.txt`);
        fs.writeFileSync(mfile, memoryFileText(contactName, zapId, chatId, memoryText));
        log(zapId, 'info', `Memoria de conversas anexada (${memoryText.split('\n').length} linha(s)) -> ${path.relative(paths.getDataDir(), mfile)}`);
      } catch (e) {
        log(zapId, 'warning', `Nao foi possivel gravar o arquivo de memoria: ${e.message}`);
      }
    }

    const conversationInfo = Object.assign(
      convResult ? {
        label: new Date(convResult.conversation.startedAt).toTimeString().substring(0, 5),
        count: convResult.conversation.messages.length
      } : {},
      memoryText ? { memoryText } : {}
    );

    let finalBody = body;

    // Audio detectado mas download falhou
    const bodyIsAudioPlaceholder = !body || body.trim() === '' || body === '[AUDIO]';
    if (audioFailed && (!audio || !audio.data) && bodyIsAudioPlaceholder) {
      log(zapId, 'warning', `Audio de ${contactName} nao pôde ser baixado. Pedindo para enviar como texto.`);
      await sendErrorToWhatsApp(zapId, chatId, 'Nao consegui baixar seu audio, pode mandar como texto?');
      log(zapId, 'outgoing', 'Mensagem de audio nao baixado respondida.');
      return { ok: false, reason: 'audio_download_failed' };
    }

    if (audio && (body === '[AUDIO]' || !body || body.trim() === '')) {
      log(zapId, 'info', `Audio recebido de ${contactName}. Transcrevendo...`);
      try {
        finalBody = await transcribeAudio(audio, providersData, zapId, zap.apiKeySelections);
        if (!finalBody || !finalBody.trim() || finalBody.trim().length < 2) {
          log(zapId, 'warning', 'Transcricao vazia ou invalida. Pedindo para repetir.');
          await manager.sendMessage(String(zapId), chatId, 'Nao consegui entender seu audio, pode repetir?', { source: 'ai' });
          log(zapId, 'outgoing', 'Mensagem de audio nao compreendido enviada.');
          return { ok: false, reason: 'audio_empty' };
        }
        if (finalBody.length < 3 || /^\W+$/.test(finalBody)) {
          log(zapId, 'warning', `Transcricao parece invalida: "${finalBody}". Pedindo para repetir.`);
          await manager.sendMessage(String(zapId), chatId, 'Nao entendi seu audio, pode mandar de novo?', { source: 'ai' });
          log(zapId, 'outgoing', 'Mensagem de audio invalida respondida.');
          return { ok: false, reason: 'audio_invalid' };
        }
        log(zapId, 'success', `Audio transcrito: "${finalBody.substring(0, 100)}"`);
      } catch (e) {
        log(zapId, 'error', `Erro na transcricao: ${e.message}`);
        await sendErrorToWhatsApp(zapId, chatId, 'Tive um problema para entender seu audio. Pode enviar como texto?');
        return { ok: false, reason: 'audio_error' };
      }
    }

    // Build modelsToTry
    let modelsToTry = [];
    if (aiResponder && typeof aiResponder.getModelsToTry === 'function') {
      modelsToTry = aiResponder.getModelsToTry(zap, providersData);
    } else if (zap.model === 'auto' || !zap.model) {
      log(zapId, 'info', 'Modo automatico: tentar todos os modelos disponiveis');
      for (const p of providersData) {
        const resolved = resolveProviderKey(p);
        if (!resolved.apiKey) continue;
        for (const m of (p.models || [])) {
          modelsToTry.push({ provider: resolved, model: m });
        }
      }
    } else {
      outer: for (const p of providersData) {
        for (const m of (p.models || [])) {
          if (m.id === zap.model) {
            const resolved = resolveProviderKey(p);
            modelsToTry.push({ provider: resolved, model: m });
            break outer;
          }
        }
      }
    }

    if (!modelsToTry || modelsToTry.length === 0) {
      log(zapId, 'error', 'Nenhum modelo disponivel em nenhum provedor');
      await sendErrorToWhatsApp(zapId, chatId, 'No momento estou sem conexao com a IA. Tente novamente em instantes.');
      return { ok: false, reason: 'no_model' };
    }
    log(zapId, 'info', `${modelsToTry.length} modelo(s) disponivel(is) para tentar`);

    // ---- 1) SORTEIO DO TEMPO ANTES DE COMECAR A RESPONDER ----
    if (zap.instantReply) {
      log(zapId, 'info', 'Resposta instantanea ativada - sorteio de tempo ignorado.');
    } else {
      const delayOptions = [2000, 3000, 5000];
      const preDelay = delayOptions[Math.floor(Math.random() * delayOptions.length)];
      log(zapId, 'info', `Sorteio de tempo de resposta: ${(preDelay / 1000)}s antes de comecar a digitar...`);
      await new Promise((resolve) => setTimeout(resolve, preDelay));
    }

    // ---- 2) INDICADOR "DIGITANDO" LIGA AQUI ----
    const typingStart = Date.now();
    await typing.send(zapId, chatId);
    log(zapId, 'info', 'Indicador "digitando" ativado - IA gerando a resposta...');

    let response = null;
    let lastError = null;

    for (let i = 0; i < modelsToTry.length; i++) {
      const entry = modelsToTry[i];
      const hasKey = !!(entry.provider && entry.provider.apiKey);
      log(zapId, 'ai', `[${i + 1}/${modelsToTry.length}] Tentando ${entry.provider.name} / ${entry.model.id} (chave: ${hasKey ? 'ok' : 'AUSENTE'})...`);

      const zapConfig = {
        aiName: zap.aiName || '',
        personality: zap.personality || 'padrao',
        area: zap.area || '',
        customPrompt: zap.customPrompt || '',
        provider: resolveProviderKey(entry.provider),
        model: entry.model,
        trainings: enabledTrainings,
        conversationInfo
      };

      try {
        const msgForAI = { ...messageData, body: finalBody };
        let r = null;
        if (aiResponder.generateResponse.length >= 3) {
          r = await aiResponder.generateResponse(msgForAI, zapConfig, providersData);
        } else {
          r = await aiResponder.generateResponse(msgForAI, zapConfig, providersData);
        }
        const isJunk = !!(aiResponder && typeof aiResponder.isJunkResponse === 'function' && aiResponder.isJunkResponse(r));
        if (r && r.trim().length > 0 && !isJunk) {
          response = r;
          log(zapId, 'success', `Resposta obtida com ${entry.provider.name} / ${entry.model.id}`);
          break;
        } else if (r && r.trim().length > 0) {
          log(zapId, 'warning', `${entry.provider.name} / ${entry.model.id} retornou texto invalido - descartado: "${r.trim().substring(0, 80)}"`);
          lastError = 'Resposta invalida do modelo (texto de sistema)';
        } else {
          log(zapId, 'warning', `${entry.provider.name} / ${entry.model.id} retornou vazio`);
          lastError = 'Resposta vazia';
        }
      } catch (e) {
        lastError = e.message;
        log(zapId, 'error', `${entry.provider.name} / ${entry.model.id} falhou: ${e.message}`);
      }
    }

    if (!response) {
      log(zapId, 'error', `Todos os modelos falharam. Ultimo erro: ${lastError}`);
      await typing.clear(zapId, chatId);
      await sendErrorToWhatsApp(zapId, chatId, 'Desculpe, tive um problema tecnico. Pode repetir sua mensagem?');
      return { ok: false, reason: 'all_models_failed', error: lastError };
    }

    const media = resolveReplyMedia(response, finalBody, enabledTrainings, (type, msg) => log(zapId, type, msg));
    const resolvedImages = media.images;
    const resolvedLinks = media.links;

    const rawParts = (aiResponder && typeof aiResponder.splitMessages === 'function')
      ? aiResponder.splitMessages(media.text)
      : (String(media.text || '').trim() ? [String(media.text || '').trim()] : []);

    const parts = [];
    for (const p of rawParts) {
      const v = verifyMessage(p, { incoming: finalBody });
      if (v.ok) parts.push(p);
      else log(zapId, 'warning', `Mensagem reprovada pelo verificador (${v.reason}) - NAO enviada: "${p.substring(0, 80)}"`);
    }
    if (rawParts.length > 0 && parts.length === 0) {
      log(zapId, 'error', 'Todas as mensagens foram reprovadas pelo verificador - enviando aviso padrao.');
      await typing.clear(zapId, chatId);
      await sendErrorToWhatsApp(zapId, chatId, 'Desculpe, tive um problema tecnico. Pode repetir sua mensagem?');
      return { ok: false, reason: 'guard_rejected' };
    }

    if (aiResponder && typeof aiResponder.updateLastAssistant === 'function') {
      const delivered = parts.length ? parts.join(' ') : (String(media.text || '').trim() || '(mensagem sem texto)');
      try { aiResponder.updateLastAssistant(zapId, chatId, delivered); } catch (_) {}
    }

    if (parts.length > 1) {
      log(zapId, 'info', `Resposta separada em ${parts.length} mensagens (maximo 4).`);
    }

    if (parts.length === 0) {
      await typing.clear(zapId, chatId);
    }

    // ---- 3.3) CITACAO EVENTUAL ----
    let quoteIndex = -1;
    if (parts.length > 1 && messageData.id && Math.random() < QUOTE_CHANCE) {
      quoteIndex = Math.floor(Math.random() * parts.length);
      log(zapId, 'info', `Resposta tera 1 mensagem citando a mensagem do cliente (balão ${quoteIndex + 1}/${parts.length}).`);
    }

    // ---- 4) ENTREGA: DIGITACAO REALISTA ENTRE CADA MENSAGEM ----
    for (let i = 0; i < parts.length; i++) {
      const text = parts[i];
      const partTypingStart = i === 0 ? typingStart : Date.now();
      if (i > 0) await typing.send(zapId, chatId);

      await typing.waitRealistic(zapId, chatId, partTypingStart, text);
      typing.clear(zapId, chatId).catch(() => {});

      let ownerReplied = false;
      if (i === 0 && manager && typeof manager.hasOwnerReplied === 'function') {
        try {
          ownerReplied = await manager.hasOwnerReplied(String(zapId), chatId, triggerTs, { live: true });
        } catch (e) {
          console.warn('[OWNER] falha ao checar resposta do dono:', e && e.message ? e.message : e);
          ownerReplied = true;
        }
      }
      if (ownerReplied) {
        log(zapId, 'info', 'Dono do numero ja respondeu esta conversa - IA nao vai responder por cima.');
        return { ok: false, reason: 'owner_replied' };
      }

      const preview = text.substring(0, 80);
      const label = parts.length > 1 ? `[${i + 1}/${parts.length}] ` : '';
      const citLabel = i === quoteIndex ? ' (citando a mensagem do cliente)' : '';
      log(zapId, 'outgoing', `Enviando ${label}${citLabel}: "${preview}..."`);
      try {
        const sendT0 = Date.now();
        if (i === quoteIndex && typeof manager.replyMessage === 'function') {
          await manager.replyMessage(String(zapId), chatId, text, messageData.id);
        } else {
          await manager.sendMessage(String(zapId), chatId, text, { source: 'ai' });
        }
        const sendSecs = ((Date.now() - sendT0) / 1000).toFixed(1);
        log(zapId, 'success', parts.length > 1
          ? `Mensagem ${i + 1}/${parts.length} enviada!${citLabel} (${sendSecs}s)`
          : `Mensagem enviada com sucesso!${citLabel} (${sendSecs}s)`);
      } catch (error) {
        log(zapId, 'error', `ERRO ao enviar: ${error.message}`);
        throw error;
      }
    }

    // Imagens de treinamento
    const sentImageLabels = [];
    for (const found of resolvedImages) {
      const imgId = found.id;
      const label = found.name || found.filename || imgId;
      const rel = found.file || null;
      if (!rel) {
        if (found.data) {
          try {
            await manager.sendMedia(String(zapId), chatId, { data: found.data, mimeType: found.mimeType || 'image/jpeg', name: found.filename || `${imgId}.jpg` }, { source: 'ai' });
            log(zapId, 'success', `Imagem enviada: ${label}`);
            sentImageLabels.push(label);
          } catch (e) {
            log(zapId, 'error', `Falha ao enviar imagem ${imgId}: ${e.message}`);
          }
          continue;
        }
        log(zapId, 'warning', `Arquivo da imagem ${imgId} nao encontrado no disco`);
        continue;
      }
      const abs = paths.resolveDataPath(rel);
      if (!abs || !fs.existsSync(abs)) {
        log(zapId, 'warning', `Arquivo da imagem ${imgId} nao encontrado no disco`);
        continue;
      }
      try {
        const b64 = fs.readFileSync(abs).toString('base64');
        await manager.sendMedia(String(zapId), chatId, { data: b64, mimeType: found.mimeType || 'image/jpeg', name: found.filename || path.basename(abs) }, { source: 'ai' });
        log(zapId, 'success', `Imagem enviada: ${label}`);
        sentImageLabels.push(label);
      } catch (e) {
        log(zapId, 'error', `Falha ao enviar imagem ${imgId}: ${e.message}`);
      }
    }

    if (resolvedLinks.length > 0) {
      log(zapId, 'success', `Link(s) enviado(s): ${resolvedLinks.map((l) => l.name || l.description || l.url).join(', ')}`);
    }

    const sentNotes = [];
    if (sentImageLabels.length) sentNotes.push(`imagem: ${sentImageLabels.join(', ')}`);
    if (resolvedLinks.length) sentNotes.push(`link: ${resolvedLinks.map((l) => l.name || l.description || l.url).join(', ')}`);
    if (sentNotes.length && conversationStore) {
      try {
        conversationStore.append(zapId, chatId, 'assistant', `[enviou ${sentNotes.join(' | ')}]`);
      } catch (e) {
        console.error('[CONV] falha ao registrar midia no historico:', e.message);
      }
    }

    if (parts.length === 0 && resolvedImages.length === 0 && resolvedLinks.length === 0) {
      log(zapId, 'warning', 'Resposta vazia apos remocao de marcadores de imagem');
    }

    return { ok: true, parts: parts.length, images: resolvedImages.length, links: resolvedLinks.length };
  }

  async function handleIncomingMessage(messageData) {
    const cid = (messageData.chat && messageData.chat.id) || messageData.from || messageData.to || '';
    const key = `${messageData.zapId}|${cid}`;
    const prev = chatQueues.get(key) || Promise.resolve();
    const run = prev
      .catch(() => {})
      .then(() => processMessage(messageData))
      .catch((e) => {
        console.error('handleIncomingMessage erro:', e);
        return { ok: false, reason: 'exception', error: e && e.message };
      });
    chatQueues.set(key, run);
    run.then(() => { if (chatQueues.get(key) === run) chatQueues.delete(key); });
    return run;
  }

  return { processMessage, handleIncomingMessage, chatQueues };
}

module.exports = {
  createMessagePipeline,
  MEMORY_DAYS,
  MEMORY_MAX_CHARS,
  QUOTE_CHANCE
};
