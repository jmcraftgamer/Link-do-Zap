const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const WhatsAppManager = require('./src/js/whatsapp-manager');
const AIResponder = require('./src/js/ai-responder');
const { resolveReplyMedia } = require('./src/js/media-resolver');

let mainWindow;
let whatsappManager;
let aiResponder;
let rendererDragging = false;

// Um evaluate do wwebjs numa pagina morta (teardown de LOGOUT) rejeita sem
// catcher e no Node derrubaria o processo inteiro - aqui so registra o erro
process.on('unhandledRejection', (reason) => {
  const msg = reason && reason.message ? reason.message : String(reason);
  console.error('[UNHANDLED] Promessa rejeitada sem tratamento:', msg);
});

// ------------------------------------------------------------
// Helpers - paths
// ------------------------------------------------------------
function getDataDir() {
  try {
    if (app && app.getPath) return path.join(app.getPath('userData'), 'link-no-whatsapp');
  } catch (_) {}
  const base = process.env.APPDATA || process.env.HOME || process.env.USERPROFILE || require('os').homedir();
  return path.join(base, 'link-no-whatsapp');
}
function getFilePath(filename) {
  return path.join(getDataDir(), filename);
}
function ensureDataDir() {
  const dir = getDataDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function loadJsonFile(filename, fallback) {
  const p = getFilePath(filename);
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
}
function loadZapsData() { return loadJsonFile('zaps.json', []); }
function loadProvidersData() { return loadJsonFile('providers.json', []); }
function loadTrainingsData() {
  return loadJsonFile('trainings.json', {});
}
function resolveDataPath(rel) {
  const base = path.resolve(getDataDir());
  const abs = path.resolve(base, rel);
  const relative = path.relative(base, abs);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  // Windows case-insensitive check
  if (abs.toLowerCase().indexOf(base.toLowerCase()) !== 0) return null;
  return abs;
}

// ------------------------------------------------------------
// Logging -> renderer log modal
// ------------------------------------------------------------
function sendLog(zapId, type, msg) {
  console.log(`[LOG][${type}] Zap ${zapId}: ${msg}`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('whatsapp-log', { zapId, type, msg });
  }
}

// ------------------------------------------------------------
// Provider helpers
// ------------------------------------------------------------
function resolveProviderKey(provider) {
  if (!provider) return null;
  // providers.json may have apiKey (single) or apiKeys (array) — pick first valid
  if (provider.apiKey) return { ...provider, apiKey: provider.apiKey };
  if (Array.isArray(provider.apiKeys) && provider.apiKeys.length) {
    const k = provider.apiKeys.find(k => k && k.trim());
    if (k) return { ...provider, apiKey: k };
  }
  if (Array.isArray(provider.keys) && provider.keys.length) {
    const k = provider.keys.find(k => k && k.trim());
    if (k) return { ...provider, apiKey: k };
  }
  return provider;
}

async function sendErrorToWhatsApp(zapId, chatId, msg) {
  try {
    const clientData = whatsappManager && whatsappManager.clients.get(String(zapId));
    const chat = clientData && clientData.chats ? clientData.chats.get(chatId) : null;
    if (chat && chat.sendStateTyping) {
      try { await chat.clearState(); } catch (_) {}
    }
  } catch (_) {}
  try {
    await whatsappManager.sendMessage(String(zapId), chatId, msg);
    sendLog(zapId, 'warning', 'Mensagem de erro enviada ao contato');
  } catch (e) {
    sendLog(zapId, 'error', `Nao foi possivel enviar mensagem de erro: ${e.message}`);
  }
}

async function sendTypingIndicator(zapId, chatId, silent = false) {
  try {
    const clientData = whatsappManager && whatsappManager.clients.get(String(zapId));
    if (!clientData || !clientData.client || !clientData.client.pupPage) {
      if (!silent) sendLog(zapId, 'warning', 'Indicador digitando: cliente ou pagina pupPage indisponivel');
      return;
    }
    const page = clientData.client.pupPage;
    const success = await page.evaluate(async (id) => {
      try {
        let wid = window.require('WAWebWidFactory').createWid(id);
        if (wid.isLid && wid.isLid()) {
          try {
            const pn = window.require('WAWebApiContact').getPhoneNumber(wid);
            if (pn) wid = pn;
          } catch (_) {}
        }
        const ChatState = window.require('WAWebChatStateBridge');
        await ChatState.sendChatStateComposing(wid);
        return true;
      } catch (err) {
        return { error: err.message };
      }
    }, chatId);

    if (success === true) {
      if (!silent) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('whatsapp-typing', { zapId: String(zapId), chatId, isTyping: true });
        }
        sendLog(zapId, 'info', 'Indicador digitando enviado no WhatsApp');
      }
    } else {
      sendLog(zapId, 'warning', `Falha ao enviar digitando via page.evaluate: ${success && success.error ? success.error : 'desconhecido'}`);
    }
  } catch (e) {
    sendLog(zapId, 'warning', `Nao foi possivel enviar digitando: ${e.message}`);
  }
}

