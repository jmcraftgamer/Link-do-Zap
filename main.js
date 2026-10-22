const { app, BrowserWindow, ipcMain, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const WhatsAppManager = require('./src/js/whatsapp-manager');
const AIResponder = require('./src/js/ai-responder');
const { resolveReplyMedia } = require('./src/js/media-resolver');
const { verifyMessage } = require('./src/js/message-guard');
const { isWithinWorkHours } = require('./src/js/work-hours');

// Memoria de conversas: historico dos dias anteriores vai junto no prompt da
// IA e tambem e gravado em .txt (<dados>/memorias/<zapId>/<contato>.txt).
const MEMORY_DAYS = 3;
const MEMORY_MAX_CHARS = 6000;

// Citacao eventual: chance de, numa resposta com varias mensagens, UMA delas
// sair como "responder citando" a mensagem do cliente (mostra qual mensagem
// esta sendo respondida, sem dizer nada no texto).
const QUOTE_CHANCE = 0.35;
const ConversationStore = require('./src/js/conversation-store');
const AutoMessageManager = require('./src/js/auto-message');
const AppAgent = require('./src/js/app-agent');
const ServerSync = require('./src/js/server-sync');

let mainWindow;
let whatsappManager;
let aiResponder;
let conversationStore = null;
let autoMessage = null;
let appAgent = null;
let rendererDragging = false;
let serverSync = null;
let serverMode = false;
let serverKnownZaps = null;
const zapErrors = new Map();

// Um evaluate do wwebjs numa pagina morta (teardown de LOGOUT) rejeita sem
// catcher e no Node derrubaria o processo inteiro - aqui so registra o erro
process.on('unhandledRejection', (reason) => {
  const msg = reason && reason.message ? reason.message : String(reason);
  console.error('[UNHANDLED] Promessa rejeitada sem tratamento:', msg);
});

const MAX_LOG_LINES = 500;
const logRing = [];
function pushLogLine(line) {
  logRing.push(line);
  if (logRing.length > MAX_LOG_LINES) logRing.splice(0, logRing.length - MAX_LOG_LINES);
}
function formatLogArgs(args) {
  return args.map((a) => {
    if (typeof a === 'string') return a;
    if (a && a.stack) return String(a.stack);
    try { return JSON.stringify(a); } catch (_) { return String(a); }
  }).join(' ');
}
const _log = console.log.bind(console);
const _err = console.error.bind(console);
const _warn = console.warn.bind(console);
console.log = (...a) => { pushLogLine(`${new Date().toISOString()} ${formatLogArgs(a)}`); _log(...a); };
console.error = (...a) => { pushLogLine(`${new Date().toISOString()} ${formatLogArgs(a)}`); _err(...a); };
console.warn = (...a) => { pushLogLine(`${new Date().toISOString()} ${formatLogArgs(a)}`); _warn(...a); };

function isHeadless() {
  const v = String(process.env.HEADLESS || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function getLogRing() {
  return logRing;
}

// ------------------------------------------------------------
// Helpers - paths
// ------------------------------------------------------------
function getDataDir() {
  try {
    if (process.env.LINK_DATA_DIR) return path.resolve(process.env.LINK_DATA_DIR);
  } catch (_) {}
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
function loadProvidersData() {
  const list = loadJsonFile('providers.json', []);
  // Chaves podem vir do ambiente (secrets do GitHub Actions / env local):
  // se o secret estiver configurado, ele SEMPRE prevalece sobre chaves antigas ou invalidas do arquivo
  try {
    const envSpecs = [
      { id: 'openrouter-preconfig', name: 'OpenRouter', env: process.env.OPENROUTER_API_KEY },
      { id: 'googleai-preconfig', name: 'Google AI Studio', env: process.env.GOOGLE_AI_KEY }
    ];
    for (const spec of envSpecs) {
      const key = spec.env && String(spec.env).trim();
      if (!key) continue;
      for (const p of list) {
        if (!p || (p.id !== spec.id && String(p.name || '') !== spec.name)) continue;
        // Secret do ambiente e a fonte da verdade: substitui apiKey legado
        // E apiKeys[] (prioridade do resolveKey) para valer em todos os caminhos
        p.apiKey = key;
        p.apiKeys = [key];
        p.apiKeyNames = ['Chave do ambiente'];
      }
    }
    // Garante que o provedor Google AI Studio possua os modelos oficiais válidos da API
    for (const p of list) {
      if (p && (p.id === 'googleai-preconfig' || String(p.name || '').includes('Google'))) {
        // Oficiais validos para contas NOVAS do AI Studio (2.5/2.0/1.5
        // retornam 404 "no longer available to new users")
        const officialModels = [
          { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', free: true },
          { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', free: true },
          { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash-Lite', free: true },
          { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash-Lite', free: true }
        ];
        if (!Array.isArray(p.models) || p.models.length === 0) {
          p.models = officialModels;
        } else {
          // Adiciona os oficiais se faltarem
          for (const off of officialModels) {
            if (!p.models.some(m => m && m.id === off.id)) {
              p.models.push(off);
            }
          }
        }
      }
    }
  } catch (_) {}
  return list;
}
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
// Memoria: conversas finalizadas toda 00:00
// ------------------------------------------------------------
function initConversationStore() {
  if (!conversationStore) {
    conversationStore = new ConversationStore(getFilePath('conversations.json'));
  }
  if (aiResponder && typeof aiResponder.setHistoryStore === 'function') {
    aiResponder.setHistoryStore(conversationStore);
  }
  try { conversationStore.rollOver(Date.now()); } catch (e) {
    console.error('[CONV] rollOver inicial falhou:', e.message);
  }
  scheduleMidnightRollover();
  return conversationStore;
}

let rolloverTimer = null;

function scheduleMidnightRollover() {
  if (rolloverTimer) return;
  rolloverTimer = setInterval(() => {
    try {
      const changed = conversationStore ? conversationStore.rollOver(Date.now()) : false;
      if (changed) console.log('[CONV] virada de dia as 00:00 - conversas finalizadas');
    } catch (e) {
      console.error('[CONV] rollOver das 00:00 falhou:', e.message);
    }
  }, 60 * 1000);
  if (rolloverTimer && typeof rolloverTimer.unref === 'function') rolloverTimer.unref();
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

// ------------------------------------------------------------
// Logging -> renderer log modal
// ------------------------------------------------------------
function sendLog(zapId, type, msg) {
  console.log(`[LOG][${type}] Zap ${zapId}: ${msg}`);
  if (type === 'error' && zapId != null) {
    zapErrors.set(String(zapId), Date.now());
  }
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

// Espera o tempo que uma pessoa levaria digitando essa mensagem
// (2,5 caracteres por segundo = 2s a cada 5 digitos, minimo 5s visivel).
// Renova o indicador a cada 20s porque o WhatsApp expira "digitando" em ~25s.
async function waitRealisticTyping(zapId, chatId, typingStart, text) {
  const CARACTERES_POR_SEGUNDO = 5 / 2;
  const chars = String(text || '').length;
  const humanTypingMs = Math.round((chars / CARACTERES_POR_SEGUNDO) * 1000);
  const targetTypingMs = Math.max(5000, humanTypingMs);
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
  // Horario da mensagem que disparou a IA (segundos). Serve para saber se o
  // dono do numero respondeu DEPOIS dela antes de a IA mandar a resposta.
  const triggerTs = messageData.timestamp || Math.floor(Date.now() / 1000);

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

  // Horario de atendimento: fora da janela a mensagem nem chega na IA e nada
  // e enviado ao cliente (a conversa tambem nao e registrada).
  if (zap.workHours && zap.workHours.enabled === true && !isWithinWorkHours(zap.workHours)) {
    sendLog(zapId, 'info', `Fora do horario de atendimento (${zap.workHours.start}-${zap.workHours.end}) - mensagem ignorada, nao enviada a IA.`);
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

  let convResult = null;
  if (conversationStore) {
    try {
      convResult = conversationStore.ensure(zapId, chatId, Date.now());
      if (convResult.created) {
        sendLog(zapId, 'info', `Nova conversa iniciada com ${contactName} (historico anterior: ${conversationStore.countFor(zapId, chatId) - 1} conversa(s))`);
      }
    } catch (e) {
      sendLog(zapId, 'warning', `Memoria indisponivel: ${e.message}`);
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
    sendLog(zapId, 'warning', `Memoria indisponivel: ${e.message}`);
  }
  if (memoryText) {
    try {
      const mdir = path.join(getDataDir(), 'memorias', String(zapId));
      fs.mkdirSync(mdir, { recursive: true });
      const safeChat = String(chatId).replace(/[^A-Za-z0-9@._-]/g, '_');
      const mfile = path.join(mdir, `${safeChat}.txt`);
      fs.writeFileSync(mfile, memoryFileText(contactName, zapId, chatId, memoryText));
      sendLog(zapId, 'info', `Memoria de conversas anexada (${memoryText.split('\n').length} linha(s)) -> ${path.relative(getDataDir(), mfile)}`);
    } catch (e) {
      sendLog(zapId, 'warning', `Nao foi possivel gravar o arquivo de memoria: ${e.message}`);
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

  // ---- 1) SORTEIO DO TEMPO ANTES DE COMECAR A RESPONDER (2s, 3s ou 5s) ----
  // Simula uma pessoa lendo a mensagem / pensando na resposta. Nesse periodo
  // NADA aparece para o contato (sem "digitando").
  if (zap.instantReply) {
    sendLog(zapId, 'info', 'Resposta instantanea ativada - sorteio de tempo ignorado.');
  } else {
    const delayOptions = [2000, 3000, 5000];
    const preDelay = delayOptions[Math.floor(Math.random() * delayOptions.length)];
    sendLog(zapId, 'info', `Sorteio de tempo de resposta: ${(preDelay / 1000)}s antes de comecar a digitar...`);
    await new Promise(resolve => setTimeout(resolve, preDelay));
  }

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
      trainings: enabledTrainings,
      conversationInfo
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

  // ---- 3) MENSAGENS MULTIPLAS ----
  // A IA separa com [QUEBRA] (ou, se nao marcou e o texto e grande, separamos
  // por frases). Curto = 1 mensagem. No maximo 4 baloes.
  const rawParts = (aiResponder && typeof aiResponder.splitMessages === 'function')
    ? aiResponder.splitMessages(media.text)
    : (String(media.text || '').trim() ? [String(media.text || '').trim()] : []);

  // ---- 3.1) VERIFICADOR FINAL ----
  // Ultimo portao antes do envio: nada de codigo, JSON, markdown, marcador
  // vazado, texto de sistema, meta ou ingles. Reprova balao por balao.
  const parts = [];
  for (const p of rawParts) {
    const v = verifyMessage(p, { incoming: finalBody });
    if (v.ok) parts.push(p);
    else sendLog(zapId, 'warning', `Mensagem reprovada pelo verificador (${v.reason}) - NAO enviada: "${p.substring(0, 80)}"`);
  }
  if (rawParts.length > 0 && parts.length === 0) {
    sendLog(zapId, 'error', 'Todas as mensagens foram reprovadas pelo verificador - enviando aviso padrao.');
    await clearTypingIndicator(zapId, chatId);
    await sendErrorToWhatsApp(zapId, chatId, 'Desculpe, tive um problema tecnico. Pode repetir sua mensagem?');
    return;
  }

  if (aiResponder && typeof aiResponder.updateLastAssistant === 'function') {
    const delivered = parts.length ? parts.join(' ') : (String(media.text || '').trim() || '(mensagem sem texto)');
    try { aiResponder.updateLastAssistant(zapId, chatId, delivered); } catch (_) {}
  }

  if (parts.length > 1) {
    sendLog(zapId, 'info', `Resposta separada em ${parts.length} mensagens (maximo 4).`);
  }

  if (parts.length === 0) {
    // Sobe imagem/link sem texto: garante que o "digitando" nao fica preso
    await clearTypingIndicator(zapId, chatId);
  }

  // ---- 3.3) CITACAO EVENTUAL ----
  // As vezes (nem sempre), numa resposta com varias mensagens, UMA delas sai
  // como "responder citando" a mensagem do cliente - mostra qual mensagem
  // esta sendo respondida sem escrever isso no texto.
  let quoteIndex = -1;
  if (parts.length > 1 && messageData.id && Math.random() < QUOTE_CHANCE) {
    quoteIndex = Math.floor(Math.random() * parts.length);
    sendLog(zapId, 'info', `Resposta tera 1 mensagem citando a mensagem do cliente (balão ${quoteIndex + 1}/${parts.length}).`);
  }

  // ---- 4) ENTREGA: DIGITACAO REALISTA ENTRE CADA MENSAGEM ----
  for (let i = 0; i < parts.length; i++) {
    const text = parts[i];

    // 1a mensagem: o indicador ja esta ligado desde a geracao da IA (typingStart).
    // Demais mensagens: religa agora - a pausa entre baloes e o tempo digitando.
    const partTypingStart = i === 0 ? typingStart : Date.now();
    if (i > 0) await sendTypingIndicator(zapId, chatId);

    await waitRealisticTyping(zapId, chatId, partTypingStart, text);
    // Nao espera o indicador de digitacao sumir antes de enviar: isso somava
    // ~1s de atraso por mensagem. Dispara em paralelo e segue para o envio.
    clearTypingIndicator(zapId, chatId).catch(() => {});

    // Portao final NO EXATO MOMENTO DO ENVIO: se o dono do numero ja respondeu
    // depois da mensagem do cliente (inclusive durante o sorteio/digitacao),
    // a IA NAO manda por cima.
    let ownerReplied = false;
    if (whatsappManager && typeof whatsappManager.hasOwnerReplied === 'function') {
      try {
        ownerReplied = await whatsappManager.hasOwnerReplied(String(zapId), chatId, triggerTs, { live: i === 0 });
      } catch (_) { ownerReplied = false; }
    }
    if (ownerReplied) {
      sendLog(zapId, 'info', 'Dono do numero ja respondeu esta conversa - IA nao vai responder por cima.');
      return;
    }

    const preview = text.substring(0, 80);
    const label = parts.length > 1 ? `[${i + 1}/${parts.length}] ` : '';
    const citLabel = i === quoteIndex ? ' (citando a mensagem do cliente)' : '';
    sendLog(zapId, 'outgoing', `Enviando ${label}${citLabel}: "${preview}..."`);
    try {
      const _sendT0 = Date.now();
      if (i === quoteIndex && typeof whatsappManager.replyMessage === 'function') {
        await whatsappManager.replyMessage(String(zapId), chatId, text, messageData.id);
      } else {
        await whatsappManager.sendMessage(String(zapId), chatId, text);
      }
      const _sendSecs = ((Date.now() - _sendT0) / 1000).toFixed(1);
      sendLog(zapId, 'success', parts.length > 1
        ? `Mensagem ${i + 1}/${parts.length} enviada!${citLabel} (${_sendSecs}s)`
        : `Mensagem enviada com sucesso!${citLabel} (${_sendSecs}s)`);
    } catch (error) {
      sendLog(zapId, 'error', `ERRO ao enviar: ${error.message}`);
      throw error;
    }
  }

  // Send training images resolved from [SEND_IMAGE:id] (or intent fallback)
  const sentImageLabels = [];
  for (const found of resolvedImages) {
    const imgId = found.id;
    const label = found.name || found.filename || imgId;
    const rel = found.file || null;
    if (!rel) {
      if (found.data) {
        try {
          await whatsappManager.sendMedia(String(zapId), chatId, { data: found.data, mimeType: found.mimeType || 'image/jpeg', name: found.filename || `${imgId}.jpg` });
          sendLog(zapId, 'success', `Imagem enviada: ${label}`);
          sentImageLabels.push(label);
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
      sentImageLabels.push(label);
    } catch (e) {
      sendLog(zapId, 'error', `Falha ao enviar imagem ${imgId}: ${e.message}`);
    }
  }

  if (resolvedLinks.length > 0) {
    sendLog(zapId, 'success', `Link(s) enviado(s): ${resolvedLinks.map(l => l.name || l.description || l.url).join(', ')}`);
  }

  const sentNotes = [];
  if (sentImageLabels.length) sentNotes.push(`imagem: ${sentImageLabels.join(', ')}`);
  if (resolvedLinks.length) sentNotes.push(`link: ${resolvedLinks.map(l => l.name || l.description || l.url).join(', ')}`);
  if (sentNotes.length && conversationStore) {
    try {
      conversationStore.append(zapId, chatId, 'assistant', `[enviou ${sentNotes.join(' | ')}]`);
    } catch (e) {
      console.error('[CONV] falha ao registrar midia no historico:', e.message);
    }
  }

  if (parts.length === 0 && resolvedImages.length === 0 && resolvedLinks.length === 0) {
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
// Servidor HTTP de status/QR (headless / tunel SSH)
// ------------------------------------------------------------
function buildStatusState() {
  const zaps = loadZapsData().map((z) => {
    let st = { status: 'disconnected' };
    try {
      if (whatsappManager && whatsappManager.getStatus) st = whatsappManager.getStatus(String(z.id)) || st;
    } catch (_) {}
    return {
      id: String(z.id),
      name: z.name || '',
      enabled: z.enabled !== false,
      autoReply: !!z.autoReply,
      status: st.status || 'disconnected',
      qrPending: !!st.qrCode,
      method: st.method || null
    };
  });
  return {
    ok: true,
    headless: isHeadless(),
    uptime: Math.floor(process.uptime()),
    platform: process.platform,
    dataDir: getDataDir(),
    zaps
  };
}

let statusServer = null;

function startStatusServer() {
  if (statusServer) return statusServer;
  const headless = isHeadless();
  const portEnv = process.env.LINK_HTTP_PORT;
  if (!headless && !portEnv) return null;
  const port = Number(portEnv) || 8123;
  const host = process.env.LINK_HTTP_HOST || '127.0.0.1';
  const token = process.env.LINK_HTTP_TOKEN || '';
  try {
    const { createStatusServer } = require('./src/js/status-server');
    statusServer = createStatusServer({
      host,
      port,
      token,
      getState: buildStatusState,
      getQr: (zapId) => {
        if (whatsappManager && whatsappManager.getQrString) return whatsappManager.getQrString(zapId);
        return null;
      },
      getLogs: () => logRing,
      onConnect: (zapId, opts) => {
        const zap = loadZapsData().find((z) => String(z.id) === String(zapId));
        if (!zap) return { status: 404, ok: false, error: 'zap nao configurado (nao consta no zaps.json)' };
        if (!whatsappManager) return { status: 503, ok: false, error: 'gerenciador do WhatsApp indisponivel' };
        const method = opts && opts.method === 'pairing' ? 'pairing' : 'qrcode';
        const phone = opts && opts.phone ? opts.phone : '';
        if (method === 'pairing' && !phone) return { status: 400, ok: false, error: 'metodo pairing exige o campo "phone"' };
        Promise.resolve(whatsappManager.connectZap(String(zapId), phone, method))
          .catch((e) => console.error(`[HTTP] connectZap(${zapId}) falhou: ${e.message}`));
        return { status: 202, ok: true, message: 'conexao solicitada - acompanhe o status da pagina' };
      },
      onDisconnect: async (zapId) => {
        if (!whatsappManager) return { status: 503, ok: false, error: 'gerenciador do WhatsApp indisponivel' };
        await whatsappManager.disconnectZap(String(zapId));
        return { status: 200, ok: true };
      }
    });
    statusServer.on('error', (e) => {
      console.error(`[HTTP] Servidor de status em ${host}:${port} falhou: ${e.message}`);
      statusServer = null;
    });
    statusServer.listen(port, host, () => {
      const addr = statusServer.address();
      const shownPort = addr && addr.port ? addr.port : port;
      console.log(`[HTTP] Servidor de status em http://${host}:${shownPort}${token ? ' (com token)' : ''}`);
    });
  } catch (e) {
    console.error('[HTTP] Falha ao iniciar servidor de status:', e.message);
    statusServer = null;
  }
  return statusServer;
}

function getStatusServer() {
  return statusServer;
}

function persistBotStatus() {
  try {
    ensureDataDir();
    const filePath = getFilePath('bot-status.json');
    const zaps = loadZapsData();
    const states = whatsappManager && typeof whatsappManager.listConnectionStates === 'function'
      ? whatsappManager.listConnectionStates()
      : [];
    const statusData = {
      updatedAt: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      headless: isHeadless(),
      zaps: zaps.map(z => {
        const state = states.find(s => String(s.id) === String(z.id)) || {};
        return {
          id: z.id,
          name: z.name,
          phone: z.phone,
          enabled: z.enabled !== false,
          status: state.status || 'disconnected',
          qrPending: !!state.qrPending,
          pairingCode: state.pairingCode || null,
          lastErrorAt: zapErrors.get(String(z.id)) || null
        };
      })
    };
    fs.writeFileSync(filePath, JSON.stringify(statusData, null, 2));
  } catch (_) {}
}

function autoConnectSavedSessions(staggerMs = 2000) {
  if (!whatsappManager || typeof whatsappManager.connectZap !== 'function') return 0;
  let count = 0;
  loadZapsData().forEach((z, i) => {
    const zapId = String(z.id);
    if (z.enabled === false) return;
    const sessionDir = path.join(getDataDir(), 'sessions', zapId);
    if (!fs.existsSync(sessionDir)) return;
    count++;
    setTimeout(() => {
      console.log(`[AUTO] Reconectando zap ${zapId} (${z.name || ''}) com sessao salva...`);
      Promise.resolve(whatsappManager.connectZap(zapId, '', 'qrcode'))
        .then(() => {
          persistBotStatus();
          // Se for headless com LINK_AUTO_PAIR=1: detecta se a sessao salva expirou (caiu em waiting_qr)
          // para nao ficar como zumbi invisivel sem pareamento
          if (isHeadless() && String(process.env.LINK_AUTO_PAIR || '') === '1') {
            setTimeout(() => {
              const st = whatsappManager.getStatus(zapId);
              if (st && st.status === 'waiting_qr') {
                const phone = String(z.phone || '').replace(/\D/g, '');
                if (phone) {
                  console.log(`[AUTO-PAIR] Sessao salva do zap ${zapId} expirou (caiu em QR). Limpando sessao e gerando codigo de pareamento...`);
                  try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_) {}
                  whatsappManager.connectZap(zapId, phone, 'pairing')
                    .catch((err) => console.error(`[AUTO-PAIR] Falha no pareamento do zap ${zapId}: ${err.message}`));
                }
              }
            }, 12000);
          }
        })
        .catch((e) => console.error(`[AUTO] Falha ao reconectar ${zapId}: ${e.message}`));
    }, i * staggerMs);
  });
  if (!count) console.log('[AUTO] Nenhuma sessao salva para reconectar.');
  else console.log(`[AUTO] ${count} zap(s) com sessao salva marcado(s) para reconexao automatica.`);
  return count;
}

// Pareamento automatico no boot (GitHub Actions / servidor): com
// LINK_AUTO_PAIR=1, zaps SEM sessao salva e com telefone no zaps.json
// recebem connectZap(pairing) sem interface grafica. O codigo e gravado em
// $LINK_CODE_FILE pelo whatsapp-manager e o monitor envia ao repo de dados.
function autoPairMissingSessions() {
  try {
    const flag = String(process.env.LINK_AUTO_PAIR || '').toLowerCase();
    if (flag !== '1' && flag !== 'true' && flag !== 'yes') return 0;
  } catch (_) { return 0; }
  if (!whatsappManager || typeof whatsappManager.connectZap !== 'function') return 0;
  let count = 0;
  loadZapsData().forEach((z, i) => {
    const zapId = String(z.id);
    const phone = String(z.phone || '').replace(/\D/g, '');
    if (!phone) return;
    const sessionDir = path.join(getDataDir(), 'sessions', zapId);
    if (fs.existsSync(sessionDir)) return;
    count++;
    setTimeout(() => {
      console.log(`[AUTO-PAIR] Zap ${zapId} sem sessao salva - gerando codigo de pareamento...`);
      Promise.resolve(whatsappManager.connectZap(zapId, phone, 'pairing'))
        .catch((e) => console.error(`[AUTO-PAIR] Falha no pareamento do zap ${zapId}: ${e.message}`));
    }, 5000 + i * 3000);
  });
  if (count) console.log(`[AUTO-PAIR] ${count} zap(s) aguardando pareamento (codigo em $LINK_CODE_FILE).`);
  else console.log('[AUTO-PAIR] Nenhum zap precisa de pareamento agora.');
  return count;
}

// ------------------------------------------------------------
// Reconciler do servidor: aplica ao vivo o zaps.json alterado no painel
// (novo zap = conecta/pareia; zap removido/desativado = desconecta)
// ------------------------------------------------------------
function startServerReconciler(intervalMs = 15000) {
  if (!isHeadless() || !whatsappManager) return null;
  const snapshot = () => {
    const map = new Map();
    for (const z of loadZapsData()) map.set(String(z.id), { enabled: z.enabled !== false });
    return map;
  };
  if (!serverKnownZaps) serverKnownZaps = snapshot();
  const autoPair = ['1', 'true', 'yes'].includes(String(process.env.LINK_AUTO_PAIR || '').toLowerCase());
  const timer = setInterval(async () => {
    try {
      const zaps = loadZapsData();
      const ids = new Set(zaps.map((z) => String(z.id)));
      // Removidos no painel: desconecta e apaga a sessao no servidor
      for (const id of [...serverKnownZaps.keys()]) {
        if (ids.has(id)) continue;
        console.log(`[SYNC] Zap ${id} removido no painel - desconectando`);
        try { await whatsappManager.disconnectZap(id, 'removido no painel'); } catch (_) {}
        try { fs.rmSync(path.join(getDataDir(), 'sessions', id), { recursive: true, force: true }); } catch (_) {}
        try { fs.rmSync(path.join(getDataDir(), 'sessions', `${id}.cache-keep`), { recursive: true, force: true }); } catch (_) {}
        try { fs.rmSync(path.join(getDataDir(), 'trainings', id), { recursive: true, force: true }); } catch (_) {}
        serverKnownZaps.delete(id);
      }
      for (const z of zaps) {
        const id = String(z.id);
        const prev = serverKnownZaps.get(id);
        const st = whatsappManager.getStatus(id) || { status: 'disconnected' };
        const busy = ['connecting', 'waiting_qr', 'waiting_pairing', 'pairing_accepted', 'authenticated', 'ready'].includes(st.status);
        if (z.enabled === false) {
          if (busy) {
            console.log(`[SYNC] Zap ${id} desativado no painel - desconectando`);
            try { await whatsappManager.disconnectZap(id, 'desativado no painel'); } catch (_) {}
          }
        } else if ((!prev || prev.enabled === false) && !busy) {
          const sessionDir = path.join(getDataDir(), 'sessions', id);
          const hasSession = fs.existsSync(sessionDir);
          const phone = String(z.phone || '').replace(/\D/g, '');
          if (hasSession) {
            console.log(`[SYNC] Novo zap ${id} com sessao salva - conectando`);
            Promise.resolve(whatsappManager.connectZap(id, '', 'qrcode'))
              .catch((e) => console.error(`[SYNC] connectZap(${id}) falhou: ${e.message}`));
          } else if (autoPair && phone) {
            console.log(`[SYNC] Novo zap ${id} sem sessao - gerando pareamento`);
            Promise.resolve(whatsappManager.connectZap(id, phone, 'pairing'))
              .catch((e) => console.error(`[SYNC] pairing(${id}) falhou: ${e.message}`));
          }
        }
        serverKnownZaps.set(id, { enabled: z.enabled !== false });
      }
    } catch (e) {
      console.error('[SYNC] reconciler falhou:', e.message);
    }
  }, intervalMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
  console.log(`[SYNC] Reconciler ativo (a cada ${Math.round(intervalMs / 1000)}s)`);
  return timer;
}

// ------------------------------------------------------------
// Mensagem Automatica - agente de campanha (ChatBox)
// ------------------------------------------------------------
async function deleteSentMessage(zapId, msgId) {
  if (!msgId) throw new Error('mensagem sem identificador registrado');
  const clientData = whatsappManager && whatsappManager.clients.get(String(zapId));
  if (!clientData || !clientData.client || clientData.status !== 'ready') {
    throw new Error('zap desconectado');
  }
  const msg = await clientData.client.getMessageById(msgId);
  if (!msg) throw new Error('mensagem nao encontrada no historico');
  try {
    await msg.delete(true);
    return 'everyone';
  } catch (e) {
    // Janela de "apagar para todos" expirou (ou nao permitido): apaga so pra voce
    await msg.delete(false);
    return 'mine';
  }
}

function parseAgentJson(text) {
  const t0 = String(text || '').trim();
  if (!t0) return null;
  let t = t0;
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(t.slice(start, end + 1));
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
  } catch (_) {}
  return null;
}

function buildAutoMsgPrompt(zap, attachments) {
  const s = autoMessage.state;
  const recipients = Object.keys(s.recipients);
  const pending = s.queue.filter(q => q.status === 'pending' || q.status === 'sending');
  const sentCount = s.queue.filter(q => q.status === 'sent').length;
  const failed = s.queue.filter(q => q.status === 'failed').length;

  const fmtNums = (list, max) => list.slice(0, max).map(n => '+' + n).join(', ') +
    (list.length > max ? ` (+${list.length - max})` : '');

  const attachmentsInfo = (attachments || []).length
    ? (attachments || []).map(a => `- ${a.name} (${a.mimeType || 'arquivo'}, ${(String(a.data || '').length * 0.75 / 1024).toFixed(0)} KB)`).join('\n')
    : '(nenhum anexo nesta mensagem)';

  return `Voce e o operador de uma campanha de mensagens de WhatsApp dentro de um app. O usuario conversa com voce por aqui (ChatBox) e da ordens: para quem enviar, o que enviar, quando apagar, etc. Voce tem UMA funcao so: disparar mensagens de WhatsApp conforme o pedido.

O HISTORICO da conversa esta nas mensagens abaixo - use-o para lembrar do que ja foi feito, o que o usuario ja pediu e o que deu certo.

SEMPRE responda com UM unico objeto JSON, sem texto antes ou depois:
{
  "reply": "resposta imediata ao usuario, curta (ex: 'Ok, vou enviar agora' ou a resposta a uma pergunta)",  "actions": [
    { "type": "send", "numbers": ["5532999999999"], "text": "texto exato da mensagem", "repeat": 1, "files": [] },
    { "type": "delete", "numbers": ["5532999999999"] },
    { "type": "add", "numbers": ["5532999999999"] }
  ],
  "followup": "mensagem enviada DEPOIS das acoes executadas, citando o resultado (ex: 'Acabei de enviar a mensagem para +5532999999999, mais alguma coisa?')"
}

REGRAS:
- "reply": e o que voce diz ANTES de agir (entendimento/confirmacao/resposta). Sempre preencha.
- "followup": descreva o resultado das acoes (exclusoes, numeros registrados, fila). Para ENVIOS o SISTEMA mostra o resultado real ao usuario automaticamente - NUNCA prometa "ja enviei" antes de saber; prefira "Coloquei na fila". Quando "actions" for [], omita.
- "send": use somente quando o usuario pedir para enviar/disparar/mandar mensagens.
  - "numbers": lista de numeros normalizados com DDI (Brasil = 55 + DDD + numero), ou "all" para TODOS os numeros da agenda.
  - "text": a mensagem exata que deve ser enviada (use o texto do usuario; reescreva somente se ele pedir).
  - "repeat": quantas vezes enviar para cada numero (2 = "envie duas vezes"). Padrao 1.
  - "files": nomes dos anexos DESTA mensagem que devem ir junto. [] = nenhum.
- Identifique no texto do usuario o que e NUMERO DE TELEFONE e o que e MENSAGEM a enviar, e monte as acoes conforme.
- "delete": use quando o usuario pedir para apagar alguma mensagem ja enviada.
- "add": apenas registrar um numero na agenda sem enviar nada.
- NUNCA invente numeros: use apenas numeros que o usuario informou ou que estao na agenda.
- Se o usuario so conversar (pergunta, duvida, feedback), responda com "reply" e "actions": [].
- O intervalo de 5 minutos entre contatos e automatico - nao e um problema, so informe quando perguntarem.
- Arquivos/anexos: decida conforme o pedido do usuario:
  (a) "use a imagem como exemplo" => use como referencia e escreva o texto; "files": [].
  (b) "envie junto com a mensagem" => "files": [nome do arquivo].
  (c) "envie so para o numero X" => "files": [nome] e "numbers": [numero].

CONTEXTO DA CAMPANHA AGORA:
- Conta WhatsApp usada para disparar: ${zap ? (zap.name || '') : ''} (id ${autoMessage.state.zapId || 'nenhum'})
- Status da campanha: ${s.status}
- Agenda de numeros (${recipients.length}): ${recipients.length ? fmtNums(recipients, 40) : '(vazia)'}
- Fila: ${pending.length} pendente(s), ${sentCount} enviada(s), ${failed} falha(s)
- Proximos pendentes: ${pending.length ? fmtNums(pending.map(p => p.phone), 15) : '(nenhum)'}

ANEXOS DESTA MENSAGEM DO USUARIO:
${attachmentsInfo}`;

}

async function autoMsgChat(payload) {
  payload = payload || {};
  const zapId = String(payload.zapId || '');
  const text = String(payload.text || '').trim();
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];

  if (!autoMessage) throw new Error('Mensagem automatica indisponivel');
  if (!zapId) throw new Error('Selecione uma conta WhatsApp antes de conversar');
  if (!text && attachments.length === 0) throw new Error('Escreva uma mensagem para a IA');

  const zapsData = loadZapsData();
  const providersData = loadProvidersData();
  const zap = zapsData.find(z => String(z.id) === String(zapId));
  if (!zap) throw new Error('Conta WhatsApp nao encontrada');

  if (!autoMessage.setZap(zapId)) {
    throw new Error('Ha uma campanha pendente para outra conta. Pare a campanha antes de trocar de Zap.');
  }

  const mentioned = autoMessage.extractNumbers(text);
  const added = mentioned.filter(n => autoMessage.addRecipient(n));
  if (added.length) {
    autoMessage.addLog('info', `Numeros adicionados a agenda: ${added.map(n => '+' + n).join(', ')}`);
  }

  autoMessage.pushChat('user', text + (attachments.length ? `\n[anexos: ${attachments.map(a => a.name).join(', ')}]` : ''));
  autoMessage.addLog('info', `Pedido no ChatBox: "${text.substring(0, 140)}${text.length > 140 ? '...' : ''}"`);

  const systemPrompt = buildAutoMsgPrompt(zap, attachments);
  const messages = [
    { role: 'system', content: systemPrompt },
    ...autoMessage.historyTurns(zapId),
    { role: 'user', content: text || `(o usuario enviou ${attachments.length} arquivo(s): ${attachments.map(a => a.name).join(', ')})` }
  ];

  const modelsToTry = aiResponder && typeof aiResponder.getModelsToTry === 'function'
    ? aiResponder.getModelsToTry(zap, providersData)
    : [];

  if (!modelsToTry.length) {
    const reply = 'Nenhum provedor de IA configurado. Configure em Provedores antes de usar a Mensagem Automatica.';
    autoMessage.addLog('error', reply);
    autoMessage.pushChat('agent', reply);
    autoMessage.save();
    autoMessage.emitUpdate();
    return { ok: false, reply, actions: [] };
  }

  let parsed = null;
  let raw = null;
  let lastErr = null;

  for (let i = 0; i < modelsToTry.length; i++) {
    const entry = modelsToTry[i];
    if (!entry.provider || !entry.provider.apiKey) continue;
    try {
      autoMessage.addLog('ai', `[${i + 1}/${modelsToTry.length}] Consultando ${entry.provider.name} / ${entry.model.id}...`);
      const r = await aiResponder.callAI(entry.provider, entry.model, messages);
      const txt = typeof r === 'string' ? r.trim() : '';
      if (!txt) { lastErr = 'resposta vazia'; continue; }
      if (typeof aiResponder.isJunkResponse === 'function' && aiResponder.isJunkResponse(txt)) {
        lastErr = 'resposta invalida (texto de sistema)';
        continue;
      }
      parsed = parseAgentJson(txt);
      if (parsed) { raw = txt; break; }

      // Uma unica tentativa pedindo so o JSON
      const retryMsgs = messages.concat([
        { role: 'assistant', content: txt },
        { role: 'user', content: 'Responda SOMENTE com o objeto JSON valido, com "reply", "actions" e (se houver acoes) "followup". Nada fora do JSON.' }
      ]);
      const r2 = await aiResponder.callAI(entry.provider, entry.model, retryMsgs);
      const txt2 = typeof r2 === 'string' ? r2.trim() : '';
      parsed = parseAgentJson(txt2);
      if (parsed) { raw = txt2; break; }
      lastErr = 'modelo nao retornou JSON valido';
    } catch (e) {
      lastErr = e.message;
      autoMessage.addLog('warning', `${entry.provider.name} / ${entry.model.id} falhou: ${e.message}`);
    }
  }

  let reply = '';
  let actions = [];
  let followup = '';
  if (parsed) {
    reply = String(parsed.reply || '').trim();
    actions = Array.isArray(parsed.actions) ? parsed.actions : [];
    followup = String(parsed.followup || '').trim();
    if (!reply) reply = 'Pedido entendido.';
  } else {
    autoMessage.addLog('warning', `IA nao respondeu em JSON valido (${lastErr || 'desconhecido'}) - pedido NAO executado`);
    reply = (raw || '').trim() || 'Nao consegui processar seu pedido. Pode reformular?';
  }

  autoMessage.addLog('ai', `IA: ${previewText(reply)}`);
  autoMessage.pushChat('agent', reply);
  autoMessage.save();
  autoMessage.emitUpdate();

  const countsBefore = autoMessage.getState().counts;
  const result = await autoMessage.runActions(actions, attachments);
  if (result.scheduled > 0) {
    autoMessage.addLog('info', `Acoes: ${result.notes.join(' | ')} - proximo envio em 5:00`);
    // espera o primeiro envio concluir para o followup refletir o resultado real
    await autoMessage.waitForFirstOutcome(15000);
  } else if (actions.length) {
    autoMessage.addLog('info', `Acoes: ${result.notes.join(' | ')}`);
  }
  autoMessage.save();
  autoMessage.emitUpdate();

  if (actions.length) {
    const after = autoMessage.getState().counts;
    const sentDelta = Math.max(0, (after.sent || 0) - (countsBefore.sent || 0));
    const failedDelta = Math.max(0, (after.failed || 0) - (countsBefore.failed || 0));
    // O resultado REAL manda: a IA nao pode prometer "enviei" sem ter enviado
    if (failedDelta && !sentDelta) {
      followup = `Tentei enviar mas ${failedDelta} mensagem(ns) falharam (detalhes no historico). Quer que eu tente de novo?`;
    } else if (sentDelta && failedDelta) {
      followup = `Acabei de enviar ${sentDelta} mensagem(ns), com ${failedDelta} falha(s). Mais alguma coisa?`;
    } else if (sentDelta) {
      followup = `Acabei de enviar ${sentDelta === 1 ? 'a mensagem' : sentDelta + ' mensagens'}. Mais alguma coisa?`;
    } else if (result.scheduled > 0) {
      followup = `Coloquei ${result.scheduled} mensagem(ns) na fila com intervalo de 5 minutos - o primeiro resultado aparece aqui em instantes.`;
    } else if (!followup) {
      followup = autoMsgFollowup(result, countsBefore, after);
    }
    if (followup) {
      autoMessage.pushChat('agent', followup);
      autoMessage.save();
      autoMessage.emitUpdate();
    }
  }

  return { ok: true, reply, followup, actions: result, raw: parsed ? null : raw };
}

// Followup automatico quando a IA nao informou o resultado
function autoMsgFollowup(result, before, after) {
  const sent = Math.max(0, (after && after.sent || 0) - (before && before.sent || 0));
  const failed = Math.max(0, (after && after.failed || 0) - (before && before.failed || 0));
  if (failed && !sent) return `Tentei enviar mas ${failed} mensagem(ns) falharam. Quer que eu tente de novo?`;
  if (sent && failed) return `Acabei de enviar ${sent} mensagem(ns), com ${failed} falha(s). Mais alguma coisa?`;
  if (sent) return `Acabei de enviar ${sent === 1 ? 'a mensagem' : sent + ' mensagens'}. Mais alguma coisa?`;
  if (result && result.scheduled > 0) return `Deixei ${result.scheduled} mensagem(ns) na fila com intervalo de 5 minutos. Mais alguma coisa?`;
  return 'Pedido executado. Mais alguma coisa?';
}

function previewText(text) {
  const t = String(text || '');
  return t.length > 160 ? t.substring(0, 160) + '...' : t;
}

function initAutoMessage() {
  autoMessage = new AutoMessageManager();
  autoMessage.configure({
    filePath: getFilePath('auto-msg-state.json'),
    getStatus: (zapId) => {
      try { return whatsappManager.getStatus(String(zapId)); } catch (_) { return { status: 'disconnected' }; }
    },
    sendMessage: (zapId, phone, txt) => whatsappManager.sendMessage(String(zapId), phone, txt),
    sendMedia: (zapId, phone, media) => whatsappManager.sendMedia(String(zapId), phone, media),
    deleteMessage: deleteSentMessage,
    getContactName: (zapId, phone) => {
      try { return whatsappManager.getContactName(String(zapId), String(phone)); } catch (_) { return ''; }
    },
    onLog: (entry) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('auto-msg-log', entry);
    },
    onUpdate: () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('auto-msg-update', autoMessage.getState());
    },
    logger: console.log
  });
  autoMessage.load();
  const resumed = autoMessage.resumeOnBoot();
  if (resumed) ensureCampaignZapConnected();
  return autoMessage;
}

// Reconnecta a conta da campanha se ela caiu junto com o app
function ensureCampaignZapConnected() {
  if (!autoMessage || !whatsappManager) return;
  const zapId = autoMessage.state.zapId;
  if (!zapId) return;
  try {
    const st = (whatsappManager.getStatus(zapId) || {}).status;
    if (st === 'ready' || st === 'connecting' || st === 'waiting_qr' || st === 'waiting_pairing') return;
    const sessionDir = path.join(getDataDir(), 'sessions', zapId);
    if (!fs.existsSync(sessionDir)) {
      autoMessage.addLog('warning', `Sem sessao salva para a conta ${zapId} - conecte manualmente para a campanha continuar`);
      autoMessage.emitUpdate();
      return;
    }
    autoMessage.addLog('info', `Reconectando a conta ${zapId} para continuar a campanha...`);
    Promise.resolve(whatsappManager.connectZap(zapId, '', 'qrcode'))
      .catch((e) => console.error(`[AUTOMSG] Falha ao reconectar conta da campanha ${zapId}: ${e.message}`));
  } catch (e) {
    console.error('[AUTOMSG] ensureCampaignZapConnected falhou:', e.message);
  }
}

// ------------------------------------------------------------
// App lifecycle
// ------------------------------------------------------------
app.whenReady().then(() => {
  ensureDataDir();
  if (!isHeadless()) createWindow();

  // Modo servidor: o app local e apenas o painel. As configuracoes vao para
  // o clone do repo de dados e o servidor 24h as aplica (nao conectamos o
  // WhatsApp aqui para nao derrubar a sessao do servidor).
  try {
    const dataRepoDir = process.env.LINK_DATA_REPO_DIR || path.join(__dirname, 'data');
    const resolvedRepo = path.resolve(dataRepoDir);
    const localDir = path.resolve(getDataDir());
    const syncOff = ['0', 'false', 'no'].includes(String(process.env.LINK_SERVER_SYNC || '').toLowerCase());
    const isElectron = !!process.versions.electron; // falso nos testes (Node puro)
    if (isElectron && !isHeadless() && !syncOff && resolvedRepo !== localDir && fs.existsSync(path.join(resolvedRepo, '.git'))) {
      serverSync = new ServerSync({ sourceDir: localDir, dataDir: resolvedRepo });
      serverMode = !!serverSync.enabled;
    }
  } catch (e) {
    console.error('[SYNC] init falhou:', e.message);
  }
  if (serverMode) {
    process.env.LINK_CONNECT_READONLY = '1';
    console.log(`[SYNC] Modo servidor ativo - configs seguem para ${serverSync.dataDir}`);
  }

  whatsappManager = new WhatsAppManager(mainWindow);
  aiResponder = new AIResponder();
  initConversationStore();
  appAgent = new AppAgent({
    aiResponder,
    getProviders: loadProvidersData,
    resolveProviderKey,
    loadZaps: loadZapsData,
    saveZaps: (zaps) => {
      ensureDataDir();
      const p = getFilePath('zaps.json');
      const tmp = p + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(zaps, null, 2));
      fs.renameSync(tmp, p);
      if (serverSync) serverSync.scheduleSync();
    },
    loadTrainings: loadTrainingsData,
    saveTrainings: (data) => {
      ensureDataDir();
      fs.writeFileSync(getFilePath('trainings.json'), JSON.stringify(data, null, 2));
      if (serverSync) serverSync.scheduleSync();
    },
    getConversationStore: () => conversationStore || initConversationStore(),
    whatsapp: whatsappManager,
    log: (type, msg) => console.log(`[AGENTE][${type}] ${msg}`)
  });
  try { initAutoMessage(); } catch (e) { console.error('[AUTOMSG] Falha ao iniciar mensagem automatica:', e.message); }
  whatsappManager.setOnMessageCallback(async (messageData) => {
    try { await handleIncomingMessage(messageData); } catch (e) { console.error('handleIncomingMessage erro:', e); }
  });
  startStatusServer();
  if (serverMode) {
    // Mantem o status real do servidor no painel e repassa codigo/QR para a UI
    try {
      serverSync.onPairingCode((d) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('whatsapp-pairing-code', d);
      });
      serverSync.onQr((d) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('whatsapp-qr', d);
      });
      serverSync.onStatus((d) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('whatsapp-status', d);
      });
      serverSync.refreshStatus().catch(() => {});
      const syncPoll = setInterval(() => serverSync.refreshStatus().catch(() => {}), 15000);
      if (syncPoll && typeof syncPoll.unref === 'function') syncPoll.unref();
    } catch (e) {
      console.error('[SYNC] listeners falharam:', e.message);
    }
  } else {
    autoConnectSavedSessions();
  }
  if (isHeadless()) {
    autoPairMissingSessions();
    startServerReconciler();
  }
  const statusTimer = setInterval(persistBotStatus, 30000);
  if (statusTimer && typeof statusTimer.unref === 'function') statusTimer.unref();
});

let isAppQuitting = false;
app.on('before-quit', (e) => {
  if (isAppQuitting) return;
  if (isHeadless()) return;
  e.preventDefault();
  isAppQuitting = true;
  (async () => {
    try {
      if (conversationStore) conversationStore.flush();
      if (whatsappManager) await whatsappManager.disconnectAll();
      persistBotStatus();
    } catch (_) {}
    app.exit(0);
  })();
});

app.on('window-all-closed', () => {
  if (isHeadless()) return;
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (isHeadless()) return;
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
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
ipcMain.handle('whatsapp-connect', (e, zapId, phone, method) => {
  if (serverMode) return { status: 'readonly', error: 'zap gerenciado pelo servidor - nao conecte pelo PC' };
  return whatsappManager.connectZap(String(zapId), phone, method);
});
ipcMain.handle('whatsapp-disconnect', (e, zapId) => {
  if (serverMode) return { ok: false, error: 'zap gerenciado pelo servidor' };
  return whatsappManager.disconnectZap(String(zapId));
});
ipcMain.handle('whatsapp-status', (e, zapId) => {
  if (serverMode && serverSync) {
    const s = serverSync.getZapStatus(String(zapId));
    if (s) return s;
  }
  return whatsappManager.getStatus(String(zapId));
});
ipcMain.handle('pick-zap-icon', async () => {
  try {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Escolher icone do Zap',
      properties: ['openFile'],
      filters: [{ name: 'Imagens', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
    });
    if (!res || res.canceled || !res.filePaths || !res.filePaths[0]) {
      return { ok: false, canceled: true };
    }
    const img = nativeImage.createFromPath(res.filePaths[0]);
    if (img.isEmpty()) return { ok: false, error: 'arquivo de imagem invalido' };
    const size = img.getSize();
    const max = 128;
    const scale = Math.min(1, max / Math.max(size.width || 1, size.height || 1));
    const out = scale < 1
      ? img.resize({ width: Math.round(size.width * scale), height: Math.round(size.height * scale) })
      : img;
    return { ok: true, dataUrl: out.toDataURL() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('whatsapp-send', async (e, zapId, phone, text) => {
  const r = await whatsappManager.sendMessage(String(zapId), phone, text);
  whatsappManager.markOwnerReply(String(zapId), phone);
  return r;
});
ipcMain.handle('whatsapp-conversations', (e, zapId) => whatsappManager.getConversations(String(zapId)));
ipcMain.handle('whatsapp-messages', (e, zapId, chatId) => whatsappManager.getMessages(String(zapId), chatId));
ipcMain.handle('whatsapp-send-media', async (e, zapId, phone, media) => {
  const r = await whatsappManager.sendMedia(String(zapId), phone, media || {});
  whatsappManager.markOwnerReply(String(zapId), phone);
  return r;
});

// ------------------------------------------------------------
// IPC - Mensagem Automatica
// ------------------------------------------------------------
ipcMain.handle('auto-msg-state', () => (autoMessage ? autoMessage.getState() : null));
ipcMain.handle('auto-msg-chat', (e, payload) => autoMsgChat(payload));
ipcMain.handle('auto-msg-stop', () => {
  if (autoMessage) autoMessage.stop();
  return autoMessage ? autoMessage.getState() : null;
});
// Linha de sistema no historico (ex: resposta recebida de um contato)
ipcMain.handle('auto-msg-note', (e, payload) => {
  payload = payload || {};
  if (autoMessage && payload.text && payload.zapId) {
    autoMessage.pushSystem(String(payload.text).substring(0, 300), String(payload.zapId));
    autoMessage.save();
    autoMessage.emitUpdate();
  }
  return autoMessage ? autoMessage.getState() : null;
});
ipcMain.handle('auto-msg-transcribe', async (e, audio, zapId) => {
  const providersData = loadProvidersData();
  const zid = String(zapId || '');
  const zap = loadZapsData().find(z => String(z.id) === zid);
  return await transcribeAudio(audio, providersData, zid, zap ? zap.apiKeySelections : null);
});

// ------------------------------------------------------------
// IPC - Agente IA do Dashboard (controla o app)
// ------------------------------------------------------------
ipcMain.handle('agent-chat', async (e, payload) => {
  if (!appAgent) return { reply: 'Agente ainda nao inicializado. Reinicie o app.', steps: [] };
  try {
    return await appAgent.run(payload || {});
  } catch (err) {
    console.error('[AGENTE] erro:', err && err.stack ? err.stack : err);
    return {
      reply: 'Tive um problema para processar: ' + (err && err.message ? err.message : String(err)),
      steps: [],
      error: true
    };
  }
});

// ------------------------------------------------------------
// IPC - Data persistence
// ------------------------------------------------------------
ipcMain.handle('load-zaps', () => {
  if (!fs.existsSync(getFilePath('zaps.json'))) return null;
  return loadZapsData();
});
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
  if (serverSync) serverSync.scheduleSync();
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
  if (serverSync) serverSync.scheduleSync();
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
  if (serverSync) serverSync.scheduleSync();
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
  // Remove a pasta inteira do zap (imagens/arquivos que sobraram)
  const zapDir = path.join(getDataDir(), 'trainings', zid);
  try { fs.rmSync(zapDir, { recursive: true, force: true }); } catch (_) {}
  delete all[zid];
  fs.writeFileSync(getFilePath('trainings.json'), JSON.stringify(all, null, 2));
  if (serverSync) serverSync.scheduleSync();
  return true;
});

// ------------------------------------------------------------
// IPC - Sincronizacao com o servidor (painel unificado)
// ------------------------------------------------------------
ipcMain.handle('server-info', () => ({
  enabled: serverMode,
  dataDir: serverSync ? serverSync.dataDir : null,
  status: serverSync ? serverSync.getStatus() : { enabled: false, state: 'disabled' }
}));
ipcMain.handle('server-sync-now', () => (serverSync ? serverSync.syncNow() : { ok: false, disabled: true, error: 'sincronizacao desativada' }));
ipcMain.handle('server-sync-status', () => (serverSync ? serverSync.getStatus() : { enabled: false, state: 'disabled' }));
ipcMain.handle('server-delete-zap-session', (e, zapId) => {
  const id = String(zapId);
  // Sempre apaga a sessao local, mesmo sem server-sync (modo local)
  for (const suffix of ['', '.cache-keep']) {
    try {
      fs.rmSync(path.join(getDataDir(), 'sessions', id + suffix), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (_) {}
  }
  if (serverSync) return serverSync.deleteZapSession(id);
  return { ok: true, localOnly: true };
});
ipcMain.handle('server-status', () => (serverSync ? serverSync.getBotStatus() : null));
ipcMain.handle('server-pairing-codes', () => (serverSync ? serverSync.getPairingCodes() : {}));

module.exports = {
  getDataDir,
  getFilePath,
  ensureDataDir,
  isHeadless,
  buildStatusState,
  startStatusServer,
  getStatusServer,
  getLogRing,
  autoConnectSavedSessions,
  getAutoMessage: () => autoMessage
};
