// Cliente do backend remoto.
// Implementa a MESMA superficie do `electronAPI` (preload), mas falando
// HTTP/WebSocket com a VPS. Roda no preload (Electron) e tambem em Node puro.
const http = require('http');
const https = require('https');
const { URL } = require('url');

function trimSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

function encodePath(value) {
  return encodeURIComponent(String(value == null ? '' : value));
}

// Operacoes de IA/audio podem demorar bem mais que uma chamada comum.
const DEFAULT_TIMEOUT_MS = 120000;
const HEAVY_TIMEOUT_MS = 180000;
const HEALTH_TIMEOUT_MS = 8000;

function createHttpClient(options) {
  const getToken = options.getToken || (() => '');
  const onUnauthorized = options.onUnauthorized || (() => {});

  function request(method, path, body, requestOptions) {
    const base = trimSlash(options.getBaseUrl());
    if (!base) return Promise.reject(new Error('servidor nao configurado'));
    const url = new URL(base + path);
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { Accept: 'application/json' };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (payload != null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const mod = url.protocol === 'https:' ? https : http;
    const timeoutMs = Number(requestOptions && requestOptions.timeoutMs) ||
      Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      const req = mod.request(
        {
          method,
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + url.search,
          headers
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed = null;
            if (text) {
              try { parsed = JSON.parse(text); } catch (_) { parsed = text; }
            }
            if (res.statusCode === 401 && !(requestOptions && requestOptions.skipAuthEvent)) onUnauthorized();
            if (res.statusCode >= 400) {
              const err = new Error((parsed && parsed.error) || `HTTP ${res.statusCode}`);
              err.status = res.statusCode;
              err.body = parsed;
              return reject(err);
            }
            resolve(parsed);
          });
        }
      );
      req.on('error', reject);
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error('tempo esgotado ao falar com o servidor'));
      });
      if (payload != null) req.write(payload);
      req.end();
    });
  }

  return {
    get: (p, o) => request('GET', p, undefined, o),
    post: (p, b, o) => request('POST', p, b === undefined ? {} : b, o),
    put: (p, b, o) => request('PUT', p, b === undefined ? {} : b, o),
    patch: (p, b, o) => request('PATCH', p, b === undefined ? {} : b, o),
    del: (p, o) => request('DELETE', p, undefined, o),
    request
  };
}

// WebSocket de eventos com reconexao automatica e assinatura por evento.
function createEventSocket(options) {
  const listeners = new Map();
  let ws = null;
  let closedByUser = false;
  let attempts = 0;
  let reconnectTimer = null;
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  let WebSocketImpl = options.WebSocket;
  if (!WebSocketImpl) {
    try { WebSocketImpl = require('ws'); } catch (_) { WebSocketImpl = null; }
  }

  function emit(event, data) {
    const set = listeners.get(event);
    if (set) for (const cb of [...set]) { try { cb(data); } catch (_) {} }
    const all = listeners.get('*');
    if (all) for (const cb of [...all]) { try { cb(event, data); } catch (_) {} }
  }

  function on(event, cb) {
    if (typeof cb !== 'function') return () => {};
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(cb);
    return () => {
      const set = listeners.get(event);
      if (set) set.delete(cb);
    };
  }

  function buildUrl() {
    const base = trimSlash(options.getBaseUrl());
    if (!base) return null;
    const url = new URL(base);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = (url.pathname.replace(/\/+$/, '') || '') + '/ws';
    const token = options.getToken();
    if (token) url.searchParams.set('token', token);
    return url.toString();
  }

  function scheduleReconnect() {
    if (closedByUser) return;
    attempts++;
    const delay = Math.min(15000, 1000 * Math.pow(2, Math.min(attempts, 4)));
    reconnectTimer = setTimer(connect, delay);
    if (reconnectTimer.unref) reconnectTimer.unref();
  }

  function connect() {
    if (closedByUser || !WebSocketImpl) return;
    const url = buildUrl();
    if (!url) return;
    try {
      ws = new WebSocketImpl(url);
    } catch (_) {
      scheduleReconnect();
      return;
    }
    ws.on('open', () => {
      attempts = 0;
      emit('connection', { connected: true });
    });
    ws.on('message', (buf) => {
      let msg;
      try { msg = JSON.parse(String(buf)); } catch (_) { return; }
      if (msg && msg.event) emit(msg.event, msg.data);
    });
    ws.on('close', () => {
      emit('connection', { connected: false });
      ws = null;
      scheduleReconnect();
    });
    ws.on('error', () => {});
  }

  function start() { closedByUser = false; connect(); }
  function stop() {
    closedByUser = true;
    if (reconnectTimer) clearTimer(reconnectTimer);
    reconnectTimer = null;
    if (ws) { try { ws.close(); } catch (_) {} ws = null; }
  }
  function send(command, payload, id) {
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(JSON.stringify({ command, payload, id })); return true; } catch (_) { return false; }
  }
  function isOpen() { return !!ws && ws.readyState === 1; }

  return { on, start, stop, send, isOpen, listeners, emit };
}