async function clearTypingIndicator(zapId, chatId) {
  try {
    const clientData = whatsappManager && whatsappManager.clients.get(String(zapId));
    if (!clientData || !clientData.client || !clientData.client.pupPage) return;
    const page = clientData.client.pupPage;
    await page.evaluate(async (id) => {
      try {
        let wid = window.require('WAWebWidFactory').createWid(id);
        if (wid.isLid && wid.isLid()) {
          try {
            const pn = window.require('WAWebApiContact').getPhoneNumber(wid);
            if (pn) wid = pn;
          } catch (_) {}
        }
        const ChatState = window.require('WAWebChatStateBridge');
        await ChatState.sendChatStatePaused(wid);
      } catch (_) {}
    }, chatId).catch(() => {});

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('whatsapp-typing', { zapId: String(zapId), chatId, isTyping: false });
    }
  } catch (_) {}
}

// ------------------------------------------------------------
// Audio transcription helper
// ------------------------------------------------------------
async function transcribeAudio(audio, providersData, zapId, apiKeySelections) {
  // audio: { data: base64, mimetype, size }
  // Try aiResponder.transcribeAudio if exists, else fallback to asking to repeat
  if (aiResponder && typeof aiResponder.transcribeAudio === 'function') {
    const log = (type, msg) => sendLog(zapId, type, msg);
    return await aiResponder.transcribeAudio(audio, providersData, zapId, apiKeySelections, log);
  }
  // Fallback: try OpenAI whisper via any provider that has key
  const anyProvider = (providersData || []).find(p => p.apiKey || (Array.isArray(p.apiKeys) && p.apiKeys[0]));
  if (!anyProvider) throw new Error('Nenhum provedor com chave para transcrever audio');
  throw new Error('Transcricao de audio nao configurada');
}

// ------------------------------------------------------------
// Fila por conversa: mensagens do MESMO chat sao processadas na ordem em
// que chegaram. Sem isso, com o tempo aleatorio de resposta (15/25/35s),
// a IA poderia responder a segunda mensagem antes da primeira.
// ------------------------------------------------------------
const chatQueues = new Map();

async function handleIncomingMessage(messageData) {
  const cid = (messageData.chat && messageData.chat.id) || messageData.from || messageData.to || '';
  const key = `${messageData.zapId}|${cid}`;
  const prev = chatQueues.get(key) || Promise.resolve();
  const run = prev
    .catch(() => {})
    .then(() => processMessage(messageData))
    .catch(e => console.error('handleIncomingMessage erro:', e));
  chatQueues.set(key, run);
  run.then(() => { if (chatQueues.get(key) === run) chatQueues.delete(key); });
  return run;
}

