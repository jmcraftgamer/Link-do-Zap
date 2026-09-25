const { Client, LocalAuth, MessageMedia } = require('wwebjs-electron');
const path = require('path');
const fs = require('fs');
let QRCode = null;
try { QRCode = require('qrcode'); } catch (_) { console.warn('[QR] qrcode npm não encontrado, fallback para serviço remoto'); }

class WhatsAppManager {
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
    this.clients = new Map();
    this.conversations = new Map();
    this.onMessageCallback = null;
    // Use Electron userData if available, fallback to env
    let baseDir;
    try {
      const { app } = require('electron');
      baseDir = path.join(app.getPath('userData'), 'link-no-whatsapp');
    } catch (_) {
      const os = require('os');
      baseDir = path.join(process.env.APPDATA || process.env.HOME || process.env.USERPROFILE || os.homedir(), 'link-no-whatsapp');
    }
    this.contactsFilePath = path.join(baseDir, 'contacts.json');
    this._baseDir = baseDir;
    this.loadPersistedContacts();
  }

  loadPersistedContacts() {
    try {
      if (fs.existsSync(this.contactsFilePath)) {
        const raw = JSON.parse(fs.readFileSync(this.contactsFilePath, 'utf8'));
        Object.keys(raw).forEach(zapId => {
          const map = new Map();
          const entries = raw[zapId] || {};
          Object.keys(entries).forEach(chatId => {
            map.set(chatId, entries[chatId]);
          });
          this.conversations.set(zapId, map);
        });
        console.log(`[CONTACTS] Contatos persistidos carregados para ${this.conversations.size} zaps`);
      }
    } catch (e) {
      console.error('[CONTACTS] Erro ao carregar contatos persistidos:', e.message);
    }
  }

  persistContacts() {
    try {
      const dir = path.dirname(this.contactsFilePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const out = {};
      this.conversations.forEach((map, zapId) => {
        out[zapId] = {};
        map.forEach((conv, chatId) => {
          // Only persist contact info + last message, not full message history
          out[zapId][chatId] = {
            contact: conv.contact,
            messages: (conv.messages || []).slice(-20),
            lastMessage: conv.lastMessage
          };
        });
      });
      fs.writeFileSync(this.contactsFilePath, JSON.stringify(out, null, 2));
    } catch (e) {
      console.error('[CONTACTS] Erro ao persistir contatos:', e.message);
    }
  }

  setOnMessageCallback(callback) {
    this.onMessageCallback = callback;
  }

  async connectZap(zapId, phoneNumber, method = 'qrcode') {
    if (this.clients.has(zapId)) {
      this.logToApp(zapId, 'info', 'Ja estava conectado - reconectando (limpando sessao anterior)...');
      await this.disconnectZap(zapId);
    }

    const sessionPath = path.join(this._baseDir, 'sessions', zapId);

    // For pairing code, always start fresh (no old sessions)
    if (method === 'pairing' && fs.existsSync(sessionPath)) {
      try {
        fs.rmSync(sessionPath, { recursive: true, force: true });
        this.logToApp(zapId, 'info', 'Sessao antiga removida (pareamento)');
      } catch (e) {
        console.error('Erro ao remover sessao antiga:', e);
      }
    }

    if (!fs.existsSync(sessionPath)) {
      fs.mkdirSync(sessionPath, { recursive: true });
    }

    const cleanPhone = phoneNumber.replace(/\D/g, '');
    this.logToApp(zapId, 'info', `Conectando ao WhatsApp (${cleanPhone}, metodo: ${method})...`);

    const clientOptions = {
      authStrategy: new LocalAuth({
        clientId: zapId,
        dataPath: sessionPath
      }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--disable-gpu',
          '--disable-features=IsolateOrigins,site-per-process'
        ],
        timeout: 120000,
        protocolTimeout: 180000
      },
      webVersionCache: { type: 'none' }
    };

    // Pareamento robusto: nao usar pairWithPhoneNumber no construtor para controle total
    // Vamos chamar requestPairingCode explicitamente apos initialize
    const isPairing = method === 'pairing' && !!cleanPhone;

    const client = new Client(clientOptions);

    this.clients.set(zapId, {
      client,
      status: 'connecting',
      phoneNumber: cleanPhone,
      method,
      qrCode: null,
      pairingCode: null,
      messages: new Map(),
      chats: new Map(),
      startupTime: Math.floor(Date.now() / 1000)
    });

    client.on('qr', async (qr) => {
      this.logToApp(zapId, 'info', 'QR Code gerado. Escaneie com o celular.');
      const data = this.clients.get(zapId);
      if (data) {
        data.qrCode = qr;
        data.status = 'waiting_qr';
      }
      let dataUrl = null;
      if (QRCode) {
        try { dataUrl = await QRCode.toDataURL(qr, { width: 280, margin: 1 }); } catch (e) { console.warn('[QR] falha ao gerar dataUrl:', e.message); }
      }
      this.sendToRenderer('whatsapp-qr', { zapId, qr, dataUrl });
    });

    client.on('code', (code) => {
      this.logToApp(zapId, 'success', `Codigo de pareamento gerado: ${code}`);
      const data = this.clients.get(zapId);
      if (data) {
        data.pairingCode = code;
        data.status = 'waiting_pairing';
      }
      this.sendToRenderer('whatsapp-pairing-code', { zapId, code });
    });

    client.on('loading_screen', (percent, message) => {
      console.log(`[WHATSAPP] Zap ${zapId} carregando: ${percent}% - ${message}`);
    });

    client.on('change_state', (state) => {
      console.log(`[WHATSAPP] Zap ${zapId} state: ${state}`);
      this.logToApp(zapId, 'info', `Estado WhatsApp: ${state}`);
      if (state === 'CONNECTED') {
        this.logToApp(zapId, 'info', `WhatsApp conectado (estado CONNECTED) - aguardando autenticacao...`);
      }
    });

    client.on('change_battery', (batteryInfo) => {
      console.log(`[WHATSAPP] Zap ${zapId} bateria: ${batteryInfo.battery}% - plugged: ${batteryInfo.plugged}`);
    });

    // Unified handlers - no double-remove hack needed
    const handleReady = () => {
      const data = this.clients.get(zapId);
      if (data) {
        data.status = 'ready';
        data.qrCode = null;
        data.pairingCode = null;
        if (data.pairingInterval) { clearInterval(data.pairingInterval); data.pairingInterval = null; }
        // readyAt = PC clock (seconds), readyWall = wall time for history window, historyBufferUntil = 90s after ready
        // We use a hybrid check: for 90s after ready we filter by timestamp, after that we accept all (fixes PC clock skew)
        data.readyAt = Math.floor(Date.now() / 1000);
        data.readyWall = Date.now();
        data.historyBufferUntil = Date.now() + 90 * 1000;
      }
      this.logToApp(zapId, 'success', `CONECTADO e pronto! Sistema ativo. readyAt=${this.clients.get(zapId)?.readyAt} (buffer 90s)`);
      this.sendToRenderer('whatsapp-status', { zapId, status: 'ready' });
      this.fetchAllContacts(zapId).catch(e => {
        const msg = e && e.message ? e.message : String(e);
        const stack = e && e.stack ? e.stack.split('\n')[0] : '';
        console.error('[CONTACTS] Erro:', msg, stack);
        this.logToApp(zapId, 'warning', `Erro ao buscar contatos: ${msg} ${stack}`);
      });
    };
    const handleAuthenticated = () => {
      const data = this.clients.get(zapId);
      if (data) {
        data.status = 'authenticated';
        if (data.pairingInterval) { clearInterval(data.pairingInterval); data.pairingInterval = null; }
      }
      this.logToApp(zapId, 'success', 'Autenticado (sessao valida)');
      this.sendToRenderer('whatsapp-status', { zapId, status: 'authenticated' });
    };
    const handleAuthFailure = (msg) => {
      console.error(`Falha na autenticacao do Zap ${zapId}:`, msg);
      const data = this.clients.get(zapId);
      if (data) {
        data.status = 'auth_failure';
        if (data.pairingInterval) { clearInterval(data.pairingInterval); data.pairingInterval = null; }
      }
      let friendlyMsg = msg || 'Autenticacao negada';
      if (msg && (msg.includes('query_link') || msg.includes('not allowed') || msg.includes('linked'))) {
        friendlyMsg = 'Nao foi possivel vincular. Verifique se o numero esta correto e se o WhatsApp esta aberto no celular.';
      }
      this.logToApp(zapId, 'error', `Falha na autenticacao: ${friendlyMsg}`);
      this.sendToRenderer('whatsapp-status', { zapId, status: 'auth_failure', error: friendlyMsg });
    };
    const handleDisconnected = (reason) => {
      const data = this.clients.get(zapId);
      if (data) {
        data.status = 'disconnected';
        if (data.pairingInterval) { clearInterval(data.pairingInterval); data.pairingInterval = null; }
      }
      this.logToApp(zapId, 'warning', `Zap DESCONECTADO (${reason}). Mensagens nao serao processadas ate reconectar.`);
      this.sendToRenderer('whatsapp-status', { zapId, status: 'disconnected', reason });
    };

    client.on('ready', handleReady);
    client.on('authenticated', handleAuthenticated);
    client.on('auth_failure', handleAuthFailure);
    client.on('disconnected', handleDisconnected);

    // ============================================================
    // EVENTO 'message': dispara para mensagens RECEBIDAS de outros
    // ============================================================
    client.on('message', async (msg) => {
      const data = this.clients.get(zapId);
      if (!data) return;

      // Armazena o objeto original para poder usar reply() depois
      data.messages.set(msg.id._serialized, msg);
      if (data.messages.size > 100) {
        const keys = Array.from(data.messages.keys());
        for (let i = 0; i < keys.length - 100; i++) {
          data.messages.delete(keys[i]);
        }
      }

      // Processa a mensagem (popula conversas para a UI + chama IA se for nova)
      await this.handleMessage(zapId, msg);
    });

    // ============================================================
    // EVENTO 'message_create': dispara para TODAS as mensagens,
    // inclusive as que EU envio. Usamos para capturar mensagens
    // enviadas para si mesmo (teste).
    // ============================================================
    client.on('message_create', async (msg) => {
      if (msg.fromMe) {
        // Verifica se a mensagem foi enviada para mim mesmo
        const fromNum = msg.from ? msg.from.split('@')[0] : '';
        const toNum = msg.to ? msg.to.split('@')[0] : '';
        if (fromNum && toNum && fromNum === toNum) {
          // Mensagem para si mesmo - processa como se fosse recebida
          const data = this.clients.get(zapId);
          if (data) {
            data.messages.set(msg.id._serialized, msg);
            await this.handleMessage(zapId, msg);
          }
        }
      }
    });

    // Pairing interval is stored in clientData.pairingInterval; cleanup handled in handleReady/handleAuthenticated/handleDisconnected
    const clearPairingInterval = () => {
      const d = this.clients.get(zapId);
      if (d && d.pairingInterval) { clearInterval(d.pairingInterval); d.pairingInterval = null; }
    };

    try {
      this.sendToRenderer('whatsapp-status', { zapId, status: 'connecting' });
      await client.initialize();

      // Pareamento robusto: gerar codigo explicitamente apos initialize
      if (isPairing) {
        try {
          this.logToApp(zapId, 'info', `Solicitando codigo de pareamento para ${cleanPhone}...`);
          // Pequeno delay para garantir que a pagina carregou
          await new Promise(r => setTimeout(r, 1500));
          let code;
          try {
            code = await client.requestPairingCode(cleanPhone);
          } catch (firstErr) {
            // Fallback: tentar com intervalo explicito
            this.logToApp(zapId, 'warning', `Primeira tentativa falhou (${firstErr.message}), tentando novamente...`);
            await new Promise(r => setTimeout(r, 2000));
            code = await client.requestPairingCode(cleanPhone, true, 60000);
          }
          this.logToApp(zapId, 'success', `Codigo de pareamento gerado: ${code}`);
          const data = this.clients.get(zapId);
          if (data) {
            data.pairingCode = code;
            data.status = 'waiting_pairing';
          }
          this.sendToRenderer('whatsapp-pairing-code', { zapId, code });

          // Regeneracao automatica a cada 60s se ainda nao conectado
          let attempts = 0;
          const regenInterval = setInterval(async () => {
            const d = this.clients.get(zapId);
            if (!d || d.status === 'ready' || d.status === 'authenticated') {
              clearInterval(regenInterval);
              if (d) d.pairingInterval = null;
              return;
            }
            if (attempts >= 4) {
              clearInterval(regenInterval);
              if (d) d.pairingInterval = null;
              this.logToApp(zapId, 'warning', 'Pareamento expirou apos 5 tentativas. Gere novo codigo clicando novamente.');
              this.sendToRenderer('whatsapp-status', { zapId, status: 'pairing_timeout' });
              return;
            }
            try {
              const newCode = await client.requestPairingCode(cleanPhone, true, 60000);
              this.logToApp(zapId, 'info', `Novo codigo gerado (tentativa ${attempts + 2}/5): ${newCode}`);
              const dd = this.clients.get(zapId);
              if (dd) { dd.pairingCode = newCode; dd.status = 'waiting_pairing'; }
              this.sendToRenderer('whatsapp-pairing-code', { zapId, code: newCode });
              attempts++;
            } catch (e) {
              this.logToApp(zapId, 'error', `Falha ao regenerar codigo: ${e.message}`);
            }
          }, 60000);
          const cData = this.clients.get(zapId);
          if (cData) cData.pairingInterval = regenInterval;
        } catch (e) {
          this.logToApp(zapId, 'error', `Falha ao solicitar codigo de pareamento: ${e.message}`);
          // Nao joga erro fatal - deixa usuario tentar novamente ou usar QR
          this.sendToRenderer('whatsapp-status', { zapId, status: 'pairing_error', error: e.message });
        }
      }

      return { status: 'initializing', method };
    } catch (error) {
      clearPairingInterval();
      console.error(`Erro ao inicializar Zap ${zapId}:`, error);
      this.logToApp(zapId, 'error', `Erro ao iniciar WhatsApp: ${error.message}`);
      this.clients.delete(zapId);
      return { status: 'error', error: error.message };
    }
  }

  async handleMessage(zapId, msg) {
    try {
      // Normalize chat/contact detection: handle @g.us (grupo), @lid (novo ID), @c.us/@s.whatsapp.net
      const rawFrom = msg.from || '';
      let contactName = 'Desconhecido';
      let contactNumber = rawFrom.split('@')[0].replace(/:.*/, '');
      // fallback numeric extraction for @lid where id.user is lid hash
      let chatId = rawFrom;
      let chatName = contactNumber;
      let isGroup = rawFrom.includes('@g.us') || rawFrom.includes('@broadcast') || rawFrom.includes('@newsletter');

      try {
        const contact = await msg.getContact();
        contactName = contact.name || contact.pushname || contact.id.user;
        contactNumber = contact.id.user;
      } catch (e) {
        console.log('Aviso: nao foi possivel obter contato, usando dados basicos');
      }

      try {
        const chat = await msg.getChat();
        chatId = chat.id._serialized;
        chatName = chat.name || chat.id.user || chatName;
        // reliable group detection from chat object
        if (typeof chat.isGroup === 'boolean') isGroup = chat.isGroup;
        // also check serialized suffix as fallback
        if (chatId.includes('@g.us')) isGroup = true;

        // Armazena o objeto Chat para reutilizar (sendStateTyping, clearState)
        const clientData = this.clients.get(zapId);
        if (clientData && clientData.chats) {
          clientData.chats.set(chatId, chat);
        }
      } catch (e) {
        console.log('Aviso: nao foi possivel obter chat, usando dados basicos');
      }

      // =============================================
      // DETECCAO E DOWNLOAD DE AUDIO
      // =============================================
      let audioInfo = null;
      const isAudioType = msg.type === 'ptt' || msg.type === 'audio' ||
                          (msg.hasMedia && msg.mimetype && msg.mimetype.startsWith('audio'));

      if (isAudioType && msg.hasMedia) {
        this.logToApp(zapId, 'info', `Audio detectado de ${contactName} (${msg.mimetype}). Baixando...`);
        try {
          const media = await msg.downloadMedia();
          if (media && media.data) {
            audioInfo = {
              data: media.data,        // base64
              mimetype: media.mimetype, // ex: audio/ogg; codecs=opus
              size: media.filesize
            };
            this.logToApp(zapId, 'success', `Audio baixado (${media.filesize} bytes). Sera transcrito pela IA.`);
          } else {
            this.logToApp(zapId, 'warning', 'downloadMedia do audio retornou vazio.');
          }
        } catch (e) {
          console.error(`[AUDIO] Erro ao baixar audio:`, e.message);
          this.logToApp(zapId, 'error', `Erro ao baixar audio: ${e.message}`);
        }
      }

      // Mensagem de texto normal
      let body = msg.body || '';

      // Se for audio sem texto, marcar como pendente de transcricao
      if (audioInfo && (!body || body.trim() === '')) {
        body = '[AUDIO]';
      }

      this.logToApp(zapId, msg.fromMe ? 'outgoing' : 'incoming',
        `${msg.fromMe ? 'Mensagem para si mesmo' : 'Recebido'} de ${contactName} (${msg.type}): "${body.substring(0, 120)}"`);

      const messageData = {
        zapId,
        id: msg.id._serialized,
        body: body,
        from: msg.from,
        to: msg.to,
        timestamp: msg.timestamp,
        fromMe: msg.fromMe,
        audio: audioInfo,
        contact: {
          id: `${contactNumber}@s.whatsapp.net`,
          name: contactName,
          number: contactNumber
        },
        chat: {
          id: chatId,
          name: chatName,
          isGroup
        }
      };

      // =============================================
      // SEMPRE popula conversas (para a UI funcionar)
      // =============================================
      if (!this.conversations.has(zapId)) {
        this.conversations.set(zapId, new Map());
      }

      const zapConversations = this.conversations.get(zapId);

      if (!zapConversations.has(chatId)) {
        zapConversations.set(chatId, {
          contact: messageData.contact,
          messages: [],
          lastMessage: null
        });
      }

      const conversation = zapConversations.get(chatId);
      conversation.messages.push(messageData);
      conversation.lastMessage = messageData;

      // Persist contacts to disk so they survive restarts
      this.persistContacts();

      // Envia para a tela do app (sempre)
      this.sendToRenderer('whatsapp-message', messageData);

      // =============================================
      // DECISAO: Chamar a IA ou nao?
      // =============================================
      if (!this.onMessageCallback) {
        this.logToApp(zapId, 'warning', 'IA ignorada: callback de auto-reply nao configurado.');
        return; // Sem callback configurado
      }

      const clientData = this.clients.get(zapId);
      if (!clientData) {
        this.logToApp(zapId, 'warning', 'IA ignorada: cliente do Zap nao encontrado (sessao encerrada?).');
        return;
      }

      // REGRA 1: Bot precisa estar pronto (ready)
      if (clientData.status !== 'ready') {
        this.logToApp(zapId, 'warning', `IA ignorada: status atual e "${clientData.status}" (aguardando ready).`);
        return;
      }

      // REGRA 1b: Ignora templates vazios / notificações internas sem texto (ex: notification_template com body "")
      // Essas mensagens tem type notification_template e body "" - não devem acionar IA
      if (!body || body.trim() === '' ) {
        const isTemplate = msg.type === 'notification_template' || msg.type === 'e2e_notification' || msg.type === 'call_log' || msg.type === 'gp2';
        if (isTemplate || !audioInfo) {
          // Só responde se tiver texto real ou áudio
          // Log como info para não poluir mas ainda popula conversas
          // (conversas já populadas acima, aqui só decidimos não chamar IA)
          if (body.trim() === '' && !audioInfo) {
            this.logToApp(zapId, 'info', `IA ignorada: mensagem vazia/template (${msg.type}) de ${contactName}.`);
            return;
          }
        }
      }

      // REGRA 2: Mensagem precisa ter sido enviada DEPOIS do pareamento
      // Híbrido: por 90s após ready filtra por timestamp (com grace 60s para skew de relógio PC vs WhatsApp)
      // Após 90s aceita tudo (corrige bug onde PC adiantado 4-6min fazia OI real ser ignorado como histórico)
      const nowWall = Date.now();
      if (clientData.historyBufferUntil && nowWall < clientData.historyBufferUntil) {
        // Dentro da janela de buffer: filtra histórico
        const grace = 60; // 60s de tolerância para skew
        if (clientData.readyAt && msg.timestamp < clientData.readyAt - grace) {
          this.logToApp(zapId, 'warning',
            `IA ignorada: mensagem historica (msg ${msg.timestamp} < readyAt ${clientData.readyAt} -${grace}s, diff ${clientData.readyAt - msg.timestamp}s, buffer ativo).`);
          return;
        }
      } else if (clientData.readyAt && msg.timestamp) {
        // Fora da janela: só ignora se for muito antiga (>10min antes do ready) - protege contra replay muito antigo
        if (msg.timestamp < clientData.readyAt - 600) {
          this.logToApp(zapId, 'warning',
            `IA ignorada: mensagem muito antiga (msg ${msg.timestamp} < readyAt ${clientData.readyAt} -600s, diff ${clientData.readyAt - msg.timestamp}s).`);
          return;
        }
        // Caso contrário, aceita mesmo se timestamp parecer antigo (clock skew)
        if (msg.timestamp < clientData.readyAt) {
          this.logToApp(zapId, 'info', `IA aceita: mensagem com timestamp antigo mas fora do buffer (clock skew, diff ${clientData.readyAt - msg.timestamp}s) - respondendo.`);
        }
      }

      // Passou em todos os filtros - chamar a IA!
      this.logToApp(zapId, 'info', `Filtros aprovados. Enviando mensagem de ${contactName} para a IA...`);
      try {
        await this.onMessageCallback(messageData);
      } catch (e) {
        console.error(`[WHATSAPP] Erro no callback de auto-reply:`, e);
        this.logToApp(zapId, 'error', `Erro no processamento da IA: ${e.message}`);
      }
    } catch (error) {
      console.error(`Erro ao processar mensagem no Zap ${zapId}:`, error);
      this.logToApp(zapId, 'error', `Erro ao processar mensagem recebida: ${error.message}`);
    }
  }

  _normalizeChatId(phoneOrId) {
    if (!phoneOrId) return phoneOrId;
    if (phoneOrId.includes('@')) return phoneOrId;
    const num = String(phoneOrId).replace(/\D/g, '');
    return num ? `${num}@c.us` : phoneOrId;
  }

  async sendMessage(zapId, phone, text) {
    const clientData = this.clients.get(zapId);
    if (!clientData || clientData.status !== 'ready') {
      throw new Error(`Zap ${zapId} nao esta conectado`);
    }

    const msgText = String(text || '');
    const targetId = this._normalizeChatId(phone);
    console.log(`[WHATSAPP] Enviando mensagem para ${targetId}: ${msgText.substring(0, 80)}`);

    try {
      await clientData.client.sendMessage(targetId, msgText);
      this.logToApp(zapId, 'success', `Mensagem enviada para ${targetId}`);
      return { success: true };
    } catch (e) {
      console.error(`[WHATSAPP] Erro ao enviar com client.sendMessage:`, e);
      this.logToApp(zapId, 'warning', `sendMessage direto falhou (${e.message}). Tentando reply...`);
      // Fallback: find most recent message from this chat (by timestamp)
      let lastMsg = null;
      let lastTs = 0;
      for (const [, msg] of clientData.messages) {
        // match by normalized number
        const msgNum = (msg.from || '').split('@')[0];
        const targetNum = targetId.split('@')[0];
        if (msgNum === targetNum && !msg.fromMe && (msg.timestamp || 0) >= lastTs) {
          lastMsg = msg;
          lastTs = msg.timestamp || 0;
        }
      }

      if (lastMsg) {
        try {
          await lastMsg.reply(msgText);
          this.logToApp(zapId, 'success', `Mensagem enviada via reply para ${targetId}`);
          return { success: true };
        } catch (replyError) {
          console.error(`[WHATSAPP] Erro ao enviar com reply:`, replyError);
          this.logToApp(zapId, 'error', `Falha ao enviar mensagem (reply): ${replyError.message}`);
          throw replyError;
        }
      } else {
        this.logToApp(zapId, 'error', `Falha ao enviar mensagem e sem mensagem anterior para reply: ${e.message}`);
        throw e;
      }
    }
  }

  async sendMedia(zapId, phone, mediaData) {
    const clientData = this.clients.get(zapId);
    if (!clientData || clientData.status !== 'ready') {
      throw new Error(`Zap ${zapId} nao esta conectado`);
    }

    const targetId = this._normalizeChatId(phone);
    // strip data URL prefix if present
    let b64 = mediaData.data || '';
    const commaIdx = b64.indexOf(',');
    if (b64.startsWith('data:') && commaIdx !== -1) b64 = b64.slice(commaIdx + 1);

    const media = new MessageMedia(
      mediaData.mimeType || 'image/jpeg',
      b64,
      mediaData.name || 'imagem.jpg'
    );
    console.log(`[WHATSAPP] Enviando midia para ${targetId}: ${mediaData.name}`);

    try {
      await clientData.client.sendMessage(targetId, media);
      this.logToApp(zapId, 'success', `Midia enviada para ${targetId}: ${mediaData.name}`);
      return { success: true };
    } catch (e) {
      console.error(`[WHATSAPP] Erro ao enviar midia:`, e);
      let lastMsg = null;
      let lastTs = 0;
      for (const [, msg] of clientData.messages) {
        const msgNum = (msg.from || '').split('@')[0];
        const targetNum = targetId.split('@')[0];
        if (msgNum === targetNum && !msg.fromMe && (msg.timestamp || 0) >= lastTs) {
          lastMsg = msg; lastTs = msg.timestamp || 0;
        }
      }
      if (lastMsg) {
        await lastMsg.reply(media);
        this.logToApp(zapId, 'success', `Midia enviada via reply para ${targetId}: ${mediaData.name}`);
        return { success: true };
      }
      this.logToApp(zapId, 'error', `Falha ao enviar midia: ${e.message}`);
      throw e;
    }
  }

  getStatus(zapId) {
    const clientData = this.clients.get(zapId);
    if (!clientData) {
      return { status: 'disconnected' };
    }
    return {
      status: clientData.status,
      qrCode: clientData.qrCode,
      method: clientData.method
    };
  }

  getStoredChat(zapId, chatId) {
    const clientData = this.clients.get(zapId);
    if (!clientData || !clientData.chats) return null;
    return clientData.chats.get(chatId) || null;
  }

  async fetchAllContacts(zapId) {
    const clientData = this.clients.get(zapId);
    if (!clientData || clientData.status !== 'ready') return;

    console.log(`[CONTACTS] Buscando todos os contatos do Zap ${zapId}...`);
    try {
      let chats;
      try {
        chats = await clientData.client.getChats();
      } catch (getChatsErr) {
        const m = getChatsErr && getChatsErr.message ? getChatsErr.message : String(getChatsErr);
        const s = getChatsErr && getChatsErr.stack ? getChatsErr.stack.split('\n').slice(0,3).join(' | ') : '';
        console.error('[CONTACTS] getChats falhou:', m, s);
        throw new Error(`getChats: ${m} ${s}`.trim());
      }
      if (!this.conversations.has(zapId)) {
        this.conversations.set(zapId, new Map());
      }
      const zapConvs = this.conversations.get(zapId);
      let added = 0;
      let skipped = 0;

      for (const chat of chats) {
        try {
          if (!chat || !chat.id) { skipped++; continue; }
          const chatId = chat.id._serialized || '';
          // Filtra grupos, newsletters, broadcasts e @lid (lid é hash, não número real - pular por enquanto)
          if (chatId.includes('@g.us') || chatId.includes('@newsletter') || chatId.includes('@broadcast') || chatId.includes('@lid')) {
            skipped++; continue;
          }
          // also skip if isGroup flag true
          if (chat.isGroup) { skipped++; continue; }

        if (!zapConvs.has(chatId)) {
          let contactName = chat.name || '';
          let contactNumber = chat.id.user;
          try {
            if (!contactName && chat.getContact) {
              const c = await chat.getContact();
              contactName = c.name || c.pushname || c.id.user;
              contactNumber = c.id.user || contactNumber;
            }
          } catch (e) { /* ignore */ }

          zapConvs.set(chatId, {
            contact: {
              id: `${contactNumber}@s.whatsapp.net`,
              name: contactName || contactNumber,
              number: contactNumber
            },
            messages: [],
            lastMessage: null
          });
          added++;
        }
        } catch (chatErr) {
          console.warn(`[CONTACTS] skip chat ${chat?.id?._serialized || 'unknown'}:`, chatErr.message);
          skipped++;
          continue;
        }
      }

      console.log(`[CONTACTS] Zap ${zapId}: ${added} novos contatos (total: ${zapConvs.size}, ${skipped} ignorados)`);
      this.logToApp(zapId, 'info', `Contatos carregados: ${added} novos (${zapConvs.size} total, ${skipped} ignorados).`);
      this.persistContacts();
      this.sendToRenderer('whatsapp-contacts-updated', { zapId });
    } catch (e) {
      const em = e && e.message ? e.message : String(e);
      const es = e && e.stack ? e.stack.split('\n').slice(0,4).join(' | ') : '';
      console.error(`[CONTACTS] Erro ao buscar contatos do Zap ${zapId}:`, em, es);
      this.logToApp(zapId, 'warning', `Erro ao buscar contatos: ${em} ${es}`);
    }
  }

  getConversations(zapId) {
    const zapConversations = this.conversations.get(zapId);
    if (!zapConversations) return [];

    const result = [];
    zapConversations.forEach((conversation, chatId) => {
      result.push({
        chatId,
        contact: conversation.contact,
        lastMessage: conversation.lastMessage,
        messageCount: conversation.messages.length
      });
    });

    result.sort((a, b) => {
      if (!a.lastMessage || !b.lastMessage) return 0;
      return b.lastMessage.timestamp - a.lastMessage.timestamp;
    });

    return result;
  }

  getMessages(zapId, chatId) {
    const zapConversations = this.conversations.get(zapId);
    if (!zapConversations || !zapConversations.has(chatId)) {
      return [];
    }
    return zapConversations.get(chatId).messages;
  }

  async disconnectZap(zapId) {
    const clientData = this.clients.get(zapId);
    if (clientData) {
      if (clientData.pairingInterval) { try { clearInterval(clientData.pairingInterval); } catch (_) {} clientData.pairingInterval = null; }
      try {
        await clientData.client.destroy();
      } catch (e) {
        console.error(`Erro ao desconectar Zap ${zapId}:`, e);
      }
      this.clients.delete(zapId);
      this.logToApp(zapId, 'warning', 'Zap desconectado pelo usuario.');
      this.sendToRenderer('whatsapp-status', { zapId, status: 'disconnected' });
    }
  }

  async disconnectAll() {
    for (const [zapId] of this.clients) {
      await this.disconnectZap(zapId);
    }
  }

  sendToRenderer(channel, data) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }

  logToApp(zapId, type, msg) {
    console.log(`[LOG][${type}] Zap ${zapId}: ${msg}`);
    this.sendToRenderer('whatsapp-log', { zapId, type, msg });
  }
}

module.exports = WhatsAppManager;
