const { Client, LocalAuth, MessageMedia } = require('wwebjs-electron');
const path = require('path');
const fs = require('fs');
const { decryptWhatsAppMedia } = require('./media-crypto');
let QRCode = null;
try { QRCode = require('qrcode'); } catch (_) { console.warn('[QR] qrcode npm não encontrado, fallback para serviço remoto'); }

class WhatsAppManager {
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
    this.clients = new Map();
    this.conversations = new Map();
    this.onMessageCallback = null;
    // Zaps em reconexao forcada (pagina morta durante envio)
    this._reconnecting = new Set();
    // LINK_DATA_DIR tem prioridade (servidor Linux); senao Electron userData
    let baseDir;
    if (process.env.LINK_DATA_DIR) {
      baseDir = path.resolve(process.env.LINK_DATA_DIR);
    } else {
      try {
        const { app } = require('electron');
        baseDir = path.join(app.getPath('userData'), 'link-no-whatsapp');
      } catch (_) {
        const os = require('os');
        baseDir = path.join(process.env.APPDATA || process.env.HOME || process.env.USERPROFILE || os.homedir(), 'link-no-whatsapp');
      }
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
            // Limpa residuos gravados por versoes antigas: grupos/canais e
            // chats de servico do WhatsApp (numero "0")
            if (chatId.includes('@g.us') || chatId.includes('@newsletter') || chatId.includes('@broadcast')) return;
            const c = entries[chatId] && entries[chatId].contact;
            if (c && c.number !== undefined && c.number !== null && !/^\d{6,}$/.test(String(c.number))) return;
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

  // Nome do contato para exibir no historico da Mensagem Automatica
  getContactName(zapId, phone) {
    try {
      const map = this.conversations.get(String(zapId));
      if (!map) return '';
      const entry = map.get(`${phone}@c.us`);
      const c = entry && entry.contact;
      return (c && (c.name || c.pushname || c.shortName)) || '';
    } catch (_) {
      return '';
    }
  }

  setOnMessageCallback(callback) {
    this.onMessageCallback = callback;
  }

  async connectZap(zapId, phoneNumber, method = 'qrcode') {
    // Painel local com LINK_CONNECT_READONLY=1: a sessao deste zap vive no
    // servidor 24h. Conectar pelo PC reusa as mesmas credenciais em outro
    // navegador e o WhatsApp invalida a sessao do servidor (logout).
    // Bloqueia o pedido local; configuracoes continuam funcionando.
    try {
      if (String(process.env.LINK_CONNECT_READONLY || '').toLowerCase() === '1') {
        this.logToApp(zapId, 'warning', 'Conexao bloqueada neste app: este zap roda 24h no servidor. Use o app apenas para configurar - nao clique Conectar.');
        return { status: 'readonly', error: 'zap gerenciado pelo servidor (LINK_CONNECT_READONLY)' };
      }
    } catch (_) { /* nao bloqueia o resto */ }
    if (this.clients.has(zapId)) {
      const existing = this.clients.get(zapId);
      const busy = existing && ['connecting', 'waiting_qr', 'waiting_pairing', 'pairing_accepted', 'authenticated', 'ready'].includes(existing.status);
      if (busy) {
        // Pedido explicito de pareamento com conexao parada em QR/codigo
        // antigo: reinicia para gerar codigo novo. Sem isso o guard de corrida
        // recusava o pedido do usuario ("Conexao ja em curso") e o codigo
        // nunca aparecia. Durante 'connecting' (mid-boot) segue o guard.
        const wantPair = method === 'pairing' && !!String(phoneNumber || '').replace(/\D/g, '');
        if (wantPair && (existing.status === 'waiting_qr' || existing.status === 'waiting_pairing')) {
          this.logToApp(zapId, 'info', 'Pedido de pareamento: reiniciando conexao parada para gerar codigo novo...');
          await this.disconnectZap(zapId, 'troca para pareamento');
        } else {
          // Corrida de conectividade (boot: auto-connect + campanha AUTOMSG):
          // nao destruir o browser que ja esta subindo - so aguardar o resultado.
          this.logToApp(zapId, 'info', `Conexao ja em curso (${existing.status}) - aguardando sem reiniciar...`);
          return this._waitReady(zapId, 180000);
        }
      } else {
        this.logToApp(zapId, 'info', 'Ja estava conectado - reconectando (limpando sessao anterior)...');
        await this.disconnectZap(zapId);
      }
    }

    const sessionPath = path.join(this._baseDir, 'sessions', zapId);
    // Sibling fora da sessao: sobrevive ao rmSync e guarda o cache HTTP
    const cacheKeepPath = path.join(this._baseDir, 'sessions', `${zapId}.cache-keep`);
    const profilePath = path.join(sessionPath, `session-${zapId}`, 'Default');

    // For pairing code, always start fresh (no old sessions)
    if (method === 'pairing' && fs.existsSync(sessionPath)) {
      // Guarda o cache HTTP do Chromium (padrao ~28 MB de bundles do WA Web)
      // antes de apagar: a autenticacao (IndexedDB/Local Storage/Session
      // Storage/Cookies) some junto com a pasta, mas os arquivos baixados
      // ficam e sao devolvidos depois - conexao muito mais rapida.
      // Melhor esforco: se falhar, o pareamento segue normalmente.
      try {
        fs.rmSync(cacheKeepPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        if (fs.existsSync(profilePath)) {
          fs.mkdirSync(cacheKeepPath, { recursive: true });
          for (const d of ['Cache', 'Code Cache']) {
            const src = path.join(profilePath, d);
            if (fs.existsSync(src)) fs.renameSync(src, path.join(cacheKeepPath, d));
          }
        }
      } catch (cacheErr) {
        console.warn('[CACHE] Nao foi possivel preservar o cache HTTP:', cacheErr.message);
        try { fs.rmSync(cacheKeepPath, { recursive: true, force: true }); } catch (_) { /* ignore */ }
      }
      try {
        fs.rmSync(sessionPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
        this.logToApp(zapId, 'info', 'Sessao antiga removida (pareamento)');
      } catch (e) {
        console.error('Erro ao remover sessao antiga:', e);
      }
    }

    // Trava de singleton do Chromium de execucoes anteriores (container
    // cancelado no meio): sem limpar, o browser novo recusa abrir o perfil
    // ("profile appears to be in use by another computer").
    const wdProfile = path.dirname(profilePath);
    for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      try { fs.rmSync(path.join(wdProfile, f), { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }

    if (!fs.existsSync(sessionPath)) {
      fs.mkdirSync(sessionPath, { recursive: true });
    }

    // Devolve o cache HTTP preservado (o LocalAuth recria o perfil em session-<id>)
    try {
      if (fs.existsSync(cacheKeepPath)) {
        fs.mkdirSync(profilePath, { recursive: true });
        let restored = 0;
        for (const d of fs.readdirSync(cacheKeepPath)) {
          const dest = path.join(profilePath, d);
          if (fs.existsSync(dest)) {
            fs.rmSync(dest, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
          }
          fs.renameSync(path.join(cacheKeepPath, d), dest);
          restored++;
        }
        fs.rmSync(cacheKeepPath, { recursive: true, force: true });
        if (restored) this.logToApp(zapId, 'info', `Cache HTTP do navegador preservado (${restored} pastas) - conexao mais rapida.`);
      }
    } catch (e) {
      console.warn('[CACHE] Falha ao restaurar cache HTTP:', e.message);
    }

    const cleanPhone = phoneNumber.replace(/\D/g, '');
    this.logToApp(zapId, 'info', `Conectando ao WhatsApp (${cleanPhone}, metodo: ${method})...`);

    const clientOptions = {
      authStrategy: new LocalAuth({
        clientId: zapId,
        dataPath: sessionPath
      }),
      // Redes lentas: o WA Web pode demorar para expor window.Debug apos o
      // evento load. O padrao do wwebjs e 30s e estoura "auth timeout".
      authTimeoutMs: 180000,
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--disable-gpu',
          '--disable-features=IsolateOrigins,site-per-process,Translate,BackForwardCache,MediaRouter,OptimizationHints',
          // Performance: evita trabalhos em background de atrair o carregamento
          '--disable-background-networking',
          '--disable-component-update',
          '--disable-sync',
          '--disable-background-timer-throttling',
          '--disable-renderer-backgrounding',
          '--disable-backgrounding-occluded-windows',
          '--mute-audio'
        ],
        timeout: 120000,
        protocolTimeout: 180000
      },
      // 'local' em vez de 'none': congela a versao do WA Web apos a primeira
      // carga, evitando que atualizacoes do WhatsApp quebrem os scripts injetados
      webVersionCache: { type: 'local', path: path.join(this._baseDir, '.wwebjs_cache') }
    };

    // Se ja existe uma versao congelada no cache, usa ela (resolve intercepta
    // as requisicoes e serve o HTML salvo em vez da versao mais nova)
    try {
      const cacheDir = clientOptions.webVersionCache.path;
      if (fs.existsSync(cacheDir)) {
        const htmls = fs.readdirSync(cacheDir).filter(f => f.endsWith('.html'));
        if (htmls.length) {
          const frozen = htmls[htmls.length - 1].replace(/\.html$/, '');
          clientOptions.webVersion = frozen;
          this.logToApp(zapId, 'info', `Versao do WhatsApp Web congelada no cache: ${frozen}`);
        }
      }
    } catch (e) {
      console.warn('[WWEB] Falha ao ler cache de versao:', e.message);
    }

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
      startupTime: Math.floor(Date.now() / 1000),
      // Maior timestamp (relogio do SERVIDOR) de mensagem vista nesta sessao.
      // Usado como sanidade independente do relogio do PC (que costuma estar
      // adiantado/atrasado minutos e fazia mensagens reais serem descartadas).
      newestMsgTs: 0,
      // Autochat (mensagens para o proprio numero)
      selfNumber: null,
      // Numero pareado (fallback/segundo candidato do autochat)
      selfNumberAlt: null,
      // IDs de mensagens enviadas PELA IA - usados para evitar loop
      aiSentIds: new Set(),
      // Marcadores (corpo + timestamp) de envios em andamento da IA
      pendingAiSends: [],
      // Watchdog de pareamento (polling do socket) - detecta quando o
      // celular aceita o codigo e força a conclusao se o 'ready' nao chegar
      _pairWatchdog: null
    });

    client.on('qr', async (qr) => {
      const data = this.clients.get(zapId);
      // Nunca rebaixa o status depois de autenticado/ready, nem sobrescreve
      // a tela de pareamento (a pagina renova o QR a cada 20s enquanto
      // UNPAIRED e derrubava o codigo de pareamento da UI)
      if (!data || data.client !== client || data.status === 'ready' || data.status === 'authenticated' || data.status === 'waiting_pairing' || data.status === 'pairing_accepted') return;
      this.logToApp(zapId, 'info', 'QR Code gerado. Escaneie com o celular.');
      data.qrCode = qr;
      data.status = 'waiting_qr';
      let dataUrl = null;
      if (QRCode) {
        try { dataUrl = await QRCode.toDataURL(qr, { width: 280, margin: 1 }); } catch (e) { console.warn('[QR] falha ao gerar dataUrl:', e.message); }
      }
      this.saveQrPng(zapId, dataUrl);
      this.sendToRenderer('whatsapp-qr', { zapId, qr, dataUrl });
    });

    client.on('code', (code) => {
      const data = this.clients.get(zapId);
      // O renovador da pagina pode emitir 'code' depois de autenticar -
      // nunca rebaixa o status de uma sessao ja conectada
      if (!data || data.client !== client || data.status === 'ready' || data.status === 'authenticated') return;
      this.registerPairingCode(zapId, code);
      this.logToApp(zapId, 'success', this.pairingLogMessage(code));
      data.pairingCode = code;
      data.status = 'waiting_pairing';
      this.sendToRenderer('whatsapp-pairing-code', { zapId, code });
      // Watchdog: detecta quando o celular aceita o codigo e força a
      // conclusao se o 'ready' nao chegar (pagina reiniciou o contexto)
      this._startPairingWatchdog(zapId, client);
    });

    client.on('loading_screen', (percent, message) => {
      console.log(`[WHATSAPP] Zap ${zapId} carregando: ${percent}% - ${message}`);
    });

    client.on('change_state', (state) => {
      const data = this.clients.get(zapId);
      if (!data || data.client !== client) return;
      // O wwebjs registra o listener da pagina de novo a cada navegacao, entao
      // o MESMO estado chega varias vezes - loga apenas mudancas reais
      if (data.lastState === state) return;
      data.lastState = state;
      console.log(`[WHATSAPP] Zap ${zapId} state: ${state}`);
      this.logToApp(zapId, 'info', `Estado WhatsApp: ${state}`);
      if (state === 'CONNECTED' && data.status !== 'ready' && data.status !== 'authenticated') {
        this.logToApp(zapId, 'info', `WhatsApp conectado (estado CONNECTED) - aguardando autenticacao...`);
      }
    });

    client.on('change_battery', (batteryInfo) => {
      console.log(`[WHATSAPP] Zap ${zapId} bateria: ${batteryInfo.battery}% - plugged: ${batteryInfo.plugged}`);
    });

    // Unified handlers - no double-remove hack needed
    const handleReady = () => {
      const data = this.clients.get(zapId);
      if (!data || data.client !== client) return;
      // 'ready' chega duplicado (listeners de pagina acumulados pelo inject()):
      // processa so o primeiro. Rezerar readyAt/historyBufferUntil faria o
      // filtro de historico (REGRA 2) descartar mensagens reais.
      if (data.readyAt) return;
      data.status = 'ready';
      data.qrCode = null;
      data.pairingCode = null;
      this._stopPairingWatchdog(client); // pareamento resolvido
      // readyAt = PC clock (seconds), readyWall = wall time for history window, historyBufferUntil = 90s after ready
      // We use a hybrid check: for 90s after ready we filter by timestamp, after that we accept all (fixes PC clock skew)
      data.readyAt = Math.floor(Date.now() / 1000);
      data.readyWall = Date.now();
      data.historyBufferUntil = Date.now() + 90 * 1000;
      // Zera a referencia de "mensagem mais nova" da sessao (fica pronta para
      // aceitar a primeira mensagem real imediatamente, sem depender de relogio)
      data.newestMsgTs = 0;
      // Autochat: descobre o numero proprio para reconhecer mensagens enviadas a si mesmo
      try {
        const wid = client.info && client.info.wid;
        const raw = wid ? (typeof wid === 'object' ? (wid._serialized || `${wid.user}@${wid.server || 'c.us'}`) : String(wid)) : '';
        const widNum = raw ? raw.split('@')[0].replace(/:\d+$/, '') : '';
        // O wid ja veio truncado em teste (553299344496 vs 5532999344496):
        // guardamos os dois numeros e o autochat aceita qualquer um (ver _selfNums)
        data.selfNumber = widNum || cleanPhone;
        data.selfNumberAlt = cleanPhone;
        const shown = [data.selfNumber, data.selfNumberAlt]
          .filter((v, i, a) => v && a.indexOf(v) === i).join(' / ');
        if (widNum && cleanPhone && widNum !== cleanPhone) {
          this.logToApp(zapId, 'warning', `Autochat: numero no WhatsApp (${widNum}) difere do numero pareado (${cleanPhone}) - aceitando os dois.`);
        }
        this.logToApp(zapId, 'info', `Autochat ativo no numero ${shown} - mensagens enviadas para o proprio numero serao lidas pela IA.`);
      } catch (e) {
        console.warn('[AUTOCHAT] nao foi possivel obter o numero proprio:', e.message);
        if (!data.selfNumberAlt) data.selfNumberAlt = cleanPhone;
      }
      // Depois de autenticado o renovador de codigo da pagina so reinicia o
      // vinculo e derruba a sessao - desliga ele
      this._clearPagePairingInterval(client);
      this.logToApp(zapId, 'success', `CONECTADO e pronto! Sistema ativo. readyAt=${data.readyAt} (buffer 90s)`);
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
      if (!data || data.client !== client) return;
      // Duplicado pelo mesmo motivo do ready - processa so o primeiro
      if (data.status === 'authenticated' || data.status === 'ready') return;
      data.status = 'authenticated';
      this._clearPagePairingInterval(client);
      this._stopPairingWatchdog(client); // pareamento resolvido
      this.logToApp(zapId, 'success', 'Autenticado (sessao valida)');
      this.sendToRenderer('whatsapp-status', { zapId, status: 'authenticated' });
    };
    const handleAuthFailure = (msg) => {
      console.error(`Falha na autenticacao do Zap ${zapId}:`, msg);
      const data = this.clients.get(zapId);
      if (!data || data.client !== client) return;
      data.status = 'auth_failure';
      this._stopPairingWatchdog(client); // pareamento falhou - para o polling
      let friendlyMsg = msg || 'Autenticacao negada';
      if (msg && (msg.includes('query_link') || msg.includes('not allowed') || msg.includes('linked'))) {
        friendlyMsg = 'Nao foi possivel vincular. Verifique se o numero esta correto e se o WhatsApp esta aberto no celular.';
      }
      this.logToApp(zapId, 'error', `Falha na autenticacao: ${friendlyMsg}`);
      this.sendToRenderer('whatsapp-status', { zapId, status: 'auth_failure', error: friendlyMsg });
    };
    const handleDisconnected = (reason) => {
      const data = this.clients.get(zapId);
      if (!data || data.client !== client) return;
      // LOGOUT/queda chega 2x (varios frames com post_logout=1/lastLoggedOut)
      if (data.status === 'disconnected') return;
      data.status = 'disconnected';
      this._stopPairingWatchdog(client); // sessao caiu - para o polling
      // Janela de historico invalida - o proximo ready recria (readyAt null)
      data.readyAt = null;
      data.readyWall = null;
      data.historyBufferUntil = null;
      data.newestMsgTs = 0;
      this.logToApp(zapId, 'warning', `Zap DESCONECTADO (${reason}). Mensagens nao serao processadas ate reconectar.`);
      if (reason === 'LOGOUT') {
        this.logToApp(zapId, 'error', 'Sessao expirada no WhatsApp (LOGOUT). Reconecte pelo painel para gerar um novo pareamento.');
        // O handler do wwebjs continua DEPOIS do emit (authStrategy.logout +
        // inject). Fechar o browser dentro do evento faz o inject rodar numa
        // pagina morta -> "detached Frame" -> unhandled rejection -> crash.
        // Espera ele terminar, desliga os listeners da pagina, ai fecha e limpa.
        (async () => {
          await new Promise(r => setTimeout(r, 2000));
          const stillSameClient = () => {
            const d = this.clients.get(zapId);
            return d && d.client === client;
          };
          // Usuario ja reconectou/desconectou: outro fluxo ja cuidou disto
          if (!stillSameClient()) return;
          this._detachPageListeners(client);
          try { client.removeAllListeners(); } catch (_) { /* ignore */ }
          try { await client.destroy(); } catch (_) { /* ja fechado */ }
          for (let i = 0; i < 6; i++) {
            await new Promise(r => setTimeout(r, 1500));
            // Se o usuario ja reconectou, para fora - nao apaga a sessao nova
            if (!stillSameClient()) return;
            try {
              fs.rmSync(path.join(this._baseDir, 'sessions', zapId), { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
              this.logToApp(zapId, 'info', 'Sessao expirada removida do disco.');
              break;
            } catch (_) { /* EBUSY - tenta de novo */ }
          }
        })();
      }
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
      if (!data || data.client !== client) return;

      // GRUPOS/TRANSMISSAO/CANAIS: corte aqui, antes de qualquer coisa.
      // Nao vai para a UI, nao baixa midia e nunca passa pela IA.
      if (this._isGroupJid(msg.from) || this._isGroupJid(msg.to)) {
        console.log(`[GRUPO] mensagem de grupo descartada (zap ${zapId}) - nao vai para a IA`);
        return;
      }

      // Armazena o objeto original para poder usar reply() depois
      const msgKey = this._ensureMsgKey(msg);
      if (msgKey) {
        data.messages.set(msgKey, msg);
        if (data.messages.size > 100) {
          const keys = Array.from(data.messages.keys());
          for (let i = 0; i < keys.length - 100; i++) {
            data.messages.delete(keys[i]);
          }
        }
      }

      // Processa a mensagem (popula conversas para a UI + chama IA se for nova)
      await this.handleMessage(zapId, msg);
    });

    // ============================================================
    // EVENTO 'message_create': dispara para TODAS as mensagens,
    // inclusive as que EU envio. Usado para o AUTOCHAT (mensagens
    // enviadas para o proprio numero) com protecao anti-loop.
    // ============================================================
    client.on('message_create', async (msg) => {
      try {
        if (!msg.fromMe) return; // mensagens recebidas vêm pelo evento 'message'
        const data = this.clients.get(zapId);
        if (!data || data.client !== client) return;

        // DONO RESPONDEU MANUALMENTE (celular/outro aparelho): registra o
        // horario para a IA NAO responder por cima. 'web' = mesma sessao do
        // app (envio da propria IA/UI) - nao conta como resposta do dono.
        if (msg.deviceType && msg.deviceType !== 'web') {
          const ownerJid = msg.to || msg.from || '';
          if (!this._isGroupJid(ownerJid)) {
            this.markOwnerReply(zapId, ownerJid, msg.timestamp);
            this.logToApp(zapId, 'info', `Dono respondeu manualmente (${msg.deviceType}) em ${ownerJid} - IA nao vai responder por cima.`);
          }
        }

        // Chat da mensagem: para mensagens enviadas por mim, o chat e msg.to
        const chatJid = msg.to || msg.from || '';
        const chatNum = this._normNum(chatJid);

        // GRUPOS: eu escrevendo num grupo tambem e descartado (a IA so
        // conversa no autochat, chat 1:1 do proprio numero)
        if (this._isGroupJid(chatJid) || this._isGroupJid(msg.from)) {
          console.log(`[GRUPO] mensagem propria em grupo descartada (zap ${zapId}) - nao vai para a IA`);
          return;
        }

        // Somente o chat do proprio numero (autochat). Outros chats saem aqui.
        const selfNums = this._selfNums(data);
        const fromNum = this._normNum(msg.from || '');
        let isSelfChat = selfNums.length ? selfNums.includes(chatNum) : (fromNum && chatNum === fromNum);
        if (!isSelfChat && chatJid.includes('@lid')) {
          // Chat consigo mesmo vem como @lid (hash, nao telefone). Resolve o
          // contato do chat e compara o numero de verdade.
          try {
            const chatObj = await msg.getChat();
            const contact = await chatObj.getContact();
            const wid = contact && contact.wid;
            const cand = this._normNum((contact && contact.number) || (wid && (wid._serialized || wid)) || '');
            if (cand && selfNums.includes(cand)) isSelfChat = true;
          } catch (_) { /* contato nao resolvido - nao e autochat */ }
        }
        if (!isSelfChat) {
          // O dono respondeu manualmente (celular/outro aparelho) num chat comum:
          // registra no historico da UI. Envios 'web' (nosso app) ja sao
          // registrados no proprio sendMessage/sendMedia.
          if (msg.deviceType && msg.deviceType !== 'web') {
            try {
              const chatObj = await msg.getChat();
              const cid = chatObj && chatObj.id && (chatObj.id._serialized || chatObj.id);
              let cname = '';
              try { cname = chatObj.formattedTitle || chatObj.name || ''; } catch (_) {}
              this._recordOutgoing(zapId, cid || chatJid, msg.body || (msg.hasMedia ? '[mídia]' : ''), 'owner', msg, {
                chatId: cid || undefined,
                name: cname,
                hasMedia: !!msg.hasMedia,
                timestamp: msg.timestamp
              });
            } catch (e) {
              console.warn('[CONV] falha ao registrar mensagem manual do dono:', e.message);
            }
          }
          return;
        }

        const msgId = this._ensureMsgKey(msg);
        const bodyTxt = msg.body || '';
        // deviceType 'web' = enviado pela mesma sessao web (a IA envia por aqui).
        // Mensagens vindas do celular do usuario sao 'android'/'ios' - nunca sao da IA.
        const isWebMsg = msg.deviceType === 'web';

        // Anti-loop 1: id ja identificado como enviado pela IA (definitivo)
        if (msgId && data.aiSentIds && data.aiSentIds.has(msgId)) {
          this.logToApp(zapId, 'info', `Autochat: resposta da IA ignorada (anti-loop id): "${bodyTxt.substring(0, 60)}"`);
          return;
        }

        // Anti-loop 2: envio da IA ainda em curso (o message_create do envio proprio
        // chega antes do sendMessage resolver, entao o id ainda nao esta em aiSentIds).
        // Nessa janela, mensagem 'web' = nossa sessao = resposta da IA.
        // Apos resolver, o id cai em aiSentIds (anti-loop 1) e tambem casamos por corpo.
        const aiSending = !!data.aiSending;
        if (aiSending && isWebMsg && msgId) {
          if (data.aiSentIds) data.aiSentIds.add(msgId); // fixa para nao depender da janela
          this.logToApp(zapId, 'info', `Autochat: resposta da IA ignorada (anti-loop janela): "${bodyTxt.substring(0, 60)}"`);
          return;
        }
        if (isWebMsg && data.pendingAiSends && data.pendingAiSends.length) {
          const idx = data.pendingAiSends.findIndex(p => {
            if ((Date.now() - p.t) >= 20000) return false;
            if (p.midia) return msg.hasMedia;
            return p.body === bodyTxt;
          });
          if (idx !== -1) {
            data.pendingAiSends.splice(idx, 1);
            this.logToApp(zapId, 'info', `Autochat: resposta da IA ignorada (anti-loop marca): "${bodyTxt.substring(0, 60)}"`);
            return;
          }
        }

        data.messages.set(msgId, msg);
        if (data.messages.size > 100) {
          const keys = Array.from(data.messages.keys());
          for (let i = 0; i < keys.length - 100; i++) data.messages.delete(keys[i]);
        }

        this.logToApp(zapId, 'incoming',
          `Autochat [${chatNum}]: mensagem sua para o proprio numero (${msg.type}): "${bodyTxt.substring(0, 120)}"`);

        await this.handleMessage(zapId, msg);
      } catch (e) {
        console.error('[AUTOCHAT] Erro ao processar message_create:', e);
        this.logToApp(zapId, 'error', `Autochat: erro ao processar mensagem: ${e.message}`);
      }
    });

    try {
      this.sendToRenderer('whatsapp-status', { zapId, status: 'connecting' });
      const tInit = Date.now();
      // Descobre quando o browser sobe (pupPage aparece antes do goto) para
      // separar "launch do Chromium" de "carga da pagina" no log
      let tBrowser = null;
      const pollBrowser = setInterval(() => {
        if (tBrowser === null && client.pupPage) tBrowser = Date.now();
      }, 50);
      try {
        await client.initialize();
      } finally {
        clearInterval(pollBrowser);
      }
      await this._patchMediaMsgAttrs(client);
      const sec = (a, b) => ((b - a) / 1000).toFixed(1);
      if (tBrowser) {
        this.logToApp(zapId, 'info', `Navegador e pagina prontos em ${sec(tInit, Date.now())}s (chromium ${sec(tInit, tBrowser)}s + pagina ${sec(tBrowser, Date.now())}s).`);
      } else {
        this.logToApp(zapId, 'info', `Navegador e pagina do WhatsApp prontos em ${sec(tInit, Date.now())}s.`);
      }

      // Pareamento robusto: gerar codigo explicitamente apos initialize
      if (isPairing) {
        try {
          this.logToApp(zapId, 'info', `Solicitando codigo de pareamento para ${cleanPhone}...`);
          // Pequeno delay para garantir que a pagina carregou
          await new Promise(r => setTimeout(r, 100));
          let code;
          try {
            code = await this._withTimeout(client.requestPairingCode(cleanPhone), 20000, 'requestPairingCode');
          } catch (firstErr) {
            // Fallback: tentar com intervalo explicito
            this.logToApp(zapId, 'warning', `Primeira tentativa falhou (${firstErr.message}), tentando novamente...`);
            await new Promise(r => setTimeout(r, 300));
            code = await this._withTimeout(client.requestPairingCode(cleanPhone, true), 20000, 'requestPairingCode');
          }
          const data = this.clients.get(zapId);
          // O evento 'code' (disparado pela propria pagina) ja registrou e
          // enviou o codigo para a UI antes do evaluate resolver - so completamos
          // com o tempo de conexao para diagnóstico
          const alreadySent = data && data.pairingCode === code;
          if (data) {
            data.pairingCode = code;
            data.status = 'waiting_pairing';
          }
          this.registerPairingCode(zapId, code);
          if (alreadySent) {
            this.logToApp(zapId, 'info', `Codigo pronto em ${((Date.now() - tInit) / 1000).toFixed(1)}s desde o inicio.`);
          } else {
            this.logToApp(zapId, 'success', this.pairingLogMessage(code, `(${((Date.now() - tInit) / 1000).toFixed(1)}s desde o inicio)`));
            this.sendToRenderer('whatsapp-pairing-code', { zapId, code });
          }
          // Watchdog (idempotente): garante deteccao mesmo se o evento 'code'
          // da pagina nao disparar neste caminho manual
          this._startPairingWatchdog(zapId, client);
          // Sem regeneracao daqui: o intervalo proprio da pagina (3 min, padrao
          // do wwebjs) renova o codigo enquanto nao pareado e dispara o evento
          // 'code' para a UI. Regenerar manualmente reiniciava o vinculo por
          // cima do usuario digitando, travava 180s no protocolTimeout e
          // acabava derrubando a sessao (LOGOUT).
        } catch (e) {
          this.logToApp(zapId, 'error', `Falha ao solicitar codigo de pareamento: ${e.message}`);
          // Nao joga erro fatal - deixa usuario tentar novamente ou usar QR
          this.sendToRenderer('whatsapp-status', { zapId, status: 'pairing_error', error: e.message });
        }
      }

      return { status: 'initializing', method };
    } catch (error) {
      console.error(`Erro ao inicializar Zap ${zapId}:`, error);
      this.logToApp(zapId, 'error', `Erro ao iniciar WhatsApp: ${error.message}`);
      this.clients.delete(zapId);
      return { status: 'error', error: error.message };
    }
  }

  async handleMessage(zapId, msg) {
    try {
      // Garante a chave da mensagem antes de qualquer uso (cache/IA/audio)
      this._ensureMsgKey(msg);
      // Normalize chat/contact detection: handle @g.us (grupo), @lid (novo ID), @c.us/@s.whatsapp.net
      // Para mensagens enviadas por mim (fromMe), o chat de destino e msg.to (autochat usa isso)
      const rawFrom = (msg.fromMe ? (msg.to || msg.from || '') : (msg.from || ''));
      let contactName = 'Desconhecido';
      let contactNumber = rawFrom.split('@')[0].replace(/:.*/, '');
      // fallback numeric extraction for @lid where id.user is lid hash
      let chatId = rawFrom;
      let chatName = contactNumber;
      let isGroup = rawFrom.includes('@g.us') || rawFrom.includes('@broadcast') || rawFrom.includes('@newsletter');

      // Segunda barreira: JID ja indica grupo (checagem sem await, antes de
      // getContact/getChat e antes de baixar qualquer midia)
      if (isGroup || this._isGroupJid(rawFrom)) {
        this._dropGroupMsg(zapId, msg);
        return;
      }

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

        // Barreira autoritativa: chat.isGroup confirmado. Corta AQUI, antes de
        // cachear o chat, antes de baixar audio e antes de mandar para a IA.
        if (isGroup) {
          const dg = this.clients.get(zapId);
          if (dg && dg.chats) dg.chats.delete(chatId);
          this._dropGroupMsg(zapId, msg);
          console.log(`[GRUPO] mensagem de grupo descartada (zap ${zapId}) - nao vai para a IA`);
          return;
        }

        // Armazena o objeto Chat para reutilizar (sendStateTyping, clearState)
        const clientData = this.clients.get(zapId);
        if (clientData && clientData.chats) {
          clientData.chats.set(chatId, chat);
        }
      } catch (e) {
        console.log('Aviso: nao foi possivel obter chat, usando dados basicos');
      }

      // Prefere um nome humano (agenda/pushname) ao numero quando disponivel
      if (this._isNumericName(contactName) && !this._isNumericName(chatName)) {
        contactName = chatName;
      }

      // Autochat: este chat e do proprio numero? (aceita wid e numero pareado)
      const cd = this.clients.get(zapId);
      const isSelfChat = this._selfNums(cd).includes(this._normNum(chatId));
      if (isSelfChat && !contactName.trim()) contactName = 'Eu (autochat)';

      // =============================================
      // DETECCAO E DOWNLOAD DE AUDIO
      // =============================================
      let audioInfo = null;
      let audioFailed = false;
      // msg.mimetype nao existe na classe Message - mimetype real esta em msg._data.mimetype
      const rawMime = (msg._data && msg._data.mimetype) || '';
      const isAudioType = msg.type === 'ptt' || msg.type === 'audio' ||
                          (msg.hasMedia && rawMime && rawMime.startsWith('audio'));

      if (isAudioType) {
        if (!msg.hasMedia) {
          audioFailed = true;
          this.logToApp(zapId, 'warning', `Audio de ${contactName} sem midia acessivel (hasMedia=false).`);
        } else {
          this.logToApp(zapId, 'info', `Audio detectado de ${contactName} (${rawMime || 'ptt'}). Baixando...`);
          audioInfo = await this._downloadAudio(zapId, msg, rawMime);
          if (!audioInfo) audioFailed = true;
        }
      }

      // Mensagem de texto normal
      let body = msg.body || '';

      // Se for audio sem texto, marcar como pendente de transcricao.
      // Tambem quando o download FALHOU (audioFailed) - main.js responde
      // pedindo para o usuario mandar como texto em vez de ignorar em silencio.
      if (isAudioType && (!body || body.trim() === '')) {
        body = '[AUDIO]';
      }

      this.logToApp(zapId, msg.fromMe ? 'outgoing' : 'incoming',
        `${msg.fromMe ? 'Mensagem para si mesmo' : 'Recebido'} de ${contactName} (${msg.type}): "${body.substring(0, 120)}"`);

      const messageData = {
        zapId,
        id: this._ensureMsgKey(msg),
        body: body,
        from: msg.fromMe ? (msg.to || msg.from) : msg.from,
        to: msg.to,
        timestamp: msg.timestamp,
        fromMe: msg.fromMe,
        selfChat: isSelfChat,
        audio: audioInfo,
        audioFailed: audioFailed,
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
      // Atualiza o nome do contato quando conseguimos um nome humano melhor
      if (conversation.contact) {
        if (this._isNumericName(conversation.contact.name) && !this._isNumericName(contactName)) {
          conversation.contact.name = contactName;
        }
        if (!conversation.contact.number && messageData.contact.number) {
          conversation.contact.number = messageData.contact.number;
        }
      }
      conversation.messages.push(messageData);
      conversation.lastMessage = messageData;
      // Mantem o historico da UI enxuto
      if (conversation.messages.length > 200) {
        conversation.messages = conversation.messages.slice(-200);
      }

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

      // REGRA 1: Bot precisa estar pronto. Aceita 'ready' (sync concluido) e
      // tambem 'authenticated' (sessao ja autenticada, socket aberto) - assim
      // mensagens que chegam logo apos o pareamento NAO sao descartadas.
      if (clientData.status !== 'ready' && clientData.status !== 'authenticated') {
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

      // REGRA 2: o wwebjs SO emite o evento 'message' para mensagens novas
      // (no listener injetado: `if (!msg.isNewMsg) return`) - historico/backlog
      // NUNCA chega aqui. Por isso nao ha filtro por relogio do PC (que estava
      // descartando mensagens reais por skew de minutos). Mantemos apenas uma
      // sanidade independente de relogio: ignora se a mensagem for bem mais
      // antiga (3 min) que a mensagem mais nova ja vista nesta sessao.
      const msgTs = Number(msg.timestamp) || 0;
      if (msgTs) {
        const newest = Number(clientData.newestMsgTs) || 0;
        if (newest && msgTs < newest - 180) {
          this.logToApp(zapId, 'warning',
            `IA ignorada: mensagem antiga (msg ${msgTs} < mais nova vista ${newest} -180s).`);
          return;
        }
        if (msgTs > newest) clientData.newestMsgTs = msgTs;
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

  // Extrai apenas os digitos de um JID/numero (ex: "5532999344496:12@c.us" -> "5532999344496")
  _normNum(jidOrNum) {
    if (!jidOrNum) return '';
    return String(jidOrNum).split('@')[0].replace(/:/g, '').replace(/\D/g, '');
  }

  // true quando o "nome" e so o numero (sem um nome humano de verdade)
  _isNumericName(value) {
    const s = String(value || '').trim();
    if (!s) return true;
    return /^[\d\s()+\-]*$/.test(s);
  }

  // JID que NAO e um contato normal (grupo, canal/newsletter, lista de
  // transmissao). Nada disso pode chegar na IA - filtrado no evento, antes
  // de getContact/getChat, antes de baixar midia e antes de ir pra UI.
  // @lid e @c.us/@s.whatsapp.net sao contatos normais e NAO entram aqui.
  _isGroupJid(jid) {
    const s = String(jid || '');
    return s.includes('@g.us') || s.includes('@newsletter') || s.includes('@broadcast');
  }

  // Remove a mensagem do cache interno quando ela e descartada por ser de
  // grupo (o cache serve so para reply() de conversas 1:1)
  _dropGroupMsg(zapId, msg) {
    try {
      const d = this.clients.get(zapId);
      const k = this._ensureMsgKey(msg);
      if (d && d.messages && k) d.messages.delete(k);
    } catch (_) { /* ignore */ }
  }

  // Chave da mensagem no formato do WhatsApp (fromMe_remote_id).
  // O MsgKey da pagina perde o getter `_serialized` no caminho pagina -> Node,
  // entao msg.id._serialized chega undefined e quebrava: cache de mensagens,
  // id salvo na conversa, anti-loop da IA e o Msg.get() do download de audio
  // ("No key or key range specified"). Reconstruimos a partir das partes que
  // sobrevivem (id, fromMe, remote - todas primitivas).
  _ensureMsgKey(msg) {
    try {
      if (!msg || msg.id === undefined || msg.id === null) return '';
      const id = msg.id;
      if (typeof id === 'string') return id;
      if (id._serialized) return id._serialized;
      let remote = id.remote;
      if (remote && typeof remote === 'object') remote = remote._serialized || String(remote);
      if (id.id && remote && id.fromMe !== undefined && id.fromMe !== null) {
        const built = `${id.fromMe}_${remote}_${id.id}`;
        try { id._serialized = built; } catch (_) { /* id pode ser somente leitura */ }
        return built;
      }
      return '';
    } catch (_) { return ''; }
  }

  async _patchMediaMsgAttrs(client) {
    const page = client && client.pupPage;
    if (!page) return;
    try {
      await page.evaluate(() => {
        const act = window.require('WAWebSendMsgChatAction');
        if (act.__stripModelInternals) return;
        const orig = act.addAndSendMsgToChat;
        const skip = new Set([
          'revisionNumber', '__fired', '__changes', '__initialized',
          'parent', 'collection', '_uiObservers', 'mirror'
        ]);
        act.addAndSendMsgToChat = function (chat, message) {
          if (message && typeof message === 'object') {
            for (const k of Object.keys(message)) {
              if (k.lastIndexOf('__x_', 0) === 0 || skip.has(k)) delete message[k];
            }
          }
          return orig.call(this, chat, message);
        };
        act.__stripModelInternals = true;
      });
    } catch (e) {
      console.error('[WHATSAPP] Falha ao aplicar patch de envio de midia:', e);
    }
  }

  // Numeros considerados "o proprio numero" no autochat. O wid ja veio truncado
  // em teste (553299344496) enquanto o pareado era 5532999344496 - guardamos os
  // dois e aceitamos qualquer um.
  _selfNums(clientData) {
    if (!clientData) return [];
    const out = [];
    for (const n of [clientData.selfNumber, clientData.selfNumberAlt]) {
      const v = this._normNum(n);
      if (v && out.indexOf(v) === -1) out.push(v);
    }
    return out;
  }

  // Desliga os listeners que o wwebjs registra na pagina do puppeteer
  // (framenavigated -> inject, request/response do webVersionCache). Se o
  // browser for fechado com eles ativos, um evaluate na pagina morta vira
  // "Attempted to use detached Frame" e derruba o processo inteiro.
  _detachPageListeners(client) {
    const page = client && client.pupPage;
    if (!page || typeof page.removeAllListeners !== 'function') return;
    for (const ev of ['framenavigated', 'request', 'response', 'load']) {
      try { page.removeAllListeners(ev); } catch (_) { /* ignore */ }
    }
  }

  // Desliga o window.codeInterval (renovador de codigo de pareamento da propria
  // pagina). Depois de autenticado ele so reinicia o vinculo e causa LOGOUT.
  _clearPagePairingInterval(client) {
    try {
      const page = client && client.pupPage;
      if (!page) return;
      page.evaluate(() => {
        if (window.codeInterval) {
          clearInterval(window.codeInterval);
          window.codeInterval = undefined;
        }
      }).catch(() => { /* pagina ja fechada */ });
    } catch (_) { /* ignore */ }
  }

  // ============================================================
  // WATCHDOG DE PAREAMENTO
  // O wwebjs so emite 'authenticated'/'ready' quando o evento
  // change:hasSynced da pagina dispara. Se a pagina navega/recria o
  // contexto durante o handshake (comum no pareamento), o listener morre
  // e o app fica travado em "waiting_pairing" para SEMPRE, mesmo com o
  // celular ja mostrando "conectado". Este watchdog faz polling do
  // estado do socket: ao ver que o celular aceitou o codigo (estado
  // sai de UNPAIRED), avisa a UI na hora e, se o 'ready' nao chegar em
  // alguns segundos, força a conclusao re-avaliando a pagina.
  // ============================================================
  _startPairingWatchdog(zapId, client) {
    const data = this.clients.get(zapId);
    if (!data || data.client !== client) return;
    this._stopPairingWatchdog(client); // nunca dois watchdogs no mesmo client

    let lastState = null;
    let acceptedAt = null;
    let nudged = false;
    let stopped = false;

    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (data._pairWatchdog) {
        clearInterval(data._pairWatchdog);
        data._pairWatchdog = null;
      }
    };

    data._pairWatchdog = setInterval(async () => {
      if (stopped) return;
      const d = this.clients.get(zapId);
      if (!d || d.client !== client) { stop(); return; }
      // Para assim que resolver (ready) ou falhar definitivamente
      if (d.status === 'ready' || d.status === 'disconnected' || d.status === 'auth_failure') { stop(); return; }

      let state = null;
      try {
        state = await this._withTimeout(client.getState(), 4000, 'getState(pareamento)');
      } catch (_) { return; } // pagina ocupada/navegando - tenta no proximo tick

      if (state && state !== lastState) {
        lastState = state;
        console.log(`[PAIR-WD] Zap ${zapId} estado do socket: ${state}`);
      }

      const unpaired = state === 'UNPAIRED' || state === 'UNPAIRED_IDLE';
      if (unpaired || !state) return; // ainda esperando o usuario digitar o codigo

      // Celular aceitou o codigo (estado saiu de UNPAIRED)
      if (!acceptedAt) {
        acceptedAt = Date.now();
        d.status = 'pairing_accepted';
        this.logToApp(zapId, 'success', `Codigo aceito pelo celular (estado: ${state}) - sincronizando conversas...`);
        this.sendToRenderer('whatsapp-status', { zapId, status: 'pairing_accepted' });
      }

      // Conectou mas o 'ready' nao chegou apos a gradacao: força a conclusao.
      // So tenta UMA vez para nao ficar re-avaliando a pagina em loop.
      const connectedLike = state === 'CONNECTED' || state === 'SYNCING' || state === 'OPENING';
      if (!nudged && acceptedAt && connectedLike && (Date.now() - acceptedAt) >= 6000) {
        nudged = true;
        await this._nudgePairingFinalize(zapId, client);
      }
    }, 2000);
  }

  _stopPairingWatchdog(client) {
    try {
      // Percorre o mapa para achar o registro deste client
      for (const [, d] of this.clients.entries()) {
        if (d.client === client && d._pairWatchdog) {
          clearInterval(d._pairWatchdog);
          d._pairWatchdog = null;
        }
      }
    } catch (_) { /* ignore */ }
  }

  // Forca a emissao de authenticated/ready quando o socket ja conectou mas o
  // change:hasSynced (listener da pagina) nao disparou. Reexecuta o handler
  // exposto onAppStateHasSyncedEvent dentro da pagina - e o mesmo caminho
  // oficial do wwebjs, entao dispara authenticated + ready normalmente.
  async _nudgePairingFinalize(zapId, client) {
    const d = this.clients.get(zapId);
    if (!d || d.client !== client || d.status === 'ready') return;
    try {
      const page = client.pupPage;
      if (!page || (typeof page.isClosed === 'function' && page.isClosed())) {
        this.logToApp(zapId, 'warning', 'Pareamento travado e pagina ja fechada - gere um novo codigo.');
        return;
      }
      this.logToApp(zapId, 'info', 'Conexao detectada mas pronto nao chegou - forcando conclusao do pareamento...');
      const res = await this._withTimeout(page.evaluate(async () => {
        // Pagina navegou/recriou o contexto: o handler oficial nao existe mais
        if (typeof window.onAppStateHasSyncedEvent !== 'function') {
          return typeof window.WWebJS !== 'undefined' ? 'injected-no-handler' : 'missing';
        }
        try { await window.onAppStateHasSyncedEvent(); } catch (_) { /* ja autenticado */ }
        return 'ok';
      }), 8000, 'forcar-pareamento');

      if (res === 'ok') {
        this.logToApp(zapId, 'success', 'Pareamento concluido pelo watchdog (handler oficial reexecutado).');
      } else if (res === 'injected-no-handler') {
        // WWebJS injetado mas handler sumiu: reaplica os listeners e o
        // fluxo de sync do proprio client, que reemite authenticated/ready.
        this.logToApp(zapId, 'warning', 'Contexto da pagina recriado durante o pareamento - reaplicando listeners...');
        try {
          await this._withTimeout(client.attachEventListeners(), 10000, 'reattach(pareamento)');
          await this._withTimeout(page.evaluate(() => {
            window.require('WAWebSocketModel').Socket.on('change:hasSynced', () => {
              if (typeof window.onAppStateHasSyncedEvent === 'function') window.onAppStateHasSyncedEvent();
            });
          }), 8000, 'relisten(pareamento)');
          this.logToApp(zapId, 'info', 'Listeners reaplicados - se o socket sincronizar, o ready dispara sozinho.');
        } catch (e) {
          this.logToApp(zapId, 'warning', `Nao foi possivel reaplicar listeners: ${e.message}`);
        }
      } else {
        this.logToApp(zapId, 'error', 'Pareamento nao concluiu (contexto da pagina indisponivel). Gere um novo codigo e tente novamente.');
        this.sendToRenderer('whatsapp-status', { zapId, status: 'pairing_error', error: 'Pagina do WhatsApp reiniciou durante o pareamento. Gere um novo codigo.' });
      }
    } catch (e) {
      this.logToApp(zapId, 'warning', `Falha ao forcar conclusao do pareamento: ${e.message}`);
    }
  }

  // Baixa a midia de um audio sem deixar o evaluate preso no protocolTimeout.
  // A pagina so devolve os metadados (chave, mediaKey, directPath); os bytes
  // criptografados sao buscados no host e descriptografados com a mediaKey.
  async _fetchMediaBuffer(urls, timeoutMs = 15000) {
    const errors = [];
    if (!urls.length) return { buffer: null, errors: ['nenhuma URL de midia'] };
    if (typeof fetch !== 'function') return { buffer: null, errors: ['fetch indisponivel no host'] };

    for (const url of urls) {
      let timer = null;
      try {
        const ac = new AbortController();
        timer = setTimeout(() => ac.abort(), timeoutMs);
        const resp = await fetch(url, {
          signal: ac.signal,
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = Buffer.from(await resp.arrayBuffer());
        if (!buf.length) throw new Error('resposta vazia');
        return { buffer: buf, url, errors };
      } catch (e) {
        const msg = e && e.name === 'AbortError'
          ? `timeout ${timeoutMs}ms`
          : ((e && (e.message || e.name)) || String(e));
        errors.push(`${url}: ${msg}`);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    return { buffer: null, errors };
  }

  // Baixa a midia de um audio. O downloadMedia do wwebjs chama evaluate e pode
  // ficar esperando um mediaStage FETCHING que nunca resolve. Por isso a busca
  // na pagina nao faz download nenhum: so revela os metadados. Depois o host
  // baixa a CDN e descriptografa; se isso falhar, tenta o DownloadManager da
  // pagina com AbortController e timeout curto.
  async _downloadAudio(zapId, msg, rawMime) {
    const clientData = this.clients.get(zapId);
    const page = clientData && clientData.client ? clientData.client.pupPage : null;
    if (!page) return null;

    // Somente primitivos cruzam para a pagina (objeto cru perde getter).
    const idObj = (msg.id && typeof msg.id === 'object') ? msg.id : {};
    const chatIdFull = msg.fromMe ? (msg.to || msg.from || '') : (msg.from || '');
    let remote = idObj.remote;
    if (remote && typeof remote === 'object') remote = remote._serialized || String(remote);
    const keyParts = {
      serialized: this._ensureMsgKey(msg) || '',
      idPart: typeof idObj.id === 'string' ? idObj.id : '',
      fromMe: idObj.fromMe,
      remote: remote,
      chatId: String(chatIdFull || ''),
      knownMime: rawMime || '',
    };

    let meta = null;
    try {
      meta = await page.evaluate(async (p) => {
        let realKey = '';
        const fail = (step, e, stage) => ({
          ok: false,
          step,
          error: String((e && (e.message || e.name)) || e || 'erro desconhecido'),
          detail: String((e && e.stack) || '').split('\n').slice(0, 3).join(' | '),
          stage: String(stage || ''),
          key: realKey,
        });
        const withTimeout = (promise, ms, label) => new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
          Promise.resolve(promise).then(
            (value) => { clearTimeout(timer); resolve(value); },
            (e) => { clearTimeout(timer); reject(e); }
          );
        });
        const toB64 = (value) => {
          if (!value) return '';
          if (typeof value === 'string') return value;
          let bytes;
          if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
          else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
          else return '';
          let out = '';
          for (let i = 0; i < bytes.length; i += 0x8000) {
            out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          }
          return btoa(out);
        };
        const safe = (fn) => { try { return fn(); } catch (_) { return ''; } };
        try {
          const C = window.require('WAWebCollections');

          // ---- BUSCA DA MENSAGEM (nunca chamar Msg.get sem chave valida) ----
          const cands = [];
          const push = (k) => { if (k && cands.indexOf(k) === -1) cands.push(k); };
          push(p.serialized);
          if (p.idPart && p.remote && p.fromMe !== undefined && p.fromMe !== null) {
            push(`${p.fromMe}_${p.remote}_${p.idPart}`);
          }
          if (p.idPart && p.chatId && p.chatId !== p.remote && p.fromMe !== undefined && p.fromMe !== null) {
            push(`${p.fromMe}_${p.chatId}_${p.idPart}`);
          }

          let m = null;
          let via = '';
          const matches = (x) => !!(x && (!p.idPart || !x.id || x.id.id === p.idPart));
          for (let i = 0; i < cands.length && !m; i++) {
            try {
              const x = C.Msg.get(cands[i]);
              if (matches(x)) { m = x; via = 'Msg.get'; }
            } catch (e) { /* tenta a proxima chave */ }
          }
          if (!m) {
            // Varre as mensagens ja carregadas do chat e casa pelo id curto.
            try {
              const W = window.require('WAWebWidFactory');
              const chat = p.chatId ? C.Chat.get(W.createWid(p.chatId)) : null;
              let models = [];
              if (chat && chat.msgs) {
                if (typeof chat.msgs.getModels === 'function') models = chat.msgs.getModels() || [];
                else if (Array.isArray(chat.msgs.models)) models = chat.msgs.models;
                else if (Array.isArray(chat.msgs)) models = chat.msgs;
              }
              for (let i = 0; i < models.length && !m; i++) {
                const x = models[i];
                if (x && x.id && x.id.id && x.id.id === p.idPart) { m = x; via = 'chat-scan'; }
              }
            } catch (e) { /* ignora */ }
          }
          if (!m && cands.length) {
            try {
              const r = await withTimeout(C.Msg.getMessagesById(cands), 4000, 'getMessagesById');
              const arr = (r && r.messages) || [];
              for (let i = 0; i < arr.length && !m; i++) {
                if (matches(arr[i])) { m = arr[i]; via = 'getMessagesById'; }
              }
            } catch (e) { /* ignora */ }
          }
          if (!m) {
            // Ultimo recurso: a chave real da ultima mensagem do chat.
            try {
              const W = window.require('WAWebWidFactory');
              const chat = p.chatId ? C.Chat.get(W.createWid(p.chatId)) : null;
              const lk = chat && chat.lastReceivedKey;
              const k = lk ? (lk._serialized || (typeof lk === 'string' ? lk : '')) : '';
              if (k) {
                const x = C.Msg.get(k);
                if (matches(x)) { m = x; via = 'lastReceivedKey'; }
              }
            } catch (e) { /* ignora */ }
          }
          if (!m) return fail('lookup', `mensagem nao encontrada (chaves: ${cands.join(' | ') || 'nenhuma'})`);
          if (!m.mediaData) return fail('nomedia', 'mensagem sem mediaData');
          try { realKey = (m.id && m.id._serialized) || ''; } catch (e) { realKey = ''; }

          const stage = String(m.mediaData.mediaStage || '');
          if (stage === 'REUPLOADING') return fail('reuploading', 'midia expirada, cliente pedindo reupload', stage);

          return {
            ok: true,
            key: realKey || p.serialized || '',
            stage,
            via,
            type: String(safe(() => m.type) || ''),
            mimetype: String(safe(() => m.mimetype) || p.knownMime || ''),
            mediaKey: toB64(safe(() => m.mediaKey)),
            directPath: String(safe(() => m.directPath) || ''),
            deprecatedMms3Url: String(safe(() => m.deprecatedMms3Url) || ''),
            clientUrl: String(safe(() => m.clientUrl) || ''),
            size: Number(safe(() => m.size) || 0),
          };
        } catch (e) {
          return fail('outer', e, '');
        }
      }, keyParts);
    } catch (e) {
      meta = {
        ok: false,
        step: 'evaluate',
        error: String(e && e.message ? e.message : e),
        detail: String(e && e.stack ? e.stack : '').split('\n').slice(0, 3).join(' | '),
        stage: '',
      };
    }

    if (meta && meta.key && msg.id && typeof msg.id === 'object' && msg.id._serialized !== meta.key) {
      const oldKey = msg.id._serialized;
      try { msg.id._serialized = meta.key; } catch (_) { /* ignore */ }
      const cd = this.clients.get(zapId);
      if (cd && cd.messages) {
        if (oldKey) cd.messages.delete(oldKey);
        cd.messages.set(meta.key, msg);
      }
    }

    let diag = meta;
    if (meta && meta.ok) {
      const mimetype = meta.mimetype || rawMime || 'audio/ogg';
      const urls = [];
      const addUrl = (value) => {
        if (!value || typeof value !== 'string') return;
        let url = value.trim();
        if (!url) return;
        if (url.startsWith('//')) url = 'https:' + url;
        else if (url.startsWith('/')) url = 'https://mmg.whatsapp.net' + url;
        if (!/^https?:\/\//i.test(url)) return;
        if (urls.indexOf(url) === -1) urls.push(url);
      };
      addUrl(meta.deprecatedMms3Url);
      addUrl(meta.clientUrl);
      addUrl(meta.directPath);

      if (urls.length && meta.mediaKey) {
        const fetched = await this._fetchMediaBuffer(urls, 15000);
        if (fetched.buffer) {
          try {
            const decrypted = decryptWhatsAppMedia(fetched.buffer, meta.mediaKey, meta.type);
            this.logToApp(zapId, 'success', `Audio baixado pela CDN e descriptografado (${decrypted.length} bytes). Sera transcrito pela IA.`);
            return {
              data: decrypted.toString('base64'),
              mimetype,
              size: decrypted.length,
            };
          } catch (e) {
            this.logToApp(zapId, 'warning', `Fallback de descriptografia manual falhou: ${e.message}`);
            diag = {
              ...meta,
              ok: false,
              step: 'manual-decrypt',
              error: e.message,
              detail: fetched.errors.join(' | ').slice(0, 800),
            };
          }
        } else {
          const errTxt = fetched.errors.join(' | ').slice(0, 800);
          this.logToApp(zapId, 'warning', `CDN do audio falhou: ${errTxt}`);
          diag = {
            ...meta,
            ok: false,
            step: 'cdn',
            error: 'download da CDN falhou',
            detail: errTxt,
          };
        }
      } else {
        diag = {
          ...meta,
          ok: false,
          step: 'metadata',
          error: !meta.mediaKey ? 'mediaKey ausente' : 'URL de midia ausente',
        };
      }

      const direct = await page.evaluate(async (p) => {
        const fail = (step, e, stage) => ({
          ok: false,
          step,
          error: String((e && (e.message || e.name)) || e || 'erro desconhecido'),
          detail: String((e && e.stack) || '').split('\n').slice(0, 3).join(' | '),
          stage: String(stage || ''),
          key: p.key || '',
        });
        const withTimeout = (promise, ms, label) => new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
          Promise.resolve(promise).then(
            (value) => { clearTimeout(timer); resolve(value); },
            (e) => { clearTimeout(timer); reject(e); }
          );
        });
        const toB64 = (bytes) => {
          let out = '';
          for (let i = 0; i < bytes.length; i += 0x8000) {
            out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          }
          return btoa(out);
        };
        try {
          const C = window.require('WAWebCollections');
          const m = p.key ? C.Msg.get(p.key) : null;
          if (!m) return fail('lookup', 'mensagem nao encontrada para download');
          if (!m.mediaData) return fail('nomedia', 'mensagem sem mediaData');
          const stage = String(m.mediaData.mediaStage || '');
          if (stage === 'REUPLOADING') return fail('reuploading', 'midia expirada, cliente pedindo reupload', stage);

          const raw = String(m.mimetype || p.mimetype || '').trim();
          const base = raw.split(';')[0].trim();
          const mimes = [];
          const addMime = (v) => { if (v && mimes.indexOf(v) === -1) mimes.push(v); };
          addMime(raw);
          addMime(base);
          addMime('audio/ogg');
          addMime('audio/mp4');
          addMime('audio/aac');
          const types = [];
          const addType = (v) => { if (v && types.indexOf(v) === -1) types.push(v); };
          addType(m.type || p.type);
          addType('audio');
          addType('ptt');

          const pairs = [];
          for (const mime of mimes) {
            for (const typ of types) pairs.push({ mime, typ });
          }

          const tried = [];
          for (let i = 0; i < pairs.length && i < 4; i++) {
            const { mime, typ } = pairs[i];
            const ac = new AbortController();
            const timer = setTimeout(() => ac.abort(), 10000);
            try {
              const D = window.require('WAWebDownloadManager');
              if (!D || !D.downloadManager) return fail('module', 'WAWebDownloadManager indisponivel', stage);
              const buf = await withTimeout(D.downloadManager.downloadAndMaybeDecrypt({
                directPath: m.directPath,
                encFilehash: m.encFilehash,
                filehash: m.filehash,
                mediaKey: m.mediaKey,
                mediaKeyTimestamp: m.mediaKeyTimestamp,
                type: typ,
                mimetype: mime,
                signal: ac.signal,
                downloadQpl: { addAnnotations() { return this; }, addPoint() { return this; } },
              }), 11000, 'download');
              const bytes = new Uint8Array(buf);
              return {
                ok: true,
                data: toB64(bytes),
                mimetype: mime,
                size: bytes.length,
                via: `direct/${typ}/${mime}`,
                key: p.key,
              };
            } catch (e) {
              tried.push(`${typ}/${mime}: ${String((e && (e.message || e.name)) || e)}`);
            } finally {
              clearTimeout(timer);
              try { ac.abort(); } catch (_) { /* ignore */ }
            }
          }

          return {
            ok: false,
            step: 'decrypt',
            error: tried[0] || 'download direto falhou',
            detail: tried.join(' | ').slice(0, 800),
            stage,
            key: p.key,
          };
        } catch (e) {
          return fail('outer', e, '');
        }
      }, {
        key: meta.key || keyParts.serialized,
        mimetype,
        type: meta.type,
      });

      if (direct && direct.ok) {
        const viaTxt = direct.via ? ` via ${direct.via}` : '';
        this.logToApp(zapId, 'success', `Audio baixado (${direct.size || 0} bytes${viaTxt}). Sera transcrito pela IA.`);
        return {
          data: direct.data,
          mimetype: direct.mimetype || mimetype,
          size: direct.size || 0,
        };
      }
      if (direct) {
        diag = {
          ...meta,
          ok: false,
          step: direct.step || 'direct',
          error: direct.error || 'download direto falhou',
          detail: [diag && diag.detail, direct.detail].filter(Boolean).join(' | ').slice(0, 800),
          stage: direct.stage || meta.stage,
        };
      }
    }

    const dStep = diag ? diag.step : '?';
    const dErr = diag ? diag.error : 'sem detalhe';
    const dStage = diag && diag.stage ? ` stage=${diag.stage}` : '';
    const dDet = diag && diag.detail ? ` | ${diag.detail}` : '';
    console.error(`[AUDIO] Diagnostico: passo=${dStep} erro=${dErr}${dStage}`);
    this.logToApp(zapId, 'warning', `Diagnostico download: passo=${dStep} erro=${dErr}${dStage}${dDet}`);
    return null;
  }

  _errText(e) {
    if (!e) return 'erro desconhecido';
    if (typeof e === 'string') return e;
    return e.message || String(e);
  }

  // Erros que indicam que a pagina do WhatsApp morreu/recarregou
  _isPageDeadError(e) {
    const m = this._errText(e).toLowerCase();
    return m.includes('detached') || m.includes('execution context') ||
      m.includes('frame') || m.includes('target closed') ||
      m.includes('page has been closed') || m.includes('protocol error') ||
      m.includes('session closed') || m.includes('websocket is not open');
  }

  // O WhatsApp Web atual resolve o numero do contato para um LID (@lid) e o
  // chat DEVE ser buscado/criado pelo LID - getChat(@c.us) lanca
  // "No LID for user" (toUserLidOrThrow). getNumberId faz a consulta no
  // servidor (queryWidExists) e devolve esse LID; enviamos por ele e
  // mantemos o @c.us original como fallback.
  // Retorna: { ids: [chatId, ...], notOnWa: bool }
  async _resolveSendTarget(client, targetId) {
    const ids = [];
    const push = (v) => { if (v && !ids.includes(v)) ids.push(v); };

    // @lid já é um identificador de chat válido no WhatsApp Web moderno.
    // getNumberId espera um número de telefone com DDI/DDD e retornaria null para hashes de LID,
    // marcando erroneamente notOnWa: true e impedindo o envio de respostas e mensagens de erro.
    if (typeof targetId === 'string' && targetId.includes('@lid')) {
      push(targetId);
      return { ids, notOnWa: false };
    }

    // Cache de resolucao: evita chamar getNumberId (consulta de rede) a cada
    // envio para o mesmo contato (no autochat o mesmo numero e enviado sempre).
    if (!this._sendTargetCache) this._sendTargetCache = new Map();
    const cached = this._sendTargetCache.get(targetId);
    if (cached && (Date.now() - cached.t) < 10 * 60 * 1000) {
      return { ids: cached.ids.slice(), notOnWa: false };
    }

    const num = this._normNum(targetId);
    if (!num || typeof client.getNumberId !== 'function') {
      push(targetId);
      return { ids };
    }

    let wid = null;
    try {
      wid = await client.getNumberId(num);
    } catch (e) {
      // Consulta falhou (rede/limite): nao bloqueia - envia direto
      console.warn(`[WHATSAPP] getNumberId(${num}) falhou: ${this._errText(e)}`);
      push(targetId);
      return { ids };
    }
    if (wid === null) return { ids, notOnWa: true }; // null = numero fora do WhatsApp

    let alt = typeof wid === 'string' ? wid : (wid && wid._serialized ? String(wid._serialized) : null);
    if (alt) {
      alt = alt.replace(/:\d+@/, '@'); // remove sufixo de device (:12)
      if (alt.endsWith('@s.whatsapp.net')) alt = alt.replace(/@s\.whatsapp\.net$/, '@c.us');
      push(alt); // @lid (preferido) ou @c.us resolvido
    }
    push(targetId); // fallback: numero original
    if (this._sendTargetCache.size > 500) this._sendTargetCache.clear();
    this._sendTargetCache.set(targetId, { ids: ids.slice(), t: Date.now() });
    return { ids };
  }

  // Saude da pagina: evaluate responde em ate 5s?
  async _pageHealthy(clientData) {
    try {
      const page = clientData && clientData.client ? clientData.client.pupPage : null;
      if (!page || (typeof page.isClosed === 'function' && page.isClosed())) return false;
      await this._withTimeout(page.evaluate(() => true), 5000, 'Saude da pagina');
      return true;
    } catch (_) {
      return false;
    }
  }

  // Espera a pagina voltar a responder (reload do WA Web costuma se resolver)
  async _waitPageHealthy(clientData, maxMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      if (await this._pageHealthy(clientData)) return true;
      await new Promise(r => setTimeout(r, 2000));
    }
    return false;
  }

  // Espera o zap ficar 'ready'
  async _waitReady(zapId, maxMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      const d = this.clients.get(zapId);
      if (d && d.status === 'ready') return true;
      await new Promise(r => setTimeout(r, 1500));
    }
    return false;
  }

  // Reconexao forcada preservando a sessao (LocalAuth no disco)
  async _forceReconnect(zapId) {
    if (this._reconnecting.has(zapId)) return this._waitReady(zapId, 120000);
    const cd = this.clients.get(zapId);
    if (!cd) return false;

    this._reconnecting.add(zapId);
    this.logToApp(zapId, 'warning', 'Pagina do WhatsApp inoperante - reconectando automaticamente (sessao preservada)...');
    try {
      await this.disconnectZap(zapId, 'reconexao automatica');
      // 'qrcode': nao apaga a sessao existente - LocalAuth reusa o login
      await this.connectZap(zapId, cd.phoneNumber || '', 'qrcode');
      const ok = await this._waitReady(zapId, 150000);
      if (ok) this.logToApp(zapId, 'success', 'Reconexao automatica concluida - sistema pronto.');
      else this.logToApp(zapId, 'error', 'Reconexao automatica nao ficou pronta a tempo.');
      return ok;
    } catch (e) {
      this.logToApp(zapId, 'error', `Reconexao automatica falhou: ${this._errText(e)}`);
      return false;
    } finally {
      this._reconnecting.delete(zapId);
    }
  }

  // Recupera a pagina morta: espera o reload sozinho e, se nao voltar,
  // reconecta o zap. true = pagina pronta para enviar.
  async _healPage(zapId) {
    const cd0 = this.clients.get(zapId);
    if (cd0 && (await this._waitPageHealthy(cd0, 30000))) return true;
    return this._forceReconnect(zapId);
  }

  // Envio com retry inteligente:
  //  - pagina morta -> espera/recarrega e tenta de novo
  //  - "Numero nao esta no WhatsApp" -> falha permanente na hora
  //  - outros erros -> nova tentativa em 1.5s (3 no total)
  async _sendRobust(zapId, ids, doSend) {
    const attempts = 3;
    let lastErr = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const cd = this.clients.get(zapId);
      if (!cd || cd.status !== 'ready') {
        throw new Error(`Zap ${zapId} ${cd ? 'esta ' + cd.status : 'foi desconectado'} - envio interrompido`);
      }
      for (const id of ids) {
        try {
          return await doSend(cd.client, id);
        } catch (e) {
          lastErr = e;
          const em = this._errText(e);
          if (/nao esta no whatsapp/i.test(em)) throw new Error('Numero nao esta no WhatsApp');
          if (this._isPageDeadError(e)) {
            this.logToApp(zapId, 'warning', `Pagina do WhatsApp instavel (${em}) - tentando recuperar (tentativa ${attempt}/${attempts})...`);
            const ok = await this._healPage(zapId);
            if (!ok) throw new Error(`A pagina do WhatsApp nao recuperou apos o reinicio (${em})`);
          } else {
            this.logToApp(zapId, 'warning', `Envio falhou para ${id} (tentativa ${attempt}/${attempts}): ${em}`);
          }
        }
      }
      if (attempt < attempts) await new Promise(r => setTimeout(r, 800));
    }
    throw lastErr || new Error('Falha ao enviar mensagem');
  }

  async sendMessage(zapId, phone, text, opts) {
    const clientData = this.clients.get(zapId);
    if (!clientData || clientData.status !== 'ready') {
      throw new Error(`Zap ${zapId} nao esta conectado`);
    }
    const source = (opts && opts.source) || 'owner';

    const msgText = String(text || '');
    const targetId = this._normalizeChatId(phone);
    console.log(`[WHATSAPP] Enviando mensagem para ${targetId}: ${msgText.substring(0, 80)}`);

    // Resolve o LID do contato antes de enviar (evita "No LID for user")
    const resolved = await this._resolveSendTarget(clientData.client, targetId);
    if (resolved.notOnWa) {
      this.logToApp(zapId, 'warning', `Numero ${targetId} nao esta no WhatsApp - envio abortado`);
      throw new Error('Numero nao esta no WhatsApp');
    }

    // Anti-loop: marca este envio como sendo da IA para que o message_create
    // do autochat NAO volte a chamar a IA (a IA nao responde a si mesma)
    const markAiSend = () => {
      const d = this.clients.get(zapId);
      if (d) {
        if (!d.pendingAiSends) d.pendingAiSends = [];
        d.pendingAiSends.push({ body: msgText, t: Date.now() });
        if (d.pendingAiSends.length > 20) d.pendingAiSends.shift();
      }
    };
    const markAiSentId = (sentMsg) => {
      const d = this.clients.get(zapId);
      const sid = this._ensureMsgKey(sentMsg);
      if (d && sid) {
        if (!d.aiSentIds) d.aiSentIds = new Set();
        d.aiSentIds.add(sid);
        if (d.aiSentIds.size > 500) {
          const first = d.aiSentIds.values().next().value;
          d.aiSentIds.delete(first);
        }
      }
    };

    markAiSend();
    const setSending = (v) => { const d = this.clients.get(zapId); if (d) d.aiSending = v; };
    setSending(true);
    try {
      const sentMsg = await this._sendRobust(zapId, resolved.ids, (client, id) => client.sendMessage(id, msgText));
      markAiSentId(sentMsg);
      this.logToApp(zapId, 'success', `Mensagem enviada para ${targetId}`);
      this._recordOutgoing(zapId, targetId, msgText, source, sentMsg);
      return { success: true, msgId: this._ensureMsgKey(sentMsg) };
    } catch (e) {
      console.error(`[WHATSAPP] Erro ao enviar com client.sendMessage:`, e);
      // Numero fora do WhatsApp: nao existe chat - nao tenta reply
      if (/nao esta no whatsapp/i.test(this._errText(e))) throw e;
      this.logToApp(zapId, 'warning', `sendMessage direto falhou (${e.message}). Tentando reply...`);
      // Fallback: find most recent message from this chat (by timestamp)
      // No autochat TODAS as mensagens sao fromMe - entao aceita fromMe tambem
      const cdNow = this.clients.get(zapId) || clientData;
      const isSelfTarget = this._selfNums(cdNow).includes(this._normNum(targetId));
      let lastMsg = null;
      let lastTs = 0;
      for (const [, msg] of cdNow.messages) {
        // match by normalized number
        const msgNum = this._normNum(msg.from || msg.to || '');
        const targetNum = this._normNum(targetId);
        if (msgNum === targetNum && (isSelfTarget || !msg.fromMe) && (msg.timestamp || 0) >= lastTs) {
          lastMsg = msg;
          lastTs = msg.timestamp || 0;
        }
      }

      if (lastMsg) {
        try {
          const sentMsg = await lastMsg.reply(msgText);
          markAiSentId(sentMsg);
          this.logToApp(zapId, 'success', `Mensagem enviada via reply para ${targetId}`);
          this._recordOutgoing(zapId, targetId, msgText, source, sentMsg);
          return { success: true, msgId: this._ensureMsgKey(sentMsg) };
        } catch (replyError) {
          console.error(`[WHATSAPP] Erro ao enviar com reply:`, replyError);
          this.logToApp(zapId, 'error', `Falha ao enviar mensagem (reply): ${replyError.message}`);
          throw replyError;
        }
      } else {
        this.logToApp(zapId, 'error', `Falha ao enviar mensagem e sem mensagem anterior para reply: ${e.message}`);
        throw e;
      }
    } finally {
      setSending(false);
    }
  }

  async sendMedia(zapId, phone, mediaData, opts) {
    const clientData = this.clients.get(zapId);
    if (!clientData || clientData.status !== 'ready') {
      throw new Error(`Zap ${zapId} nao esta conectado`);
    }
    const source = (opts && opts.source) || 'owner';

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

    // Resolve o LID do contato antes de enviar (evita "No LID for user")
    const resolved = await this._resolveSendTarget(clientData.client, targetId);
    if (resolved.notOnWa) {
      this.logToApp(zapId, 'warning', `Numero ${targetId} nao esta no WhatsApp - envio de midia abortado`);
      throw new Error('Numero nao esta no WhatsApp');
    }

    // Anti-loop (autochat): marca envio de midia como sendo da IA
    const dMark = this.clients.get(zapId);
    if (dMark) {
      if (!dMark.pendingAiSends) dMark.pendingAiSends = [];
      dMark.pendingAiSends.push({ body: '', midia: true, t: Date.now() });
      if (dMark.pendingAiSends.length > 20) dMark.pendingAiSends.shift();
      dMark.aiSending = true;
    }
    try {
      const sentMsg = await this._sendRobust(zapId, resolved.ids, async (client, id) => {
        await this._patchMediaMsgAttrs(client);
        return client.sendMessage(id, media);
      });
      const sid = this._ensureMsgKey(sentMsg);
      const d2 = this.clients.get(zapId);
      if (d2 && sid) {
        if (!d2.aiSentIds) d2.aiSentIds = new Set();
        d2.aiSentIds.add(sid);
      }
      this.logToApp(zapId, 'success', `Midia enviada para ${targetId}: ${mediaData.name}`);
      this._recordOutgoing(zapId, targetId, mediaData.name || '[mídia]', source, sentMsg, { hasMedia: true });
      return mediaData.returnId ? { success: true, msgId: sid || null } : { success: true };
    } catch (e) {
      console.error(`[WHATSAPP] Erro ao enviar midia:`, e);
      if (/nao esta no whatsapp/i.test(this._errText(e))) throw e;
      const cdNow = this.clients.get(zapId) || clientData;
      const isSelfTarget = this._selfNums(cdNow).includes(this._normNum(targetId));
      let lastMsg = null;
      let lastTs = 0;
      for (const [, msg] of cdNow.messages) {
        const msgNum = this._normNum(msg.from || msg.to || '');
        const targetNum = this._normNum(targetId);
        if (msgNum === targetNum && (isSelfTarget || !msg.fromMe) && (msg.timestamp || 0) >= lastTs) {
          lastMsg = msg; lastTs = msg.timestamp || 0;
        }
      }
      if (lastMsg) {
        await lastMsg.reply(media);
        this.logToApp(zapId, 'success', `Midia enviada via reply para ${targetId}: ${mediaData.name}`);
        this._recordOutgoing(zapId, targetId, mediaData.name || '[mídia]', source, null, { hasMedia: true });
        return mediaData.returnId ? { success: true, msgId: null } : { success: true };
      }
      this.logToApp(zapId, 'error', `Falha ao enviar midia: ${e.message}`);
      throw e;
    } finally {
      const dEnd = this.clients.get(zapId);
      if (dEnd) dEnd.aiSending = false;
    }
  }

  // ============================================================
  // RESPOSTA DO DONO DO NUMERO (evita a IA responder por cima)
  // ============================================================

  // Registra que o dono respondeu neste chat no horario `ts` (segundos).
  markOwnerReply(zapId, chatId, ts) {
    const cd = this.clients.get(String(zapId));
    if (!cd) return;
    const chatNorm = this._normNum(chatId);
    if (!chatNorm) return;
    if (!cd.ownerReplies) cd.ownerReplies = new Map();
    const t = Number(ts) || Math.floor(Date.now() / 1000);
    if (t > (cd.ownerReplies.get(chatNorm) || 0)) {
      cd.ownerReplies.set(chatNorm, t);
    }
  }

  // O dono respondeu depois de `sinceTs`? Checa o evento em tempo real e,
  // quando `opts.live`, confere ao vivo na rede (pega o que o evento perdeu).
  async hasOwnerReplied(zapId, chatId, sinceTs, opts) {
    const cd = this.clients.get(String(zapId));
    if (!cd) return false;
    const since = Number(sinceTs) || 0;
    const chatNorm = this._normNum(chatId);
    if (cd.ownerReplies && chatNorm) {
      const t = cd.ownerReplies.get(chatNorm) || 0;
      if (t > since) return true;
    }
    if (opts && opts.live && since) {
      try {
        const msgs = await this.fetchRecentMessages(zapId, chatId, 4);
        for (const m of msgs) {
          if (m && m.fromMe && m.deviceType && m.deviceType !== 'web' && (m.timestamp || 0) > since) {
            return true;
          }
        }
      } catch (_) { /* rede falhou - segue com o que ja tem */ }
    }
    return false;
  }

  // Ultimas mensagens do chat, direto do WhatsApp (para conferencia ao vivo).
  async fetchRecentMessages(zapId, chatId, limit) {
    const cd = this.clients.get(String(zapId));
    if (!cd || !cd.client) return [];
    const client = cd.client;
    const targetId = this._normalizeChatId(chatId);
    let ids = [targetId];
    try {
      const resolved = await this._resolveSendTarget(client, targetId);
      if (resolved && Array.isArray(resolved.ids) && resolved.ids.length) ids = resolved.ids;
    } catch (_) { /* usa o id cru */ }
    for (const id of ids) {
      try {
        const chat = await client.getChatById(id);
        if (!chat || typeof chat.fetchMessages !== 'function') continue;
        const msgs = await chat.fetchMessages({ limit: limit || 3 });
        if (Array.isArray(msgs)) {
          return msgs.map(m => ({
            id: this._ensureMsgKey(m),
            fromMe: !!m.fromMe,
            deviceType: m.deviceType || null,
            timestamp: m.timestamp || 0,
            body: m.body || '',
            hasMedia: !!m.hasMedia
          }));
        }
      } catch (_) { /* tenta o proximo id */ }
    }
    return [];
  }

  // Envia citando (reply) a mensagem `quotedMsgId` armazenada no cache.
  // Sem a mensagem em cache, cai para o envio normal.
  async replyMessage(zapId, phone, text, quotedMsgId) {
    const clientData = this.clients.get(zapId);
    if (!clientData || clientData.status !== 'ready') {
      throw new Error(`Zap ${zapId} nao esta conectado`);
    }
    const msgText = String(text || '');
    const targetId = this._normalizeChatId(phone);
    const quoted = (quotedMsgId && clientData.messages) ? clientData.messages.get(quotedMsgId) : null;
    if (!quoted || typeof quoted.reply !== 'function') {
      this.logToApp(zapId, 'warning', `Mensagem citada indisponivel (${quotedMsgId}) - enviando sem citacao.`);
      return this.sendMessage(zapId, phone, msgText);
    }

    const d = this.clients.get(zapId);
    if (d) {
      if (!d.pendingAiSends) d.pendingAiSends = [];
      d.pendingAiSends.push({ body: msgText, t: Date.now() });
      if (d.pendingAiSends.length > 20) d.pendingAiSends.shift();
      d.aiSending = true;
    }
    try {
      const sentMsg = await this._sendRobust(zapId, [targetId], () => quoted.reply(msgText));
      const sid = this._ensureMsgKey(sentMsg);
      const d2 = this.clients.get(zapId);
      if (d2 && sid) {
        if (!d2.aiSentIds) d2.aiSentIds = new Set();
        d2.aiSentIds.add(sid);
      }
      this.logToApp(zapId, 'success', `Mensagem enviada citando a mensagem anterior para ${targetId}`);
      this._recordOutgoing(zapId, targetId, msgText, 'ai', sentMsg);
      return { success: true, msgId: sid, quoted: true };
    } catch (e) {
      this.logToApp(zapId, 'warning', `Envio citado falhou (${e.message}) - enviando sem citacao.`);
      return this.sendMessage(zapId, phone, msgText);
    } finally {
      const dEnd = this.clients.get(zapId);
      if (dEnd) dEnd.aiSending = false;
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

  getQrString(zapId) {
    const clientData = this.clients.get(String(zapId));
    return clientData && clientData.qrCode ? clientData.qrCode : null;
  }

  listConnectionStates() {
    return [...this.clients.entries()].map(([id, d]) => ({
      id: String(id),
      status: d.status || 'unknown',
      phone: d.phoneNumber || null,
      method: d.method || null,
      qrPending: !!d.qrCode,
      pairingCode: d.pairingCode || null
    }));
  }

  getStoredChat(zapId, chatId) {
    const clientData = this.clients.get(zapId);
    if (!clientData || !clientData.chats) return null;
    return clientData.chats.get(chatId) || null;
  }

  async fetchAllContacts(zapId, attempt = 0) {
    const clientData = this.clients.get(zapId);
    if (!clientData || clientData.status !== 'ready') return;

    // 'ready' chega duplicado e disparava N buscas simultaneas, que derrubavam
    // o execution context da pagina ("Execution context was destroyed")
    if (attempt === 0) {
      if (clientData.contactsFetching) return;
      clientData.contactsFetching = true;
    }

    console.log(`[CONTACTS] Buscando todos os contatos do Zap ${zapId}...`);
    try {
      const page = clientData.client && clientData.client.pupPage;
      if (!page) throw new Error('pagina do WhatsApp indisponivel');

      // Busca feita NA PAGINA, chat a chat. O getChats do wwebjs usa
      // Promise.all: UM chat quebrado derrubava tudo (erro "r" no log) e o
      // fallback de antes ainda descartava @lid, escondendo quase todos os
      // contatos. Aqui cada chat e isolado, os grupos/canais sao pulados e os
      // contatos @lid (padrao atual do WhatsApp) entram normalmente, com o
      // numero real resolvido pelo proprio cache do WhatsApp quando existe.
      const res = await page.evaluate(async () => {
        const out = { chats: [], errors: [], skip: { grupo: 0, canal: 0, transmissao: 0, semId: 0 } };
        let list = [];
        try {
          list = window.require('WAWebCollections').Chat.getModelsArray() || [];
        } catch (e) {
          out.errors.push('getModelsArray: ' + (e && e.message ? e.message : String(e)));
          return out;
        }

        const numFromWid = (v) => {
          const s = (v && typeof v === 'object') ? (v._serialized || String(v)) : String(v || '');
          return String(s).split('@')[0].replace(/:\d+$/, '');
        };

        // Agenda do usuario: mapa numero -> nome. Serve para dar nome aos
        // chats que vem sem formattedTitle/nome no WhatsApp (ficam so o numero).
        const dirMap = {};
        try {
          const WFB = window.require('WAWebWidFactory');
          const contacts = window.require('WAWebCollections').Contact.getModelsArray() || [];
          for (const c of contacts) {
            try {
              const nm = c.name || c.pushname || c.shortName || '';
              if (!nm) continue;
              const cid = c.id && typeof c.id === 'object' ? c.id._serialized : c.id;
              const cn = numFromWid(cid);
              if (/^\d{6,}$/.test(cn)) dirMap[cn] = nm;
            } catch (_) { /* contato sem id resolvivel */ }
          }
        } catch (_) { /* colecao indisponivel */ }

        for (const chat of list) {
          try {
            let chatId = '';
            try { chatId = (chat.id && chat.id._serialized) || String(chat.id || ''); } catch (_) {}
            if (!chatId) { out.skip.semId++; continue; }
            if (chatId.includes('@g.us')) { out.skip.grupo++; continue; }
            if (chatId.includes('@newsletter')) { out.skip.canal++; continue; }
            if (chatId.includes('@broadcast')) { out.skip.transmissao++; continue; }
            let isGrp = false;
            try { isGrp = chat.isGroup === true || !!chat.groupMetadata; } catch (_) {}
            if (isGrp) { out.skip.grupo++; continue; }

            let name = '';
            try { name = chat.formattedTitle || chat.name || ''; } catch (_) {}

            const lidNum = chatId.split('@')[0].replace(/:\d+$/, '');
            let number = lidNum;
            const isLid = chatId.endsWith('@lid');

            // Contato ja conhecido pelo WhatsApp: nome extra + numero real
            try {
              const WFB = window.require('WAWebWidFactory');
              const c = window.require('WAWebCollections').Contact.get(WFB.createWid(chatId));
              if (c) {
                if (!name) name = c.name || c.pushname || c.shortName || '';
                const pn = c.phoneNumber;
                const pnSer = pn && typeof pn === 'object' ? pn._serialized : pn;
                if (pnSer && !String(pnSer).endsWith('@lid')) number = numFromWid(pnSer);
                else {
                  const cid = c.id && typeof c.id === 'object' ? c.id._serialized : c.id;
                  if (cid && !String(cid).endsWith('@lid')) number = numFromWid(cid);
                }
              }
            } catch (_) { /* contato fora da agenda */ }

            // Mapa LID -> PN do proprio WhatsApp (cache local, sem rede)
            if (isLid && number === lidNum) {
              try {
                const pn = window.require('WAWebApiContact').getPhoneNumber(window.require('WAWebWidFactory').createWid(chatId));
                const s = pn && typeof pn === 'object' ? pn._serialized : pn;
                if (s && !String(s).endsWith('@lid')) number = numFromWid(s);
              } catch (_) { /* sem mapeamento disponivel */ }
            }

            // Sem nome ou nome = numero: tenta o nome da agenda pelo numero real
            if (!name || name === number || /^[\d\s()+\-]*$/.test(String(name))) {
              if (dirMap[number]) name = dirMap[number];
            }
            if (!name) name = number;
            out.chats.push({ id: chatId, name: String(name), number: String(number) });
          } catch (e) {
            out.errors.push('chat: ' + (e && e.message ? e.message : String(e)));
          }
        }
        return out;
      });

      if (res.errors && res.errors.length) {
        console.warn('[CONTACTS] chats com erro no carregamento:', res.errors.slice(0, 10).join(' | '));
        if (res.errors.length > 10) console.warn(`[CONTACTS] ...e mais ${res.errors.length - 10} erros.`);
      }
      if (!res.chats || !res.chats.length) {
        if (res.errors && res.errors.length) throw new Error(`busca de contatos vazia: ${res.errors[0]}`);
      }

      const chatList = res.chats || [];
      const skipInfo = res.skip || {};
      if (chatList.length) {
        console.log(`[CONTACTS] ${chatList.length} chats 1:1 na memoria (pulados: ${skipInfo.grupo || 0} grupos, ${skipInfo.canal || 0} canais, ${skipInfo.transmissao || 0} transmissoes, ${skipInfo.semId || 0} sem id)`);
      }

      if (!this.conversations.has(zapId)) {
        this.conversations.set(zapId, new Map());
      }
      const zapConvs = this.conversations.get(zapId);
      let added = 0;
      let skipped = 0;

      for (const chat of chatList) {
        try {
          if (!chat || !chat.id) { skipped++; continue; }
          // A pagina ja deixou de fora grupos/canais/transmissoes; aqui fica
          // so a defesa contra @g.us que porventura entre. @lid ENTRA (decisao:
          // lid e contato normal, so @g.us/@newsletter/@broadcast sao bloqueados).
          const chatId = String(chat.id);
          if (!chatId || chatId.includes('@g.us') || chatId.includes('@newsletter') || chatId.includes('@broadcast')) {
            skipped++; continue;
          }

          if (!zapConvs.has(chatId)) {
            const contactNumber = String(chat.number || chatId.split('@')[0].replace(/:\d+$/, ''));
            // Chat de servico do WhatsApp chega como "0" - nao e contato valido
            if (!/^\d{6,}$/.test(contactNumber)) { skipped++; continue; }
            const contactName = String(chat.name || '');
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
          } else {
            // Conversa ja conhecida: melhora o nome se agora temos um nome real
            const conv = zapConvs.get(chatId);
            const contactName = String(chat.name || '');
            if (conv && conv.contact) {
              if (this._isNumericName(conv.contact.name) && contactName && !this._isNumericName(contactName)) {
                conv.contact.name = contactName;
              }
              if (chat.number && (!conv.contact.number || this._isNumericName(conv.contact.number))) {
                conv.contact.number = String(chat.number);
              }
            }
          }
        } catch (chatErr) {
          console.warn(`[CONTACTS] skip chat ${chat && chat.id ? chat.id : 'unknown'}:`, chatErr.message);
          skipped++;
          continue;
        }
      }

      console.log(`[CONTACTS] Zap ${zapId}: ${added} novos contatos (total: ${zapConvs.size}, ${skipped} ignorados)`);
      this.logToApp(zapId, 'info', `Contatos carregados: ${added} novos (${zapConvs.size} total, ${skipped} ignorados).`);
      this.persistContacts();
      this.sendToRenderer('whatsapp-contacts-updated', { zapId });
    } catch (e) {
      if (attempt === 0) {
        // Contexto pode ter sido destruido por navegacao - tenta de novo
        this.logToApp(zapId, 'info', 'Falha ao buscar contatos; nova tentativa em 1,5s...');
        await new Promise(r => setTimeout(r, 1500));
        return await this.fetchAllContacts(zapId, 1);
      }
      const em = e && e.message ? e.message : String(e);
      const es = e && e.stack ? e.stack.split('\n').slice(0,4).join(' | ') : '';
      console.error(`[CONTACTS] Erro ao buscar contatos do Zap ${zapId}:`, em, es);
      this.logToApp(zapId, 'warning', `Erro ao buscar contatos: ${em} ${es}`);
    } finally {
      if (attempt === 0) {
        const d = this.clients.get(zapId);
        if (d) d.contactsFetching = false;
      }
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

  // Localiza a conversa pelo chatId ou, como fallback, pelo numero do contato.
  _findConversation(zapId, chatIdOrNumber) {
    const zapConversations = this.conversations.get(String(zapId));
    if (!zapConversations) return null;
    if (chatIdOrNumber && zapConversations.has(chatIdOrNumber)) {
      return zapConversations.get(chatIdOrNumber);
    }
    const num = this._normNum(chatIdOrNumber);
    if (!num) return null;
    let found = null;
    zapConversations.forEach(conv => {
      if (found) return;
      const cn = this._normNum(conv.contact && conv.contact.number);
      if (cn && cn === num) found = conv;
    });
    return found;
  }

  _ensureConversation(zapId, target, extra) {
    const zid = String(zapId);
    if (!this.conversations.has(zid)) this.conversations.set(zid, new Map());
    const map = this.conversations.get(zid);
    let chatId = target && String(target).includes('@') ? String(target) : null;
    let conv = this._findConversation(zid, chatId || target);
    if (!conv) {
      const number = this._normNum(target);
      if (!chatId) chatId = `${number}@c.us`;
      const name = (extra && extra.name && !this._isNumericName(extra.name)) ? extra.name : (number || 'Contato');
      conv = {
        contact: { id: `${number}@s.whatsapp.net`, name, number },
        messages: [],
        lastMessage: null
      };
      map.set(chatId, conv);
    } else if (extra && extra.name && !this._isNumericName(extra.name) && this._isNumericName(conv.contact.name)) {
      conv.contact.name = extra.name;
    }
    if (!chatId) {
      const n = this._normNum(target) || (conv.contact && conv.contact.number) || '';
      chatId = n ? `${n}@c.us` : (target || '');
    }
    return { conv, chatId };
  }

  // Registra uma mensagem enviada (pela IA ou manualmente) no historico local e
  // avisa a UI em tempo real. `sentMsg` e o objeto do wwebjs (id opcional).
  _recordOutgoing(zapId, target, body, source, sentMsg, extra) {
    try {
      const e = extra || {};
      const { conv, chatId } = this._ensureConversation(zapId, (e.chatId || target), e);
      const number = this._normNum(target) || (conv.contact && conv.contact.number) || '';
      const id = (sentMsg && this._ensureMsgKey(sentMsg)) || `out-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const msg = {
        zapId,
        id,
        body: body || '',
        from: e.chatId || `${number}@c.us`,
        to: e.chatId || `${number}@c.us`,
        timestamp: e.timestamp || Math.floor(Date.now() / 1000),
        fromMe: true,
        isReply: source === 'ai',
        origin: source,
        hasMedia: !!e.hasMedia,
        contact: {
          id: `${number}@s.whatsapp.net`,
          name: conv.contact.name,
          number
        },
        chat: { id: chatId, name: conv.contact.name, isGroup: false }
      };
      conv.messages.push(msg);
      if (conv.messages.length > 200) conv.messages = conv.messages.slice(-200);
      conv.lastMessage = msg;
      this.persistContacts();
      this.sendToRenderer('whatsapp-message', msg);
      return msg;
    } catch (err) {
      console.warn('[CONV] Falha ao registrar mensagem enviada:', err.message);
      return null;
    }
  }

  // Busca o historico real do chat no WhatsApp (recebidas, suas e da IA) e
  // mescla com o que ja temos em memoria. Usado quando a tela abre a conversa.
  async fetchChatHistory(zapId, chatId, limit) {
    const zid = String(zapId);
    const cd = this.clients.get(zid);
    const conv = this._findConversation(zid, chatId);
    const memory = conv ? (conv.messages || []).slice() : [];

    if (!cd || !cd.client || !cd.client.pupPage) {
      return memory;
    }

    const targetId = this._normalizeChatId(chatId);
    let ids = [targetId];
    try {
      const resolved = await this._resolveSendTarget(cd.client, targetId);
      if (resolved && Array.isArray(resolved.ids) && resolved.ids.length) ids = resolved.ids;
    } catch (_) { /* usa o id cru */ }

    let fetched = [];
    for (const id of ids) {
      try {
        const chat = await cd.client.getChatById(id);
        if (!chat || typeof chat.fetchMessages !== 'function') continue;
        const msgs = await chat.fetchMessages({ limit: limit || 80 });
        if (Array.isArray(msgs) && msgs.length) {
          const skipTypes = ['e2e_notification', 'call_log', 'gp2', 'notification_template', 'protocol', 'revoked'];
          fetched = msgs
            .filter(m => {
              const t = m && m.type;
              if (t && skipTypes.indexOf(t) !== -1) return false;
              return (m && m.body) || (m && m.hasMedia) || t === 'image' || t === 'video' || t === 'audio' || t === 'ptt' || t === 'document' || t === 'sticker';
            })
            .map(m => ({
              id: this._ensureMsgKey(m),
              body: m.body || '',
              fromMe: !!m.fromMe,
              timestamp: m.timestamp || 0,
              hasMedia: !!m.hasMedia,
              origin: undefined
            }));
          break;
        }
      } catch (_) { /* tenta o proximo id */ }
    }

    if (!fetched.length) return memory;

    const byId = new Map();
    const withoutId = [];
    for (const m of fetched) {
      if (m.id) byId.set(m.id, m);
      else withoutId.push(m);
    }
    for (const m of memory) {
      if (m.id && byId.has(m.id)) {
        const existing = byId.get(m.id);
        existing.origin = m.origin;
        existing.isReply = m.isReply;
        if (!existing.body && m.body) existing.body = m.body;
      } else if (m.id) {
        byId.set(m.id, m);
      } else {
        withoutId.push(m);
      }
    }

    const merged = Array.from(byId.values()).concat(withoutId)
      .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    if (conv) {
      conv.messages = merged.slice(-200);
      if (merged.length) conv.lastMessage = merged[merged.length - 1];
      this.persistContacts();
    }

    return merged;
  }

  // ------------------------------------------------------------
  // Deteccao de "digitando" do CONTATO (presenca do WhatsApp Web)
  // Chamada pela UI ao abrir uma conversa. Faz polling leve apenas
  // do chat aberto e avisa o renderer quando o estado muda.
  // ------------------------------------------------------------
  setActiveChat(zapId, chatId) {
    if (!chatId) {
      this._activeChat = null;
      if (this._typingTimer) { clearInterval(this._typingTimer); this._typingTimer = null; }
      return;
    }
    const zid = String(zapId || '');
    if (!this._activeChat || this._activeChat.zapId !== zid || this._activeChat.chatId !== String(chatId)) {
      this._activeChat = { zapId: zid, chatId: String(chatId) };
      this._lastTypingState = false;
    }
    if (!this._typingTimer) {
      this._typingTimer = setInterval(() => this._pollActiveChatState().catch(() => {}), 2500);
      if (this._typingTimer && typeof this._typingTimer.unref === 'function') this._typingTimer.unref();
    }
  }

  async _pollActiveChatState() {
    const active = this._activeChat;
    if (!active) return;
    const cd = this.clients.get(active.zapId);
    if (!cd || !cd.client || !cd.client.pupPage) {
      if (this._lastTypingState) {
        this._lastTypingState = false;
        this.sendToRenderer('whatsapp-typing', { zapId: active.zapId, chatId: active.chatId, isTyping: false });
      }
      return;
    }
    let type = null;
    try {
      type = await cd.client.pupPage.evaluate((target) => {
        try {
          const norm = (v) => String(v || '').split('@')[0].replace(/:\d+$/, '').replace(/\D/g, '');
          const targetNum = norm(target);

          const readType = (presence) => {
            if (!presence) return null;
            try {
              if (presence.chatstate) {
                if (typeof presence.chatstate === 'string') return presence.chatstate;
                if (presence.chatstate.__x_type) return presence.chatstate.__x_type;
                if (presence.chatstate.attributes && presence.chatstate.attributes.type) return presence.chatstate.attributes.type;
              }
              if (presence.__x_chatstate && presence.__x_chatstate.__x_type) return presence.__x_chatstate.__x_type;
              if (presence.chatstates && typeof presence.chatstates.getModelsArray === 'function') {
                const arr = presence.chatstates.getModelsArray();
                const last = arr[arr.length - 1];
                if (last) return last.__x_type || (last.attributes && last.attributes.type) || null;
              }
            } catch (_) {}
            return null;
          };

          const matchId = (m) => {
            const id = m && m.id;
            const idSer = id && (id._serialized || (id.user ? `${id.user}@${id.server || 'c.us'}` : String(id)));
            if (!idSer) return false;
            return String(idSer) === String(target) || norm(idSer) === targetNum;
          };

          // Varios nomes possiveis do modulo de presenca no WhatsApp Web moderno
          const modNames = ['WAWebPresenceCollection', 'WAWebPresenceCollectionImpl', 'WAWebPresenceBridge'];
          for (const name of modNames) {
            try {
              const P = window.require(name);
              if (!P) continue;
              const arr = typeof P.getModelsArray === 'function'
                ? P.getModelsArray()
                : (P._models || P.models || []);
              if (!arr || !arr.length) continue;
              for (const m of arr) {
                if (matchId(m)) {
                  const t = readType(m);
                  if (t) return t;
                }
              }
            } catch (_) { /* modulo indisponivel */ }
          }

          // Fallback: alguns builds guardam o estado no proprio modelo de Chat
          try {
            const WFB = window.require('WAWebWidFactory');
            const chat = window.require('WAWebCollections').Chat.get(WFB.createWid(target));
            if (chat) {
              if (chat.chatstate) {
                if (typeof chat.chatstate === 'string') return chat.chatstate;
                if (chat.chatstate.__x_type) return chat.chatstate.__x_type;
                if (chat.chatstate.attributes && chat.chatstate.attributes.type) return chat.chatstate.attributes.type;
              }
            }
          } catch (_) { /* sem fallback */ }

          return null;
        } catch (_) {
          return null;
        }
      }, active.chatId);
    } catch (_) {
      return;
    }
    const t = String(type || '').toLowerCase();
    const isTyping = t === 'composing' || t === 'typing' || t === 'recording';
    if (isTyping !== this._lastTypingState) {
      this._lastTypingState = isTyping;
      this.sendToRenderer('whatsapp-typing', { zapId: active.zapId, chatId: active.chatId, isTyping });
    }
  }

  async disconnectZap(zapId, reason) {
    const clientData = this.clients.get(zapId);
    if (clientData) {
      this._stopPairingWatchdog(clientData.client); // para o polling antes de destruir
      try {
        // Remove os listeners ANTES do destroy: um evento tardio do cliente
        // antigo (disconnected/ready) nao pode sobrescrever o status do novo
        clientData.client.removeAllListeners();
      } catch (_) { /* ignore */ }
      this._detachPageListeners(clientData.client);
      try {
        await clientData.client.destroy();
      } catch (e) {
        console.error(`Erro ao desconectar Zap ${zapId}:`, e);
      }
      this.clients.delete(zapId);
      if (this._activeChat && this._activeChat.zapId === String(zapId)) this.setActiveChat('', '');
      if (reason) this.logToApp(zapId, 'warning', `Zap desconectado (${reason}).`);
      else this.logToApp(zapId, 'warning', 'Zap desconectado pelo usuario.');
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
    // Horario no arquivo de log (a UI ja exibe o hora do renderer) - essencial
    // para diagnosticar sequencia de eventos/conexao no electron-run.log
    const ts = new Date().toTimeString().slice(0, 8);
    console.log(`[${ts}][LOG][${type}] Zap ${zapId}: ${msg}`);
    this.sendToRenderer('whatsapp-log', { zapId, type, msg });
  }

  // Grava o codigo de pareamento em $LINK_CODE_FILE (JSON {zapId: {code, ts}})
  // para o monitor do GitHub Actions copiar ao repo privado de dados - la o
  // usuario le o codigo sem ele aparecer nos logs PUBLICOS do Actions.
  registerPairingCode(zapId, code) {
    const file = process.env.LINK_CODE_FILE;
    if (!file) return;
    try {
      let all = {};
      try { all = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
      if (!all || typeof all !== 'object' || Array.isArray(all)) all = {};
      all[String(zapId)] = { code: String(code || ''), ts: new Date().toISOString() };
      fs.writeFileSync(file, JSON.stringify(all, null, 2));
      console.log(`[PAIR] Codigo do zap ${zapId} gravado em ${file}`);
    } catch (e) {
      console.warn(`[PAIR] Falha ao gravar codigo em arquivo: ${e.message}`);
    }
  }

  // Texto do log do codigo: com LINK_HIDE_CODES=1 o codigo NUNCA vai ao
  // console (logs do Actions sao publicos); so o arquivo privado o tem.
  pairingLogMessage(code, suffix) {
    const tail = suffix ? ` ${suffix}` : '';
    if (String(process.env.LINK_HIDE_CODES || '') === '1') {
      return `Codigo de pareamento gerado (protegido - veja pairing-codes.json no repo de dados)${tail}`;
    }
    return `Codigo de pareamento gerado: ${code}${tail}`;
  }

  // PNG do QR em $LINK_CODE_DIR/qr-<zapId>.png (fallback visual do pareamento)
  saveQrPng(zapId, dataUrl) {
    const codeFile = process.env.LINK_CODE_FILE;
    if (!codeFile || !dataUrl) return;
    try {
      const dir = path.dirname(codeFile);
      const pngPath = path.join(dir, `qr-${zapId}.png`);
      const b64 = String(dataUrl).replace(/^data:image\/png;base64,/, '');
      fs.writeFileSync(pngPath, Buffer.from(b64, 'base64'));
    } catch (e) {
      console.warn(`[QR] Falha ao gravar PNG: ${e.message}`);
    }
  }

  // Aguarda uma promise com limite de tempo (evita evaluate travado por 180s
  // no protocolTimeout do puppeteer, que segurava requestPairingCode pendurado)
  _withTimeout(promise, ms, label) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} nao respondeu em ${ms / 1000}s`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
  }
}

module.exports = WhatsAppManager;
