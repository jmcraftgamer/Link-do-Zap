const { contextBridge, ipcRenderer } = require('electron');

// ---------------------------------------------------------------------------
// Modo local (padrao): tudo por IPC, o bot roda neste PC.
// Modo cliente remoto (LINK_API_URL definido): dados/WhatsApp/IA vao para a VPS
// via HTTP + WebSocket; controles da janela continuam locais.
// ---------------------------------------------------------------------------
const API_URL = String(process.env.LINK_API_URL || '').trim();
const API_PREFIX = String(process.env.LINK_API_PREFIX || '/api/v1');

function safeStorageKey(url) {
  return `link.api.token:${String(url || '').replace(/\/+$/, '')}`;
}

function createTokenStore(url) {
  let memory = '';
  const key = safeStorageKey(url);
  return {
    get() {
      try { return localStorage.getItem(key) || memory || ''; } catch (_) { return memory; }
    },
    set(value) {
      memory = String(value || '');
      try {
        if (memory) localStorage.setItem(key, memory);
        else localStorage.removeItem(key);
      } catch (_) { /* memoria serve para a sessao */ }
    }
  };
}

let remote = null;
if (API_URL) {
  const { createRemoteApi } = require('./src/js/api-client');
  remote = createRemoteApi({
    baseUrl: API_URL,
    apiPrefix: API_PREFIX,
    tokenStore: createTokenStore(API_URL)
  });
}

const localWindowApi = {
  // Window controls
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  startDrag: () => ipcRenderer.send('window-start-drag'),
  stopDrag: () => ipcRenderer.send('window-stop-drag'),
  dragMove: (x, y) => ipcRenderer.send('window-drag-move', x, y),
  focusWindow: () => ipcRenderer.send('window-focus'),
  nativeAlert: (msg) => ipcRenderer.sendSync('app-alert', msg),
  nativeConfirm: (msg) => ipcRenderer.sendSync('app-confirm', msg),

  // Conexao com o backend na VPS (sempre via processo principal)
  remoteConfigGet: () => ipcRenderer.invoke('remote-config-get'),
  remoteConfigTest: (url) => ipcRenderer.invoke('remote-config-test', url),
  remoteConfigSave: (data) => ipcRenderer.invoke('remote-config-save', data),
  remoteConfigDisable: () => ipcRenderer.invoke('remote-config-disable'),

  // Dialogos locais: o arquivo e escolhido no PC do usuario (funciona nos dois modos)
  pickZapIcon: () => ipcRenderer.invoke('pick-zap-icon'),
  serverRelaunch: () => ipcRenderer.invoke('server-relaunch')
};

