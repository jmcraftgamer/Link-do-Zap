const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const WhatsAppManager = require('./src/js/whatsapp-manager');
const AIResponder = require('./src/js/ai-responder');

let mainWindow;
let whatsappManager;
let aiResponder;
let rendererDragging = false;

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

function parseImageMarkers(text) {
  const re = /\[SEND_IMAGE:([^\]]+)\]/g;
  const ids = [];
  let m;
  while ((m = re.exec(text)) !== null) ids.push(m[1]);
  const clean = text.replace(re, '').trim();
  return { ids, clean };
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

async function sendTypingIndicator(zapId, chatId) {
  try {
    const clientData = whatsappManager && whatsappManager.clients.get(String(zapId));
    if (!clientData) return;
    const chat = clientData.chats ? clientData.chats.get(chatId) : null;
    if (chat && chat.sendStateTyping) {
      await chat.sendStateTyping();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('whatsapp-typing', { zapId: String(zapId), chatId, isTyping: true });
      }
      sendLog(zapId, 'info', 'Indicador digitando enviado no WhatsApp');
    }
  } catch (e) {
    sendLog(zapId, 'warning', `Nao foi possivel enviar digitando: ${e.message}`);
  }
}

async function clearTypingIndicator(zapId, chatId) {
  try {
    const clientData = whatsappManager && whatsappManager.clients.get(String(zapId));
    const chat = clientData && clientData.chats ? clientData.chats.get(chatId) : null;
    if (chat && chat.clearState) await chat.clearState();
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
    return await aiResponder.transcribeAudio(audio, providersData, zapId, apiKeySelections);
  }
  // Fallback: try OpenAI whisper via any provider that has key
  const anyProvider = (providersData || []).find(p => p.apiKey || (Array.isArray(p.apiKeys) && p.apiKeys[0]));
  if (!anyProvider) throw new Error('Nenhum provedor com chave para transcrever audio');
  throw new Error('Transcricao de audio nao configurada');
}

// ------------------------------------------------------------
// Core: handle incoming WhatsApp message -> IA -> reply
// ------------------------------------------------------------
async function handleIncomingMessage(messageData) {
  const { zapId, body, from, to, fromMe, chat, contact, audio } = messageData;
  const contactName = contact?.name || from;
  const chatId = chat?.id || from;

  if (fromMe) {
    const fromNumber = (from || '').split('@')[0];
    const toNumber = (to || '').split('@')[0];
    if (fromNumber !== toNumber) return;
    sendLog(zapId, 'ai', `IA iniciando (teste para si mesmo): "${body}"`);
  } else {
    sendLog(zapId, 'ai', `IA iniciando para ${contactName}: "${body}"`);
  }

  if (chat && chat.isGroup) {
    sendLog(zapId, 'info', `Ignorando mensagem de grupo (${contactName})`);
    return;
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

  // Typing indicator + 5s delay
  await sendTypingIndicator(zapId, chatId);
  sendLog(zapId, 'info', 'Digitando por 5 segundos...');
  await new Promise(resolve => setTimeout(resolve, 5000));
  await clearTypingIndicator(zapId, chatId);

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
      if (r && r.trim().length > 0) {
        response = r;
        sendLog(zapId, 'success', `Resposta obtida com ${entry.provider.name} / ${entry.model.id}`);
        break;
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
    await sendErrorToWhatsApp(zapId, chatId, 'Desculpe, tive um problema tecnico. Pode repetir sua mensagem?');
    return;
  }

  // Parse image markers and send
  const { ids: imageIds, clean: cleanText } = parseImageMarkers(response);
  const textToSend = cleanText;

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

  // Send training images if requested via [SEND_IMAGE:id]
  if (imageIds.length > 0) {
    for (const imgId of imageIds) {
      let found = null;
      for (const t of enabledTrainings) {
        const img = (t.images || []).find(im => String(im.id) === String(imgId));
        if (img) { found = img; break; }
      }
      if (!found) {
        sendLog(zapId, 'warning', `Imagem de treinamento ${imgId} nao encontrada`);
        continue;
      }
      const rel = found.file || null;
      if (!rel) {
        // Try inline data fallback
        if (found.data) {
          try {
            await whatsappManager.sendMedia(String(zapId), chatId, { data: found.data, mimeType: found.mimeType || 'image/jpeg', name: found.filename || `${imgId}.jpg` });
            sendLog(zapId, 'success', `Imagem enviada: ${found.filename || imgId}`);
            continue;
          } catch (e) {
            sendLog(zapId, 'error', `Falha ao enviar imagem ${imgId}: ${e.message}`);
            continue;
          }
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
        sendLog(zapId, 'success', `Imagem enviada: ${found.filename || imgId}`);
      } catch (e) {
        sendLog(zapId, 'error', `Falha ao enviar imagem ${imgId}: ${e.message}`);
      }
    }
  }

  if (!textToSend && imageIds.length === 0) {
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