// ------------------------------------------------------------
// Core: handle incoming WhatsApp message -> IA -> reply
// ------------------------------------------------------------
async function processMessage(messageData) {
  const { zapId, body, from, to, fromMe, chat, contact, audio } = messageData;
  const contactName = contact?.name || from;
  const chatId = chat?.id || from;
  const audioFailed = !!messageData.audioFailed;

  // ================= GRUPOS: CORTE NO TOPO =================
  // Nenhuma mensagem de grupo/canal/transmissao pode chegar na IA.
  // Nem log de "IA iniciando", nem transcricao de audio, nada.
  const jidRef = String(chatId || from || to || '');
  const isGroupMsg = !!messageData.isGroup ||
    !!(chat && chat.isGroup) ||
    jidRef.includes('@g.us') ||
    jidRef.includes('@newsletter') ||
    jidRef.includes('@broadcast');
  if (isGroupMsg) {
    console.log(`[GRUPO] mensagem de grupo nao processada (zap ${zapId}) - IA bloqueada`);
    return;
  }

  if (fromMe) {
    // So mensagens do AUTOCHAT (enviadas para o proprio numero) chegam aqui.
    // As respostas da IA sao bloqueadas no whatsapp-manager (anti-loop).
    if (!messageData.selfChat) {
      sendLog(zapId, 'info', 'Ignorada: mensagem enviada por mim para outro contato.');
      return;
    }
    sendLog(zapId, 'ai', `Autochat: IA iniciando para o proprio numero (${(to || from || '').split('@')[0]}): "${body}"`);
  } else {
    sendLog(zapId, 'ai', `IA iniciando para ${contactName}: "${body}"`);
  }

  const zapsData = loadZapsData();
  const providersData = loadProvidersData();
  const trainingsAll = loadTrainingsData();
  const zapTrainings = trainingsAll[String(zapId)] || [];
  const zap = zapsData.find(z => String(z.id) === String(zapId));

  if (!zap) {
    sendLog(zapId, 'error', 'Zap nao encontrado no arquivo.');
    return;
  }
  if (zap.enabled === false) {
    sendLog(zapId, 'warning', 'Zap desativado. Ignorando mensagem.');
    return;
  }
  if (zap.autoReply === false) {
    sendLog(zapId, 'warning', 'Auto-reply desativado para este Zap');
    return;
  }
  // blockedContacts stores contact.id which may be @s.whatsapp.net or @c.us - normalize to number part
  if (zap.blockedContacts && zap.blockedContacts.length) {
    const fromNumber = (from || '').split('@')[0];
    const isBlocked = zap.blockedContacts.some(b => {
      if (!b) return false;
      if (b.includes('@')) return b === from || b.split('@')[0] === fromNumber;
      return b === fromNumber || b === from;
    });
    if (isBlocked) {
      sendLog(zapId, 'warning', `Contato ${contactName} nao autorizado para IA. Ignorando.`);
      return;
    }
  }

  const enabledTrainings = zapTrainings.filter(t => t && t.enabled !== false);
  sendLog(zapId, 'info', `Config: modelo=${zap.model || 'auto'}, personalidade=${zap.personality || 'padrao'}, treinos=${enabledTrainings.length}`);

  let finalBody = body;

  // Audio detectado mas download falhou (mesmo apos retries): em vez de
  // ignorar em silencio, responde pedindo para mandar como texto
  // (se tinha legenda, segue com a legenda mesmo)
  const bodyIsAudioPlaceholder = !body || body.trim() === '' || body === '[AUDIO]';
  if (audioFailed && (!audio || !audio.data) && bodyIsAudioPlaceholder) {
    sendLog(zapId, 'warning', `Audio de ${contactName} nao pôde ser baixado. Pedindo para enviar como texto.`);
    await sendErrorToWhatsApp(zapId, chatId, 'Nao consegui baixar seu audio, pode mandar como texto?');
    sendLog(zapId, 'outgoing', 'Mensagem de audio nao baixado respondida.');
    return;
  }

  if (audio && (body === '[AUDIO]' || !body || body.trim() === '')) {
    sendLog(zapId, 'info', `Audio recebido de ${contactName}. Transcrevendo...`);
    try {
      finalBody = await transcribeAudio(audio, providersData, zapId, zap.apiKeySelections);
      if (!finalBody || !finalBody.trim() || finalBody.trim().length < 2) {
        sendLog(zapId, 'warning', 'Transcricao vazia ou invalida. Pedindo para repetir.');
        await whatsappManager.sendMessage(String(zapId), chatId, 'Nao consegui entender seu audio, pode repetir?');
        sendLog(zapId, 'outgoing', 'Mensagem de audio nao compreendido enviada.');
        return;
      }
      // Heuristic invalid transcription check
      if (finalBody.length < 3 || /^\W+$/.test(finalBody)) {
        sendLog(zapId, 'warning', `Transcricao parece invalida: "${finalBody}". Pedindo para repetir.`);
        await whatsappManager.sendMessage(String(zapId), chatId, 'Nao entendi seu audio, pode mandar de novo?');
        sendLog(zapId, 'outgoing', 'Mensagem de audio invalida respondida.');
        return;
      }
      sendLog(zapId, 'success', `Audio transcrito: "${finalBody.substring(0, 100)}"`);
    } catch (e) {
      sendLog(zapId, 'error', `Erro na transcricao: ${e.message}`);
      await sendErrorToWhatsApp(zapId, chatId, 'Tive um problema para entender seu audio. Pode enviar como texto?');
      return;
    }
  }

  // Build modelsToTry
  let modelsToTry = [];
  if (aiResponder && typeof aiResponder.getModelsToTry === 'function') {
    modelsToTry = aiResponder.getModelsToTry(zap, providersData);
  } else {
    // Fallback: build from providersData
    if (zap.model === 'auto' || !zap.model) {
      sendLog(zapId, 'info', 'Modo automatico: tentar todos os modelos disponiveis');
      for (const p of providersData) {
        const resolved = resolveProviderKey(p);
        if (!resolved.apiKey) continue;
        for (const m of (p.models || [])) {
          modelsToTry.push({ provider: resolved, model: m });
        }
      }
    } else {
      // Single model
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
  }

  if (!modelsToTry || modelsToTry.length === 0) {
    sendLog(zapId, 'error', 'Nenhum modelo disponivel em nenhum provedor');
    await sendErrorToWhatsApp(zapId, chatId, 'No momento estou sem conexao com a IA. Tente novamente em instantes.');
    return;
  }
  sendLog(zapId, 'info', `${modelsToTry.length} modelo(s) disponivel(is) para tentar`);

  // ---- 1) SORTEIO DO TEMPO ANTES DE COMECAR A RESPONDER (15s, 25s ou 35s) ----
  // Simula uma pessoa lendo a mensagem / pensando na resposta. Nesse periodo
  // NADA aparece para o contato (sem "digitando").
  const delayOptions = [15000, 25000, 35000];
  const preDelay = delayOptions[Math.floor(Math.random() * delayOptions.length)];
  sendLog(zapId, 'info', `Sorteio de tempo de resposta: ${(preDelay / 1000)}s antes de comecar a digitar...`);
  await new Promise(resolve => setTimeout(resolve, preDelay));

  // ---- 2) INDICADOR "DIGITANDO" LIGA AQUI ----
  const typingStart = Date.now();
  await sendTypingIndicator(zapId, chatId);
  sendLog(zapId, 'info', 'Indicador "digitando" ativado - IA gerando a resposta...');

  let response = null;
  let lastError = null;

  // Try each model - delegate to aiResponder.generateResponse which has internal fallback,
  // but we also loop here for per-model logging and to support both signatures.
  for (let i = 0; i < modelsToTry.length; i++) {
    const entry = modelsToTry[i];
    const hasKey = !!(entry.provider && entry.provider.apiKey);
    sendLog(zapId, 'ai', `[${i + 1}/${modelsToTry.length}] Tentando ${entry.provider.name} / ${entry.model.id} (chave: ${hasKey ? 'ok' : 'AUSENTE'})...`);

    const zapConfig = {
      aiName: zap.aiName || '',
      personality: zap.personality || 'padrao',
      area: zap.area || '',
      customPrompt: zap.customPrompt || '',
      provider: resolveProviderKey(entry.provider),
      model: entry.model,
      trainings: enabledTrainings
    };

    try {
      // ai-responder signature is (messageData, zapConfig, allProviders) with internal fallback.
      // We pass finalBody by overriding messageData.body
      const msgForAI = { ...messageData, body: finalBody };
      // Try new signature first (with allProviders for fallback), fallback to old
      let r = null;
      if (aiResponder.generateResponse.length >= 3) {
        r = await aiResponder.generateResponse(msgForAI, zapConfig, providersData);
      } else {
        r = await aiResponder.generateResponse(msgForAI, zapConfig, providersData);
      }
      const isJunk = !!(aiResponder && typeof aiResponder.isJunkResponse === 'function' && aiResponder.isJunkResponse(r));
      if (r && r.trim().length > 0 && !isJunk) {
        response = r;
        sendLog(zapId, 'success', `Resposta obtida com ${entry.provider.name} / ${entry.model.id}`);
        break;
      } else if (r && r.trim().length > 0) {
        // Artefato interno da IA (ex: "Check Constreainsts:*** Max") - NUNCA vai ao cliente
        sendLog(zapId, 'warning', `${entry.provider.name} / ${entry.model.id} retornou texto invalido - descartado: "${r.trim().substring(0, 80)}"`);
        lastError = 'Resposta invalida do modelo (texto de sistema)';
      } else {
        sendLog(zapId, 'warning', `${entry.provider.name} / ${entry.model.id} retornou vazio`);
        lastError = 'Resposta vazia';
      }
    } catch (e) {
      lastError = e.message;
      sendLog(zapId, 'error', `${entry.provider.name} / ${entry.model.id} falhou: ${e.message}`);
    }
  }

  if (!response) {
    sendLog(zapId, 'error', `Todos os modelos falharam. Ultimo erro: ${lastError}`);
    await clearTypingIndicator(zapId, chatId);
    await sendErrorToWhatsApp(zapId, chatId, 'Desculpe, tive um problema tecnico. Pode repetir sua mensagem?');
    return;
  }

  // Resolve imagem/link da resposta: marcadores da IA + fallback por intencao
  const media = resolveReplyMedia(response, finalBody, enabledTrainings, (type, msg) => sendLog(zapId, type, msg));
  const resolvedImages = media.images;
  const resolvedLinks = media.links;
  const textToSend = media.text;

  // ---- 3) TEMPO REALISTA DE DIGITACAO ----
  // Pessoa comum: em media 2s para digitar 5 caracteres => 0,4s por caractere
  // (2,5 caracteres por segundo). O indicador so desliga e a mensagem so sai
  // quando esse tempo passar (minimo 5s de "digitando" visivel).
  const CARACTERES_POR_SEGUNDO = 5 / 2;
  const chars = String(textToSend || '').length;
  const humanTypingMs = Math.round((chars / CARACTERES_POR_SEGUNDO) * 1000);
  const minTypingMs = 5000;
  const targetTypingMs = Math.max(minTypingMs, humanTypingMs);
  const typingElapsed = Date.now() - typingStart;
  const remainingMs = targetTypingMs - typingElapsed;

  sendLog(zapId, 'info',
    `Digitacao realista: ${chars} caracteres = ~${(humanTypingMs / 1000).toFixed(1)}s de pessoa digitando; ` +
    `indicador ligado ha ${(typingElapsed / 1000).toFixed(1)}s (alvo ${(targetTypingMs / 1000).toFixed(1)}s).`);

  if (remainingMs > 0) {
    sendLog(zapId, 'info', `Faltam ${(remainingMs / 1000).toFixed(1)}s com "digitando..." antes de enviar...`);
    const deadline = Date.now() + remainingMs;
    while (Date.now() < deadline) {
      const left = deadline - Date.now();
      await new Promise(resolve => setTimeout(resolve, Math.min(20000, left)));
      // O WhatsApp expira o estado "digitando" em ~25s - renova ate o fim
      if (Date.now() < deadline) await sendTypingIndicator(zapId, chatId, true);
    }
  }

  // ---- 4) DESLIGA O INDICADOR E ENVIA ----
  await clearTypingIndicator(zapId, chatId);

  if (textToSend) {
    const preview = textToSend.substring(0, 80);
    sendLog(zapId, 'outgoing', `Enviando: "${preview}..."`);
    try {
      await whatsappManager.sendMessage(String(zapId), chatId, textToSend);
      sendLog(zapId, 'success', 'Mensagem enviada com sucesso!');
    } catch (error) {
      sendLog(zapId, 'error', `ERRO ao enviar: ${error.message}`);
      throw error;
    }
  }

  // Send training images resolved from [SEND_IMAGE:id] (or intent fallback)
  for (const found of resolvedImages) {
    const imgId = found.id;
    const label = found.name || found.filename || imgId;
    const rel = found.file || null;
    if (!rel) {
      if (found.data) {
        try {
          await whatsappManager.sendMedia(String(zapId), chatId, { data: found.data, mimeType: found.mimeType || 'image/jpeg', name: found.filename || `${imgId}.jpg` });
          sendLog(zapId, 'success', `Imagem enviada: ${label}`);
        } catch (e) {
          sendLog(zapId, 'error', `Falha ao enviar imagem ${imgId}: ${e.message}`);
        }
        continue;
      }
      sendLog(zapId, 'warning', `Arquivo da imagem ${imgId} nao encontrado no disco`);
      continue;
    }
    const abs = resolveDataPath(rel);
    if (!abs || !fs.existsSync(abs)) {
      sendLog(zapId, 'warning', `Arquivo da imagem ${imgId} nao encontrado no disco`);
      continue;
    }
    try {
      const b64 = fs.readFileSync(abs).toString('base64');
      await whatsappManager.sendMedia(String(zapId), chatId, { data: b64, mimeType: found.mimeType || 'image/jpeg', name: found.filename || path.basename(abs) });
      sendLog(zapId, 'success', `Imagem enviada: ${label}`);
    } catch (e) {
      sendLog(zapId, 'error', `Falha ao enviar imagem ${imgId}: ${e.message}`);
    }
  }

  if (resolvedLinks.length > 0) {
    sendLog(zapId, 'success', `Link(s) enviado(s): ${resolvedLinks.map(l => l.name || l.description || l.url).join(', ')}`);
  }

  if (!textToSend && resolvedImages.length === 0 && resolvedLinks.length === 0) {
    sendLog(zapId, 'warning', 'Resposta vazia apos remocao de marcadores de imagem');
  }
}

// ------------------------------------------------------------
// Window
// ------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1000,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#FFFFFF',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('FALHA:', errorCode, errorDescription);
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ------------------------------------------------------------
// App lifecycle
// ------------------------------------------------------------
app.whenReady().then(() => {
  ensureDataDir();
  createWindow();
  whatsappManager = new WhatsAppManager(mainWindow);
  aiResponder = new AIResponder();
  whatsappManager.setOnMessageCallback(async (messageData) => {
    try { await handleIncomingMessage(messageData); } catch (e) { console.error('handleIncomingMessage erro:', e); }
  });
});

app.on('window-all-closed', async () => {
  if (whatsappManager) { try { await whatsappManager.disconnectAll(); } catch (_) {} }
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
app.on('before-quit', async () => {
  if (whatsappManager) { try { await whatsappManager.disconnectAll(); } catch (_) {} }
});

// ------------------------------------------------------------
// IPC - Window controls
// ------------------------------------------------------------
ipcMain.on('window-minimize', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.on('window-maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('window-close', () => { if (mainWindow) mainWindow.close(); });
ipcMain.on('window-focus', () => { if (mainWindow) mainWindow.focus(); });
ipcMain.on('app-alert', (e, message) => {
  dialog.showMessageBoxSync(mainWindow, { type: 'info', message: String(message || ''), buttons: ['OK'], defaultId: 0, noLink: true, title: app.getName() });
  e.returnValue = true;
});
ipcMain.on('app-confirm', (e, message) => {
  const r = dialog.showMessageBoxSync(mainWindow, { type: 'warning', message: String(message || ''), buttons: ['Sim', 'Não'], defaultId: 1, cancelId: 1, noLink: true, title: app.getName() });
  e.returnValue = r === 0;
});
ipcMain.on('window-start-drag', () => { rendererDragging = true; });
ipcMain.on('window-stop-drag', () => { rendererDragging = false; });
ipcMain.on('window-drag-move', (e, dx, dy) => {
  if (!rendererDragging || !mainWindow) return;
  // dx/dy are deltas (see renderer), clamp to avoid huge jumps
  const ddx = Math.max(-200, Math.min(200, Number(dx) || 0));
  const ddy = Math.max(-200, Math.min(200, Number(dy) || 0));
  const [x, y] = mainWindow.getPosition();
  mainWindow.setPosition(x + ddx, y + ddy);
});

// ------------------------------------------------------------
// IPC - WhatsApp
// ------------------------------------------------------------
ipcMain.handle('whatsapp-connect', (e, zapId, phone, method) => whatsappManager.connectZap(String(zapId), phone, method));
ipcMain.handle('whatsapp-disconnect', (e, zapId) => whatsappManager.disconnectZap(String(zapId)));
ipcMain.handle('whatsapp-status', (e, zapId) => whatsappManager.getStatus(String(zapId)));
ipcMain.handle('whatsapp-send', (e, zapId, phone, text) => whatsappManager.sendMessage(String(zapId), phone, text));
ipcMain.handle('whatsapp-conversations', (e, zapId) => whatsappManager.getConversations(String(zapId)));
ipcMain.handle('whatsapp-messages', (e, zapId, chatId) => whatsappManager.getMessages(String(zapId), chatId));

// ------------------------------------------------------------
// IPC - Data persistence
// ------------------------------------------------------------
ipcMain.handle('load-zaps', () => loadZapsData());
ipcMain.handle('save-zaps', (e, data) => {
  ensureDataDir();
  const p = getFilePath('zaps.json');
  const tmp = p + '.tmp';
  try {
    const json = JSON.stringify(data, null, 2);
    // Log size for debug
    console.log(`save-zaps: ${json.length} bytes, ${data.length} zaps`);
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, p);
  } catch (err) {
    console.error('save-zaps falhou:', err.message, err.code);
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
    // Nao joga erro para nao travar o app - apenas loga
    return false;
  }
  return true;
});
ipcMain.handle('load-providers', () => loadProvidersData());
ipcMain.handle('save-providers', (e, data) => {
  ensureDataDir();
  const p = getFilePath('providers.json');
  const tmp = p + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, p);
  } catch (err) {
    console.error('save-providers falhou:', err.message);
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
    throw err;
  }
  return true;
});
ipcMain.handle('load-trainings', () => loadTrainingsData());
ipcMain.handle('save-trainings', (e, data, deletedFiles) => {
  ensureDataDir();
  // Handle image files: data contains trainings with images that have `data` (base64) for new images
  // Write files to disk and replace `data` with `file` relative path
  try {
    for (const zapId of Object.keys(data)) {
      const list = data[zapId] || [];
      for (const t of list) {
        if (!t || !Array.isArray(t.images)) continue;
        for (const img of t.images) {
          if (!img) continue;
          if (img.data) {
            const ext = (img.filename && path.extname(img.filename)) || '.jpg';
            const id = String(img.id || Date.now());
            const rel = path.join('trainings', String(zapId), `${id}${ext}`);
            const abs = path.join(getDataDir(), rel);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            // img.data may be "data:image/jpeg;base64,XXXX" from FileReader.readAsDataURL
            let b64 = img.data;
            const commaIdx = b64.indexOf(',');
            if (b64.startsWith('data:') && commaIdx !== -1) b64 = b64.slice(commaIdx + 1);
            // also handle already-pure base64
            b64 = b64.trim();
            try {
              fs.writeFileSync(abs, Buffer.from(b64, 'base64'));
            } catch (writeErr) {
              console.error('save-trainings write falhou:', writeErr.message);
              continue;
            }
            img.file = rel;
            delete img.data;
            // ensure mimeType/filename are preserved
            if (!img.mimeType) img.mimeType = 'image/jpeg';
          }
        }
      }
    }
    // Delete requested files
    if (Array.isArray(deletedFiles)) {
      for (const rel of deletedFiles) {
        if (!rel || typeof rel !== 'string') continue;
        const abs = resolveDataPath(rel);
        if (abs && fs.existsSync(abs)) {
          try { fs.unlinkSync(abs); } catch (_) {}
        }
      }
    }
    fs.writeFileSync(getFilePath('trainings.json'), JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('save-trainings erro:', err);
    throw err;
  }
  return true;
});
ipcMain.handle('delete-trainings-for-zap', (e, zapId) => {
  const zid = String(zapId);
  const all = loadTrainingsData();
  const list = all[zid] || [];
  // Delete image files
  for (const t of list) {
    for (const img of (t.images || [])) {
      if (img && img.file) {
        const abs = resolveDataPath(img.file);
        if (abs && fs.existsSync(abs)) { try { fs.unlinkSync(abs); } catch (_) {} }
      }
    }
  }
  // Delete zap dir if empty
  const zapDir = path.join(getDataDir(), 'trainings', zid);
  if (fs.existsSync(zapDir)) {
    try {
      const files = fs.readdirSync(zapDir);
      if (files.length === 0) fs.rmdirSync(zapDir);
    } catch (_) {}
    // Force remove if still has files (all deleted above, but safety)
    try { if (fs.existsSync(zapDir) && fs.readdirSync(zapDir).length === 0) fs.rmdirSync(zapDir); } catch (_) {}
  }
  delete all[zid];
  fs.writeFileSync(getFilePath('trainings.json'), JSON.stringify(all, null, 2));
  return true;
});