const localDataApi = {
  // WhatsApp
  whatsappConnect: (zapId, phoneNumber, method) => ipcRenderer.invoke('whatsapp-connect', zapId, phoneNumber, method),
  whatsappDisconnect: (zapId) => ipcRenderer.invoke('whatsapp-disconnect', zapId),
  whatsappStatus: (zapId) => ipcRenderer.invoke('whatsapp-status', zapId),
  whatsappSend: (zapId, phone, text, chatId) => ipcRenderer.invoke('whatsapp-send', zapId, phone, text, chatId),
  whatsappSendMedia: (zapId, phone, media) => ipcRenderer.invoke('whatsapp-send-media', zapId, phone, media),
  whatsappConversations: (zapId) => ipcRenderer.invoke('whatsapp-conversations', zapId),
  whatsappMessages: (zapId, chatId) => ipcRenderer.invoke('whatsapp-messages', zapId, chatId),
  whatsappChatHistory: (zapId, chatId, limit) => ipcRenderer.invoke('whatsapp-chat-history', zapId, chatId, limit),
  whatsappChatMedia: (zapId, chatId, msgId, hint) => ipcRenderer.invoke('whatsapp-chat-media', zapId, chatId, msgId, hint),
  whatsappSetActiveChat: (zapId, chatId) => ipcRenderer.send('whatsapp-set-active-chat', zapId, chatId),

  // Sincronizacao com o servidor 24h (painel)
  serverInfo: () => ipcRenderer.invoke('server-info'),
  serverSyncNow: () => ipcRenderer.invoke('server-sync-now'),
  serverSyncStatus: () => ipcRenderer.invoke('server-sync-status'),
  serverDeleteZapSession: (zapId) => ipcRenderer.invoke('server-delete-zap-session', zapId),
  serverStatus: () => ipcRenderer.invoke('server-status'),
  serverPairingCodes: () => ipcRenderer.invoke('server-pairing-codes'),
  serverCurrentQr: (zapId) => ipcRenderer.invoke('server-current-qr', zapId),
  serverConnectZap: (zapId, phone) => ipcRenderer.invoke('server-connect-zap', zapId, phone),

  // Conexao do Setup ao servidor 24h (repositorio de dados)
  serverConfigGet: () => ipcRenderer.invoke('server-config-get'),
  serverConfigPick: () => ipcRenderer.invoke('server-config-pick'),
  serverConfigClone: (repoUrl, token) => ipcRenderer.invoke('server-config-clone', { repoUrl, token }),
  serverConfigDisable: () => ipcRenderer.invoke('server-config-disable'),

  // Painel de gerenciamento do servidor (status, power e terminal)
  serverOverview: () => ipcRenderer.invoke('server-overview'),
  serverPower: (running) => ipcRenderer.invoke('server-power', running),
  zapBlockAllExisting: (zapRef) => ipcRenderer.invoke('zap-block-all-existing', zapRef),
  onServerPowerUpdated: (callback) => ipcRenderer.on('server-power-updated', (e, data) => callback(data)),
  serverTerminalLogs: () => ipcRenderer.invoke('server-terminal-logs'),
  serverTerminalClear: () => ipcRenderer.invoke('server-terminal-clear'),
  serverTerminalExport: () => ipcRenderer.invoke('server-terminal-export'),
  serverCommand: (text) => ipcRenderer.invoke('server-command', text),
  onServerTerminalLog: (callback) => ipcRenderer.on('server-terminal-log', (e, data) => callback(data)),
  onServerTerminalCleared: (callback) => ipcRenderer.on('server-terminal-cleared', () => callback()),

  // Mensagem Automatica
  autoMsgState: () => ipcRenderer.invoke('auto-msg-state'),
  autoMsgChat: (payload) => ipcRenderer.invoke('auto-msg-chat', payload),
  autoMsgStop: () => ipcRenderer.invoke('auto-msg-stop'),
  autoMsgNote: (zapId, text) => ipcRenderer.invoke('auto-msg-note', { zapId, text }),
  autoMsgTranscribe: (audio, zapId) => ipcRenderer.invoke('auto-msg-transcribe', audio, zapId),
  onAutoMsgLog: (callback) => ipcRenderer.on('auto-msg-log', (e, data) => callback(data)),
  onAutoMsgUpdate: (callback) => ipcRenderer.on('auto-msg-update', (e, data) => callback(data)),

  // Agente IA do Dashboard
  agentChat: (payload) => ipcRenderer.invoke('agent-chat', payload),

  // WhatsApp events
  onWhatsAppPairingCode: (callback) => ipcRenderer.on('whatsapp-pairing-code', (e, data) => callback(data)),
  onWhatsAppStatus: (callback) => ipcRenderer.on('whatsapp-status', (e, data) => callback(data)),
  onWhatsAppMessage: (callback) => ipcRenderer.on('whatsapp-message', (e, data) => callback(data)),
  onWhatsAppTyping: (callback) => ipcRenderer.on('whatsapp-typing', (e, data) => callback(data)),
  onWhatsAppLog: (callback) => ipcRenderer.on('whatsapp-log', (e, data) => callback(data)),
  onWhatsAppContactsUpdated: (callback) => ipcRenderer.on('whatsapp-contacts-updated', (e, data) => callback(data)),

  // Data persistence
  loadZaps: () => ipcRenderer.invoke('load-zaps'),
  saveZaps: (data, opts) => ipcRenderer.invoke('save-zaps', data, opts),
  billingSave: (zapId, data) => ipcRenderer.invoke('billing-save', zapId, data),
  billingCheck: (zapId) => ipcRenderer.invoke('billing-check', zapId),
  loadProviders: () => ipcRenderer.invoke('load-providers'),
  saveProviders: (data) => ipcRenderer.invoke('save-providers', data),

  // Trainings
  loadTrainings: () => ipcRenderer.invoke('load-trainings'),
  saveTrainings: (data, deletedFiles) => ipcRenderer.invoke('save-trainings', data, deletedFiles || []),
  deleteTrainingsForZap: (zapId) => ipcRenderer.invoke('delete-trainings-for-zap', zapId)
};

function buildRemoteApi(api) {
  // Remove os objetos internos (nao serializaveis pelo contextBridge).
  // `pickZapIcon` e `serverRelaunch` ficam com a versao LOCAL (IPC): o dialogo
  // de arquivo e o restart acontecem no PC do usuario, nao na VPS.
  const { _http, _events, pickZapIcon, serverRelaunch, ...safe } = api;
  return {
    ...localWindowApi,
    ...safe,
    isRemoteMode: true,
    remoteAuth: {
      isRemoteMode: true,
      getServerUrl: () => safe.getServerUrl(),
      setServerUrl: (url) => safe.setServerUrl(url),
      hasToken: () => safe.hasToken(),
      login: (password) => safe.login(password),
      logout: () => safe.logout(),
      health: () => safe.health(),
      me: () => safe.me(),
      connectEvents: () => safe.connectEvents()
    }
  };
}

const exposed = remote
  ? buildRemoteApi(remote)
  : {
    ...localWindowApi,
    ...localDataApi,
    isRemoteMode: false,
    remoteAuth: null
  };

contextBridge.exposeInMainWorld('electronAPI', exposed);
