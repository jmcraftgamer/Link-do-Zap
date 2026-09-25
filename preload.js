const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  startDrag: () => ipcRenderer.send('window-start-drag'),
  stopDrag: () => ipcRenderer.send('window-stop-drag'),
  dragMove: (x, y) => ipcRenderer.send('window-drag-move', x, y),
  focusWindow: () => ipcRenderer.send('window-focus'),

  // WhatsApp
  whatsappConnect: (zapId, phoneNumber, method) => ipcRenderer.invoke('whatsapp-connect', zapId, phoneNumber, method),
  whatsappDisconnect: (zapId) => ipcRenderer.invoke('whatsapp-disconnect', zapId),
  whatsappStatus: (zapId) => ipcRenderer.invoke('whatsapp-status', zapId),
  whatsappSend: (zapId, phone, text) => ipcRenderer.invoke('whatsapp-send', zapId, phone, text),
  whatsappConversations: (zapId) => ipcRenderer.invoke('whatsapp-conversations', zapId),
  whatsappMessages: (zapId, chatId) => ipcRenderer.invoke('whatsapp-messages', zapId, chatId),

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