function createRemoteApi(options) {
  const baseUrl = options.baseUrl;
  const tokenStore = options.tokenStore || { get: () => '', set: () => {} };
  let currentBase = trimSlash(options.baseUrl);
  const events = options.eventSocket || createEventSocket({
    getBaseUrl: () => currentBase,
    getToken: () => tokenStore.get(),
    WebSocket: options.WebSocket,
    setTimeout: options.setTimeout,
    clearTimeout: options.clearTimeout
  });
  const httpClient = options.httpClient || createHttpClient({
    getBaseUrl: () => currentBase,
    getToken: () => tokenStore.get(),
    onUnauthorized: () => {
      tokenStore.set('');
      // O painel escuta este evento para voltar ao gate sem recarregar a pagina.
      if (typeof events.emit === 'function') {
        try { events.emit('auth-expired', {}); } catch (_) {}
      }
    },
    timeoutMs: options.timeoutMs
  });

  function authPath() {
    return options.apiPrefix || '/api/v1';
  }
  const api = (p) => authPath() + p;

  // Eventos agrupados por canal, como no IPC local.
  function subscribe(channel, cb) {
    const unsub = events.on(channel, cb);
    // O gate do Setup chama isso antes de conectar; garante o socket ligado.
    if (!events.isOpen()) events.start();
    return () => { unsub(); };
  }

  const remote = {
    // ---------------------------------------------------------- identificacao
    isRemoteMode: true,
    getServerUrl: () => currentBase,
    setServerUrl: (url) => {
      currentBase = trimSlash(url);
      tokenStore.set('');
      events.stop();
      events.start();
      return currentBase;
    },
    hasToken: () => !!tokenStore.get(),
    login: async (password) => {
      // 401 no login significa senha errada, nao sessao expirada.
      const res = await httpClient.post(api('/auth/login'), { password }, { skipAuthEvent: true });
      if (res && res.token) {
        tokenStore.set(res.token);
        events.stop();
        events.start();
      }
      return res;
    },
    logout: () => {
      tokenStore.set('');
      events.stop();
    },
    me: () => httpClient.get(api('/me'), { timeoutMs: 20000 }),
    health: () => httpClient.get('/health', { timeoutMs: HEALTH_TIMEOUT_MS }),
    connectEvents: () => events.start(),

    // ---------------------------------------------------------- WhatsApp
    whatsappConnect: (zapId, phone, method) => httpClient.post(api(`/zaps/${encodePath(zapId)}/connect`), { phone, method }),
    whatsappDisconnect: (zapId) => httpClient.post(api(`/zaps/${encodePath(zapId)}/disconnect`)),
    whatsappStatus: (zapId) => httpClient.get(api(`/zaps/${encodePath(zapId)}/status`)),
    whatsappSend: (zapId, phone, text, chatId) =>
      httpClient.post(api(`/zaps/${encodePath(zapId)}/send`), { phone, chatId: chatId || phone, text },
        { timeoutMs: HEAVY_TIMEOUT_MS }),
    whatsappSendMedia: (zapId, phone, media) =>
      httpClient.post(api(`/zaps/${encodePath(zapId)}/send-media`), { phone, media },
        { timeoutMs: HEAVY_TIMEOUT_MS }),
    whatsappConversations: (zapId) => httpClient.get(api(`/zaps/${encodePath(zapId)}/conversations`)),
    whatsappMessages: (zapId, chatId) =>
      httpClient.get(api(`/zaps/${encodePath(zapId)}/conversations/${encodePath(chatId)}/messages`)),
    whatsappChatHistory: (zapId, chatId, limit) =>
      httpClient.get(api(`/zaps/${encodePath(zapId)}/conversations/${encodePath(chatId)}/history?limit=${Number(limit) || 50}`)),
    whatsappChatMedia: (zapId, chatId, msgId, hint) =>
      httpClient.get(api(`/zaps/${encodePath(zapId)}/conversations/${encodePath(chatId)}/media/${encodePath(msgId)}`) +
        (hint ? `?hint=${encodePath(hint)}` : '')),
    whatsappSetActiveChat: (zapId, chatId) =>
      httpClient.post(api(`/zaps/${encodePath(zapId)}/conversations/${encodePath(chatId)}/active`)).catch(() => ({})),
    pickZapIcon: () => Promise.resolve({ canceled: true, error: 'Escolha de arquivo indisponivel no modo servidor' }),
    zapBlockAllExisting: (zapRef) =>
      httpClient.post(api(`/zaps/${encodePath(zapRef && zapRef.id ? zapRef.id : zapRef)}/contacts/block-all-existing`)),

    // ---------------------------------------------------------- servidor
    serverInfo: () => Promise.resolve({
      mode: 'remote',
      url: currentBase,
      enabled: true,
      dataDir: null
    }),
    serverSyncNow: () => httpClient.post(api('/server/sync-now')),
    serverSyncStatus: () => httpClient.get(api('/server/sync-status')),
    serverDeleteZapSession: (zapId) => httpClient.del(api(`/zaps/${encodePath(zapId)}/session`)),
    serverStatus: () => httpClient.get(api('/server/status')),
    serverOverview: () => httpClient.get(api('/server/overview')),
    serverPower: (running) => httpClient.post(api('/server/power'), { running: !!running }),
    serverRestart: () => httpClient.post(api('/server/restart')),
    serverPairingCodes: () => Promise.resolve({}),
    serverCurrentQr: (zapId) => httpClient.get(api(`/zaps/${encodePath(zapId)}/qr`)),
    serverConnectZap: (zapId, phone) => httpClient.post(api(`/zaps/${encodePath(zapId)}/connect`), { phone, method: 'pairing' }),
    serverConfigGet: () => Promise.resolve({ mode: 'remote', url: currentBase, enabled: true }),
    serverConfigPick: () => Promise.resolve({ ok: false, error: 'No modo servidor a pasta de dados fica na VPS.' }),
    serverConfigClone: () => Promise.resolve({ ok: false, error: 'No modo servidor a pasta de dados fica na VPS.' }),
    serverConfigDisable: () => Promise.resolve({ ok: false, error: 'No modo servidor a pasta de dados fica na VPS.' }),
    serverRelaunch: () => Promise.resolve({ ok: false, error: 'Reinicie o servico na VPS.' }),
    serverTerminalLogs: () => httpClient.get(api('/logs?limit=20000')).then((r) => (r && r.lines) || []),
    serverTerminalClear: () => httpClient.del(api('/logs')),
    serverTerminalExport: () => httpClient.get(api('/logs?limit=5000')).then((r) => (r && r.lines) || []),
    serverCommand: (text) => httpClient.post(api('/commands'), { command: text }),

    // ---------------------------------------------------------- mensagem automatica
    autoMsgState: () => httpClient.get(api('/auto-message/state')),
    autoMsgChat: (payload) => httpClient.post(api('/auto-message/chat'), payload || {},
      { timeoutMs: HEAVY_TIMEOUT_MS }),
    autoMsgStop: () => httpClient.post(api('/auto-message/stop')),
    autoMsgNote: (zapId, text) => httpClient.post(api('/auto-message/note'), { zapId, text }),
    autoMsgTranscribe: (audio, zapId) => httpClient.post(api('/auto-message/transcribe'), { audio, zapId },
      { timeoutMs: HEAVY_TIMEOUT_MS }),

    // ---------------------------------------------------------- agente
    agentChat: (payload) => httpClient.post(api('/agent/chat'), payload || {},
      { timeoutMs: HEAVY_TIMEOUT_MS }),

    // ---------------------------------------------------------- dados
    loadZaps: () => httpClient.get(api('/zaps')),
    saveZaps: (data, opts) => httpClient.put(api('/zaps'), { zaps: data, allowEmpty: !!(opts && opts.allowEmpty) })
      .then((r) => ({ ok: true, ...r })),
    billingSave: (zapId, data) => httpClient.put(api(`/zaps/${encodePath(zapId)}/billing`), data || {}),
    billingCheck: (zapId) => httpClient.get(api(`/zaps/${encodePath(zapId)}/billing`)),
    loadProviders: () => httpClient.get(api('/providers')),
    saveProviders: (data) => httpClient.put(api('/providers'), { providers: data }),
    loadTrainings: () => httpClient.get(api('/trainings')),
    saveTrainings: (data, deletedFiles) =>
      httpClient.put(api('/trainings'), { trainings: data, deletedFiles: deletedFiles || [] }),
    deleteTrainingsForZap: (zapId) => httpClient.del(api(`/zaps/${encodePath(zapId)}/trainings`)),

    // ---------------------------------------------------------- eventos
    onWhatsAppPairingCode: (cb) => subscribe('whatsapp-pairing-code', cb),
    onWhatsAppStatus: (cb) => subscribe('whatsapp-status', cb),
    onWhatsAppMessage: (cb) => subscribe('whatsapp-message', cb),
    onWhatsAppTyping: (cb) => subscribe('whatsapp-typing', cb),
    onWhatsAppLog: (cb) => subscribe('whatsapp-log', cb),
    onWhatsAppContactsUpdated: (cb) => subscribe('whatsapp-contacts-updated', cb),
    onServerTerminalLog: (cb) => subscribe('server-terminal-log', cb),
    onServerTerminalCleared: (cb) => subscribe('server-terminal-cleared', cb),
    onServerPowerUpdated: (cb) => subscribe('server-power-updated', cb),
    onAutoMsgLog: (cb) => subscribe('auto-msg-log', cb),
    onAutoMsgUpdate: (cb) => subscribe('auto-msg-update', cb),
    onConnectionChange: (cb) => subscribe('connection', cb),
    onAuthExpired: (cb) => subscribe('auth-expired', cb),

    // expostos para diagnostico
    _http: httpClient,
    _events: events
  };

  if (baseUrl && tokenStore.get()) events.start();
  return remote;
}

const TIMEOUTS = {
  defaultMs: DEFAULT_TIMEOUT_MS,
  heavyMs: HEAVY_TIMEOUT_MS,
  healthMs: HEALTH_TIMEOUT_MS
};

module.exports = { createRemoteApi, createHttpClient, createEventSocket, trimSlash, TIMEOUTS };
