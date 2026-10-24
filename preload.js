const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Chaves de IA fora do codigo (env do sistema / secrets do GitHub Actions)
  bootstrapKeys: {
    openrouter: process.env.OPENROUTER_API_KEY || '',
    googleai: process.env.GOOGLE_AI_KEY || ''
  },

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

  // WhatsApp
  whatsappConnect: (zapId, phoneNumber, method) => ipcRenderer.invoke('whatsapp-connect', zapId, phoneNumber, method),
  whatsappDisconnect: (zapId) => ipcRenderer.invoke('whatsapp-disconnect', zapId),
  whatsappStatus: (zapId) => ipcRenderer.invoke('whatsapp-status', zapId),
  whatsappSend: (zapId, phone, text, chatId) => ipcRenderer.invoke('whatsapp-send', zapId, phone, text, chatId),
  whatsappSendMedia: (zapId, phone, media) => ipcRenderer.invoke('whatsapp-send-media', zapId, phone, media),
  whatsappConversations: (zapId) => ipcRenderer.invoke('whatsapp-conversations', zapId),
  whatsappMessages: (zapId, chatId) => ipcRenderer.invoke('whatsapp-messages', zapId, chatId),
  whatsappChatHistory: (zapId, chatId, limit) => ipcRenderer.invoke('whatsapp-chat-history', zapId, chatId, limit),
  whatsappSetActiveChat: (zapId, chatId) => ipcRenderer.send('whatsapp-set-active-chat', zapId, chatId),
  pickZapIcon: () => ipcRenderer.invoke('pick-zap-icon'),

  // Sincronizacao com o servidor 24h (painel)
  serverInfo: () => ipcRenderer.invoke('server-info'),
  serverSyncNow: () => ipcRenderer.invoke('server-sync-now'),
  serverSyncStatus: () => ipcRenderer.invoke('server-sync-status'),
  serverDeleteZapSession: (zapId) => ipcRenderer.invoke('server-delete-zap-session', zapId),
  serverStatus: () => ipcRenderer.invoke('server-status'),
  serverPairingCodes: () => ipcRenderer.invoke('server-pairing-codes'),

  // Conexao do Setup ao servidor 24h (repositorio de dados)
  serverConfigGet: () => ipcRenderer.invoke('server-config-get'),
  serverConfigPick: () => ipcRenderer.invoke('server-config-pick'),
  serverConfigClone: (repoUrl, token) => ipcRenderer.invoke('server-config-clone', { repoUrl, token }),
  serverConfigDisable: () => ipcRenderer.invoke('server-config-disable'),
  serverRelaunch: () => ipcRenderer.invoke('server-relaunch'),

  // Painel de gerenciamento do servidor (status, power e terminal)
  serverOverview: () => ipcRenderer.invoke('server-overview'),
  serverPower: (running) => ipcRenderer.invoke('server-power', running),
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
  onWhatsAppQR: (callback) => ipcRenderer.on('whatsapp-qr', (e, data) => callback(data)),
  onWhatsAppPairingCode: (callback) => ipcRenderer.on('whatsapp-pairing-code', (e, data) => callback(data)),
  onWhatsAppStatus: (callback) => ipcRenderer.on('whatsapp-status', (e, data) => callback(data)),
  onWhatsAppMessage: (callback) => ipcRenderer.on('whatsapp-message', (e, data) => callback(data)),
  onWhatsAppTyping: (callback) => ipcRenderer.on('whatsapp-typing', (e, data) => callback(data)),
  onWhatsAppLog: (callback) => ipcRenderer.on('whatsapp-log', (e, data) => callback(data)),
  onWhatsAppContactsUpdated: (callback) => ipcRenderer.on('whatsapp-contacts-updated', (e, data) => callback(data)),

  // Data persistence
  loadZaps: () => ipcRenderer.invoke('load-zaps'),
  saveZaps: (data) => ipcRenderer.invoke('save-zaps', data),
  loadProviders: () => ipcRenderer.invoke('load-providers'),
  saveProviders: (data) => ipcRenderer.invoke('save-providers', data),

  // Trainings
  loadTrainings: () => ipcRenderer.invoke('load-trainings'),
  saveTrainings: (data, deletedFiles) => ipcRenderer.invoke('save-trainings', data, deletedFiles || []),
  deleteTrainingsForZap: (zapId) => ipcRenderer.invoke('delete-trainings-for-zap', zapId)
});
