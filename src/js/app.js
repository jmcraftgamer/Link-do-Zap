// ============================================
// Link no WhatsApp - App Logic
// ============================================

function safeParseLS(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    console.warn('localStorage parse falhou para', key, e.message);
    try { localStorage.removeItem(key); } catch (_) {}
    return fallback;
  }
}
// Load from localStorage or start empty (safe)
let zapsData = safeParseLS('linknozap_zaps', []);
let providersData = safeParseLS('linknozap_providers', []);

// Training state
let trainingsData = {};
let currentTrainingZapId = null;
let editingTrainingId = null;
let modalPendingImages = [];
let modalDeletedFiles = [];

// ============================================
// Token & Usage Tracking
// ============================================
function trackUsage(zapId, tokens, messageCount) {
  const zap = zapsData.find(z => String(z.id) === String(zapId));
  if (!zap) return;

  const now = Math.floor(Date.now() / 1000);

  if (!zap.tokenHistory) zap.tokenHistory = [];
  if (!zap.usageHistory) zap.usageHistory = [];
  if (!zap.tokensUsed) zap.tokensUsed = 0;
  if (!zap.messageCount) zap.messageCount = 0;

  zap.tokensUsed += tokens;
  zap.messageCount += messageCount;

  zap.tokenHistory.push({ x: now, y: zap.tokensUsed });
  zap.usageHistory.push({ x: now, y: zap.messageCount });

  // Keep last 50 points
  if (zap.tokenHistory.length > 50) zap.tokenHistory = zap.tokenHistory.slice(-50);
  if (zap.usageHistory.length > 50) zap.usageHistory = zap.usageHistory.slice(-50);

  saveZaps();

  // Refresh panel charts if open
  if (currentPanelZapId && String(currentPanelZapId) === String(zapId)) {
    renderPanelCharts(zap);
  }
}

// Estimate tokens from text (~4 chars per token)
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

// ============================================
// Log system - stores logs per zap
// ============================================
const zapLogs = {};

function addLog(zapId, type, msg) {
  if (!zapLogs[zapId]) zapLogs[zapId] = [];
  const time = new Date().toLocaleTimeString('pt-BR');
  zapLogs[zapId].push({ time, type, msg });

  // Keep only last 200 entries
  if (zapLogs[zapId].length > 200) {
    zapLogs[zapId] = zapLogs[zapId].slice(-200);
  }

  // Update modal if open
  const logContainer = document.getElementById('logContainer');
  const logModal = document.getElementById('logModal');
  if (logContainer && logModal && logModal.classList.contains('active') && logContainer.dataset.zapId === String(zapId)) {
    appendLogEntry(logContainer, { time, type, msg });
    logContainer.scrollTop = logContainer.scrollHeight;
  }
}

function appendLogEntry(container, entry) {
  const div = document.createElement('div');
  div.className = 'log-entry';
  const tagLabels = {
    info: 'INFO', success: 'OK', error: 'ERRO', warning: 'AVISO',
    incoming: 'CHEGOU', outgoing: 'ENVIOU', ai: 'IA', debug: 'DEBUG'
  };
  div.innerHTML = `<span class="log-time">${entry.time}</span><span class="log-tag ${entry.type}">[${tagLabels[entry.type] || entry.type}]</span><span class="log-msg">${entry.msg}</span>`;
  container.appendChild(div);
}

// Pre-configured OpenRouter provider
const OPENROUTER_PRECONFIGURED = {
  id: 'openrouter-preconfig',
  name: 'OpenRouter',
  apiKey: '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',
  models: [
    { id: 'openrouter/free', name: 'OpenRouter Free Models Router (Roteador automtico)', free: true },
    { id: 'qwen/qwen3.8-27b:free', name: 'Qwen3.8 27B', free: true },
    { id: 'z-ai/glm-5.2:free', name: 'GLM 5.2', free: true },
    { id: 'google/gemma-4-31b-it:free', name: 'Gemma 4 31B IT', free: true },
    { id: 'google/gemma-4-26b-a4b-it:free', name: 'Gemma 4 26B A4B IT', free: true },
    { id: 'thinkingmachines/inkling:free', name: 'Thinking Machines Inkling', free: true },
    { id: 'thinkingmachines/inkling-small:free', name: 'Thinking Machines Inkling Small', free: true },
    { id: 'inclusionai/ling-3.0-flash-vl:free', name: 'Ling 3.0 Flash VL', free: true },
    { id: 'inclusionai/ling-3.0-flash-fin:free', name: 'Ling 3.0 Flash Fin', free: true },
    { id: 'inclusionai/ling-3.0-flash-sante:free', name: 'Ling 3.0 Flash Sade', free: true },
    { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', name: 'NVIDIA Nemotron 3 Ultra 550B', free: true },
    { id: 'nvidia/nemotron-3-super-120b-a12b:free', name: 'NVIDIA Nemotron 3 Super 120B', free: true },
    { id: 'nvidia/nemotron-3.5-lightning:free', name: 'NVIDIA Nemotron 3.5 Lightning', free: true },
    { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', name: 'NVIDIA Nemotron 3 Nano Omni 30B', free: true },
    { id: 'nvidia/nemotron-3.5-content-safety:free', name: 'NVIDIA Nemotron 3.5 Content Safety', free: true },
    { id: 'poolside/laguna-s-2.1:free', name: 'Poolside Laguna S 2.1', free: true },
    { id: 'poolside/laguna-xs-2.1:free', name: 'Poolside Laguna XS 2.1', free: true },
    { id: 'dots-studio/dots-3-note-preview:free', name: 'Dots3 Note Preview', free: true },
    { id: 'nex-agi/nex-n2.5-pro:free', name: 'Nex N2.5 Pro', free: true },
    { id: 'nex-agi/nex-n2.5-mini:free', name: 'Nex N2.5 Mini', free: true },
    { id: 'cohere/north-mini-code:free', name: 'Cohere North Mini Code', free: true },
    { id: 'liquid/lfm-2.5-2.6b:free', name: 'Liquid LFM 2.5 2.6B', free: true }
  ],
  createdAt: new Date().toISOString(),
  preconfigured: true
};

// Add pre-configured provider if not exists
if (!providersData.find(p => p.id === 'openrouter-preconfig')) {
  providersData.unshift(OPENROUTER_PRECONFIGURED);
  localStorage.setItem('linknozap_providers', JSON.stringify(providersData));
}

// Pre-configured Google AI Studio provider
const GOOGLEAI_PRECONFIGURED = {
  id: 'googleai-preconfig',
  name: 'Google AI Studio',
  apiKey: 'AQ.Ab8RN6IbhT9Czr8ReEDxIwKlOwWZCs6AflBuQNn4mk7mBthc8g',
  models: [
    { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', free: true, limits: '10 RPM | 250k TPM | 250 RPD' },
    { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash-Lite', free: true, limits: '15 RPM | 250k TPM | 1.000 RPD' },
    { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash-Lite', free: true, limits: '15 RPM | 250k TPM | 1.000 RPD' }
  ],
  createdAt: new Date().toISOString(),
  preconfigured: true
};

if (!providersData.find(p => p.id === 'googleai-preconfig')) {
  providersData.unshift(GOOGLEAI_PRECONFIGURED);
  localStorage.setItem('linknozap_providers', JSON.stringify(providersData));
}

// DOM Elements
const menuItems = document.querySelectorAll('.menu-item');
const pages = document.querySelectorAll('.page');
const zapsList = document.getElementById('zapsList');
const searchInput = document.getElementById('searchInput');
const addZapBtn = document.getElementById('addZapBtn');
const listZapsBtn = document.getElementById('listZapsBtn');
const addZapModal = document.getElementById('addZapModal');
const closeModalBtn = document.getElementById('closeModal');
const cancelAdd = document.getElementById('cancelAdd');
const confirmAdd = document.getElementById('confirmAdd');

// Window Controls
const minimizeBtn = document.getElementById('minimizeBtn');
const maximizeBtn = document.getElementById('maximizeBtn');
const closeBtn = document.getElementById('closeBtn');

// ============================================
// Real Status System
// ============================================
function getZapStatusInfo(zap) {
  if (zap.enabled === false) {
    return { label: 'Desativado', className: 'disabled', online: false };
  }
  const rs = zap.runtimeStatus || 'disconnected';
  const map = {
    ready: { label: 'Funcionando', className: 'online', online: true },
    connecting: { label: 'Conectando...', className: 'connecting', online: false },
    waiting_qr: { label: 'Aguardando QR', className: 'connecting', online: false },
    waiting_pairing: { label: 'Aguardando pareamento', className: 'connecting', online: false },
    authenticated: { label: 'Autenticado', className: 'connecting', online: false },
    auth_failure: { label: 'Erro de autenticacao', className: 'error', online: false },
    disconnected: { label: 'Desconectado', className: 'offline', online: false }
  };
  return map[rs] || map.disconnected;
}

function applyRuntimeStatus(zap, runtimeStatus) {
  zap.runtimeStatus = runtimeStatus;
  const info = getZapStatusInfo(zap);
  zap.status = info.label;
  zap.statusClass = info.className;
  return info;
}

async function refreshAllZapStatuses() {
  if (!window.electronAPI || !zapsData.length) return;

  let changed = false;
  for (const zap of zapsData) {
    try {
      const st = await window.electronAPI.whatsappStatus(String(zap.id));
      const prev = zap.runtimeStatus;
      const next = (st && st.status) || 'disconnected';
      if (prev !== next) {
        applyRuntimeStatus(zap, next);
        addLog(zap.id, next === 'ready' ? 'success' : (next === 'disconnected' ? 'warning' : 'info'), `Status alterado: ${prev || 'desconhecido'} -> ${next} (poll)`);
        changed = true;
      }
    } catch (e) {
      if (zap.runtimeStatus !== 'disconnected') {
        const prevDisc = zap.runtimeStatus;
        applyRuntimeStatus(zap, 'disconnected');
        addLog(zap.id, 'warning', `Status alterado: ${prevDisc || 'desconhecido'} -> disconnected (erro poll)`);
        changed = true;
      }
    }
  }

  if (changed) {
    saveZaps();
    renderZaps(zapsData);
    if (currentPanelZapId != null) {
      refreshPanelStatusUI(currentPanelZapId);
    }
  }
}

function refreshPanelStatusUI(zapId) {
  const zap = zapsData.find(z => String(z.id) === String(zapId));
  if (!zap) return;

  const statusEl = document.getElementById('zapPanelStatus');
  const info = getZapStatusInfo(zap);
  statusEl.className = 'zap-card-status ' + info.className;
  statusEl.innerHTML = `<span class="dot"></span> ${info.label}`;

  const enabledCb = document.getElementById('panelEnabled');
  if (enabledCb) enabledCb.checked = zap.enabled !== false;
  const enabledLabel = document.getElementById('panelEnabledLabel');
  if (enabledLabel) enabledLabel.textContent = zap.enabled !== false ? 'Ativo' : 'Desativado';

  const connectBtn = document.getElementById('zapPanelConnect');
  if (info.online) {
    connectBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Desconectar`;
    connectBtn.className = 'zap-panel-connect-btn disconnect';
    connectBtn.onclick = () => { disconnectZap(zap.id); };
  } else {
    connectBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg> Conectar`;
    connectBtn.className = 'zap-panel-connect-btn';
    connectBtn.onclick = () => { openConnectModal(zap.id, zap.name, zap.phone); };
  }
}

// ============================================
// Save / Load
// ============================================
function saveZaps() {
  localStorage.setItem('linknozap_zaps', JSON.stringify(zapsData));
  if (window.electronAPI && window.electronAPI.saveZaps) {
    window.electronAPI.saveZaps(zapsData);
  }
}

function saveProviders() {
  localStorage.setItem('linknozap_providers', JSON.stringify(providersData));
  if (window.electronAPI && window.electronAPI.saveProviders) {
    window.electronAPI.saveProviders(providersData);
  }
}

// ============================================
// Initialize
// ============================================
function init() {
  // Migrate old zaps: ensure enabled field exists, don't trust stale status
  zapsData.forEach(zap => {
    if (zap.enabled === undefined) zap.enabled = true;
    // Stale "Online" from disk is a lie after app restart - will be refreshed
    if (zap.status === 'Online' && !zap.runtimeStatus) {
      zap.runtimeStatus = 'disconnected';
      applyRuntimeStatus(zap, 'disconnected');
    } else if (zap.runtimeStatus) {
      applyRuntimeStatus(zap, zap.runtimeStatus);
    } else {
      applyRuntimeStatus(zap, 'disconnected');
    }
  });

  renderZaps(zapsData);
  setupEventListeners();
  initProviders();
  initProviderConfig();

  // Force sync all data to main process files
  if (window.electronAPI) {
    window.electronAPI.saveZaps(zapsData);
    window.electronAPI.saveProviders(providersData);

    window.electronAPI.loadTrainings().then(data => {
      trainingsData = data || {};
      renderTrainingZapsList();
      if (currentTrainingZapId != null) renderTrainingsList();
    }).catch(() => {
      trainingsData = {};
    });

    // Query real connection status for all zaps
    setTimeout(() => {
      refreshAllZapStatuses();
      // Poll every 10s (reduced from 5s to lower IPC/disk load), only for enabled zaps
      setInterval(refreshAllZapStatuses, 10000);
    }, 800);
  }
}

// ============================================
// Render Zaps
// ============================================
function renderZaps(zaps) {
  zapsList.innerHTML = '';

  if (zaps.length === 0) {
    zapsList.innerHTML = '<p style="color: #999; font-size: 14px; text-align: center; padding: 40px 0;">Nenhum Zap adicionado ainda.</p>';
    return;
  }

  zaps.forEach(zap => {
    const card = createZapCard(zap);
    zapsList.appendChild(card);
  });
}

// ============================================
// Create Zap Card - Minimal
// ============================================
function createZapCard(zap) {
  const card = document.createElement('div');
  card.className = 'zap-card';
  card.dataset.id = zap.id;

  const personalityLabels = {
    padrao: 'Padro', vendedor: 'Vendedor',
    atendente: 'Atendente', especialista: 'Especialista'
  };
  const personalityLabel = personalityLabels[zap.personality] || 'Padro';

  card.innerHTML = `
    <div class="zap-card-icon">
      <svg viewBox="0 0 32 32" fill="#111">
        <path d="M16.004 0h-.008C7.174 0 0 7.176 0 16c0 3.5 1.132 6.744 3.054 9.374L1.054 31.25l6.118-1.978A15.912 15.912 0 0016.004 32C24.826 32 32 24.822 32 16S24.826 0 16.004 0zm9.336 22.608c-.39 1.098-1.932 2.01-3.168 2.274-.84.18-1.938.324-5.628-1.206-4.722-1.956-7.758-6.756-7.992-7.068-.228-.312-1.878-2.502-1.878-4.77s1.188-3.39 1.614-3.858c.39-.426.936-.57 1.248-.57.156 0 .294.006.42.012.402.018.6.042.864.654.33.768 1.128 2.748 1.224 2.946.096.198.162.426.036.684-.126.258-.234.414-.462.642-.228.228-.48.51-.684.684-.198.162-.408.342-.174.672.234.33 1.038 1.716 2.226 2.784 1.53 1.374 2.706 1.848 3.18 2.062.372.168.588.138.804-.084.222-.228.756-.882 1.164-1.416.288-.378.648-.426 1.038-.288.396.132 2.496 1.176 2.922 1.392.426.216.714.324.816.504.102.18.102 1.05-.288 2.148z"/>
      </svg>
    </div>
    <div class="zap-card-info">
      <div class="zap-card-name-row">
        <span class="zap-card-name">${zap.name}</span>
        <span class="zap-card-personality">${personalityLabel}</span>
      </div>
      <div class="zap-card-phone">${zap.phone}</div>
    </div>
    <button class="zap-card-arrow open-panel" data-id="${zap.id}" title="Abrir painel">
      &rsaquo;
    </button>
  `;

  const arrowBtn = card.querySelector('.open-panel');
  if (arrowBtn) {
    arrowBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openZapPanel(zap.id);
    });
  }

  card.addEventListener('click', () => openZapPanel(zap.id));

  return card;
}

// ============================================
// Delete Zap
// ============================================
function deleteZap(id) {
  if (!confirm('Tem certeza que deseja excluir este Zap?')) return;
  zapsData = zapsData.filter(z => z.id !== id);
  saveZaps();
  delete trainingsData[String(id)];
  if (window.electronAPI) {
    try {
      const p = window.electronAPI.deleteTrainingsForZap(String(id));
      if (p && p.catch) p.catch(() => {});
    } catch (e) {}
  }
  renderZaps(zapsData);
  if (window.electronAPI && window.electronAPI.focusWindow) {
    window.electronAPI.focusWindow();
  }
}

// ============================================
// Disconnect Zap
// ============================================
async function disconnectZap(id) {
  if (!confirm('Tem certeza que deseja desconectar este Zap?')) return;
  
  if (window.electronAPI) {
    try {
      await window.electronAPI.whatsappDisconnect(id.toString());
    } catch (error) {
      console.error('Erro ao desconectar:', error);
    }
  }

  const zap = zapsData.find(z => z.id == id);
  if (zap) {
    applyRuntimeStatus(zap, 'disconnected');
    saveZaps();
    renderZaps(zapsData);
    if (currentPanelZapId != null && String(currentPanelZapId) === String(id)) {
      refreshPanelStatusUI(id);
    }
  }
}

// ============================================
// Toggle Auto Reply
// ============================================
function toggleAutoReply(id, enabled) {
  const zap = zapsData.find(z => z.id == id);
  if (zap) {
    zap.autoReply = enabled;
    saveZaps();
  }
}

// ============================================
// Event Listeners
// ============================================
function setupEventListeners() {
  // Custom window drag - sends DELTA (fixed bug where absolute screenX was sent)
  const topBar = document.querySelector('.top-bar');
  if (topBar && window.electronAPI) {
    let rendererDragging = false;
    let lastX = 0, lastY = 0;
    topBar.addEventListener('mousedown', (e) => {
      if (e.target.closest('.window-controls') || e.target.closest('.menu-item') || e.target.closest('input') || e.target.closest('button')) return;
      rendererDragging = true;
      lastX = e.screenX; lastY = e.screenY;
      window.electronAPI.startDrag();
    });
    document.addEventListener('mousemove', (e) => {
      if (!rendererDragging) return;
      const dx = e.screenX - lastX;
      const dy = e.screenY - lastY;
      lastX = e.screenX; lastY = e.screenY;
      window.electronAPI.dragMove(dx, dy);
    });
    document.addEventListener('mouseup', () => {
      if (!rendererDragging) return;
      rendererDragging = false;
      window.electronAPI.stopDrag();
    });
    window.addEventListener('blur', () => {
      if (!rendererDragging) return;
      rendererDragging = false;
      window.electronAPI.stopDrag();
    });
  }

  menuItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const page = item.dataset.page;
      navigateTo(page);
    });
  });

  searchInput.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase();
    filterZaps(query);
  });

  addZapBtn.addEventListener('click', openModal);
  listZapsBtn.addEventListener('click', () => {
    searchInput.focus();
  });
  closeModalBtn.addEventListener('click', closeModalHandler);
  cancelAdd.addEventListener('click', closeModalHandler);
  confirmAdd.addEventListener('click', addNewZap);

  addZapModal.addEventListener('click', (e) => {
    if (e.target === addZapModal) {
      closeModalHandler();
    }
  });

  // Log modal
  document.getElementById('closeLogModal').addEventListener('click', () => {
    document.getElementById('logModal').classList.remove('active');
  });
  document.getElementById('logModal').addEventListener('click', (e) => {
    if (e.target.id === 'logModal') {
      document.getElementById('logModal').classList.remove('active');
    }
  });

  // Zap Panel - back button
  document.getElementById('backToList').addEventListener('click', closeZapPanel);

  // Zap Contacts Modal
  const zapContactsModal = document.getElementById('zapContactsModal');
  const closeZapContactsBtn = document.getElementById('closeZapContactsModal');
  if (closeZapContactsBtn) {
    closeZapContactsBtn.addEventListener('click', () => {
      zapContactsModal.classList.remove('active');
    });
  }
  if (zapContactsModal) {
    zapContactsModal.addEventListener('click', (e) => {
      if (e.target === zapContactsModal) {
        zapContactsModal.classList.remove('active');
      }
    });
  }

  document.getElementById('copyLogBtn').addEventListener('click', () => {
    const logContainer = document.getElementById('logContainer');
    const entries = logContainer.querySelectorAll('.log-entry');
    if (entries.length === 0) {
      alert('Nenhum log para copiar.');
      return;
    }
    const tagLabels = {
      info: 'INFO', success: 'OK', error: 'ERRO', warning: 'AVISO',
      incoming: 'CHEGOU', outgoing: 'ENVIOU', ai: 'IA'
    };
    let text = '';
    entries.forEach(entry => {
      const time = entry.querySelector('.log-time')?.textContent || '';
      const tag = entry.querySelector('.log-tag')?.textContent?.replace(/[\[\]]/g, '') || '';
      const msg = entry.querySelector('.log-msg')?.textContent || '';
      text += `[${time}] ${tag} ${msg}\n`;
    });
    navigator.clipboard.writeText(text).then(() => {
      const btn = document.getElementById('copyLogBtn');
      const original = btn.textContent;
      btn.textContent = 'Copiado!';
      setTimeout(() => { btn.textContent = original; }, 2000);
    });
  });

  if (window.electronAPI) {
    minimizeBtn.addEventListener('click', () => window.electronAPI.minimize());
    maximizeBtn.addEventListener('click', () => window.electronAPI.maximize());
    closeBtn.addEventListener('click', () => window.electronAPI.close());
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && addZapModal.classList.contains('active')) {
      closeModalHandler();
    }
  });
}

// ============================================
// Navigation
// ============================================
function navigateTo(page) {
  menuItems.forEach(item => {
    item.classList.remove('active');
    if (item.dataset.page === page) {
      item.classList.add('active');
    }
  });

  pages.forEach(p => {
    p.classList.remove('active');
  });

  const targetPage = document.getElementById(`page-${page}`);
  if (targetPage) {
    targetPage.classList.add('active');
  }

  if (page === 'treinamento') {
    closeTrainingEditor();
    renderTrainingZapsList();
  }
  // Close zap panel when leaving "adicionar-whatsapp" page
  if (page !== 'adicionar-whatsapp' && currentPanelZapId != null) {
    closeZapPanel();
  }
}

// ============================================
// Filter Zaps
// ============================================
function filterZaps(query) {
  if (!query) {
    renderZaps(zapsData);
    return;
  }

  const filtered = zapsData.filter(zap => {
    return (
      (zap.phone || '').toLowerCase().includes(query) ||
      (zap.name || '').toLowerCase().includes(query) ||
      (zap.providers || []).some(p => (p||'').toLowerCase().includes(query)) ||
      (zap.status || '').toLowerCase().includes(query)
    );
  });

  renderZaps(filtered);
}

// ============================================
// Modal - Add Zap
// ============================================
function updateProvidersCheckboxes() {
  const container = document.getElementById('zapProvidersList');
  const modelGroup = document.getElementById('zapModelGroup');
  const modelSelect = document.getElementById('zapModel');

  container.innerHTML = '';

  if (providersData.length === 0) {
    container.innerHTML = '<p style="color: #999; font-size: 13px;">Nenhum provedor configurado. Adicione um em Provedores.</p>';
    modelGroup.style.display = 'none';
    return;
  }

  providersData.forEach(provider => {
    const item = document.createElement('div');
    item.className = 'checkbox-item';
    item.innerHTML = `
      <input type="checkbox" id="zap-prov-${provider.id}" value="${provider.id}" class="provider-checkbox">
      <label for="zap-prov-${provider.id}">
        <span class="checkbox-provider-name">${provider.name}</span>
        <span class="checkbox-models-count">(${provider.models.length} modelos)</span>
      </label>
    `;
    container.appendChild(item);
  });

  // Add event listeners to checkboxes
  container.querySelectorAll('.provider-checkbox').forEach(cb => {
    cb.addEventListener('change', updateModelSelect);
  });

  modelGroup.style.display = 'none';
}

function updateModelSelect() {
  const checked = document.querySelectorAll('.provider-checkbox:checked');
  const modelGroup = document.getElementById('zapModelGroup');
  const modelSelect = document.getElementById('zapModel');

  if (checked.length === 0) {
    modelGroup.style.display = 'none';
    return;
  }

  modelGroup.style.display = 'block';
  modelSelect.innerHTML = '<option value="auto">Automtico (Melhor para Pior)</option>';

  const allModels = [];
  checked.forEach(cb => {
    const provider = providersData.find(p => p.id === cb.value);
    if (provider) {
      provider.models.forEach(model => {
        allModels.push({
          id: model.id || model,
          name: model.name || model,
          provider: provider.name,
          free: model.free || false
        });
      });
    }
  });

  // Sort: free first, then by provider name
  allModels.sort((a, b) => {
    if (a.free && !b.free) return -1;
    if (!a.free && b.free) return 1;
    return a.provider.localeCompare(b.provider);
  });

  allModels.forEach(model => {
    const opt = document.createElement('option');
    opt.value = `${model.provider}|${model.id}`;
    opt.textContent = `${model.name} (${model.provider})${model.free ? ' - Gratuito' : ''}`;
    modelSelect.appendChild(opt);
  });
}

function openModal() {
  updateProvidersCheckboxes();
  clearForm();
  addZapModal.classList.add('active');

  const zapPersonality = document.getElementById('zapPersonality');
  const zapAreaGroup = document.getElementById('zapAreaGroup');
  const zapNameInput = document.getElementById('zapName');
  const zapNumberInput = document.getElementById('zapNumber');

  // onchange (not addEventListener) so opening the modal many times never stacks handlers
  zapAreaGroup.style.display = zapPersonality.value === 'especialista' ? 'block' : 'none';
  zapPersonality.onchange = () => {
    zapAreaGroup.style.display = zapPersonality.value === 'especialista' ? 'block' : 'none';
  };

  // Ensure fields are editable (recover if a previous flow left them disabled/read-only)
  [zapNameInput, zapNumberInput].forEach(el => {
    if (!el) return;
    el.disabled = false;
    el.readOnly = false;
  });

  // Restore OS window focus (native confirm() after delete can drop it in Electron)
  if (window.electronAPI && window.electronAPI.focusWindow) {
    window.electronAPI.focusWindow();
  }

  // Single focus on open — do NOT steal focus from other fields while typing
  requestAnimationFrame(() => {
    zapNameInput.focus();
    zapNameInput.select();
  });
}

function closeModalHandler() {
  if (!addZapModal.classList.contains('active')) return;
  addZapModal.classList.remove('active');
  const focused = document.activeElement;
  if (focused && addZapModal.contains(focused)) {
    focused.blur();
  }
}

function openLogModal(zapId, zapName) {
  const logModal = document.getElementById('logModal');
  const logContainer = document.getElementById('logContainer');
  document.getElementById('logModalTitle').textContent = `Log - ${zapName}`;

  logContainer.innerHTML = '';
  logContainer.dataset.zapId = zapId;

  const logs = zapLogs[zapId] || [];
  if (logs.length === 0) {
    logContainer.innerHTML = '<p class="log-empty">Nenhuma atividade ainda. Envie uma mensagem para o nmero do Zap e veja o log aqui.</p>';
  } else {
    logs.forEach(entry => appendLogEntry(logContainer, entry));
    logContainer.scrollTop = logContainer.scrollHeight;
  }

  logModal.classList.add('active');
}

// ============================================
// Zap Detail Panel - In-place (no modal)
// ============================================
let currentPanelZapId = null;

function openZapPanel(zapId) {
  const zap = zapsData.find(z => String(z.id) === String(zapId));
  if (!zap) return;

  currentPanelZapId = zapId;

  const listView = document.getElementById('zapsListView');
  const panelView = document.getElementById('zapPanelView');

  // Hide list, show panel
  listView.style.display = 'none';
  panelView.style.display = 'block';

  document.getElementById('zapPanelName').textContent = zap.name;
  document.getElementById('zapPanelPhone').textContent = zap.phone;

  // Copy phone
  const copyBtn = document.getElementById('copyZapPhone');
  copyBtn.onclick = () => {
    navigator.clipboard.writeText(zap.phone).then(() => {
      const orig = copyBtn.innerHTML;
      copyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><polyline points="20 6 9 17 4 12"/></svg> Copiado!';
      setTimeout(() => { copyBtn.innerHTML = orig; }, 2000);
    });
  };

  // Status badge (real status next to name)
  const statusInfo = getZapStatusInfo(zap);
  const statusEl = document.getElementById('zapPanelStatus');
  statusEl.className = 'zap-card-status ' + statusInfo.className;
  statusEl.innerHTML = `<span class="dot"></span> ${statusInfo.label}`;

  // Enabled toggle (Ativo/Desativado)
  const enabledCb = document.getElementById('panelEnabled');
  const enabledLabel = document.getElementById('panelEnabledLabel');
  enabledCb.checked = zap.enabled !== false;
  enabledLabel.textContent = zap.enabled !== false ? 'Ativo' : 'Desativado';
  enabledCb.onchange = () => {
    const z = zapsData.find(x => String(x.id) === String(zapId));
    if (z) {
      z.enabled = enabledCb.checked;
      enabledLabel.textContent = z.enabled ? 'Ativo' : 'Desativado';
      saveZaps();
      applyRuntimeStatus(z, z.runtimeStatus || 'disconnected');
      renderZaps(zapsData);
      refreshPanelStatusUI(zapId);
      updateToggleZapBtn(z);
    }
  };

  // Auto-reply toggle (next to status)
  const autoReplyCb = document.getElementById('panelAutoReply');
  autoReplyCb.checked = zap.autoReply !== false;
  autoReplyCb.onchange = () => {
    const z = zapsData.find(x => String(x.id) === String(zapId));
    if (z) {
      z.autoReply = autoReplyCb.checked;
      saveZaps();
    }
  };

  // Personality
  const personalitySelect = document.getElementById('panelPersonality');
  const areaRow = document.getElementById('panelAreaRow');
  const areaInput = document.getElementById('panelArea');
  personalitySelect.value = zap.personality || 'padrao';
  areaInput.value = zap.area || '';
  areaRow.style.display = personalitySelect.value === 'especialista' ? 'flex' : 'none';

  personalitySelect.onchange = () => {
    areaRow.style.display = personalitySelect.value === 'especialista' ? 'flex' : 'none';
  };

  // Connect/Disconnect button
  refreshPanelStatusUI(zapId);

  // Log button
  const logBtn = document.getElementById('zapPanelLog');
  logBtn.onclick = () => openLogModal(zap.id, zap.name);

  // Toggle Zap (Ativar/Desativar)
  const toggleZapBtn = document.getElementById('panelToggleZap');
  updateToggleZapBtn(zap);
  toggleZapBtn.onclick = async () => {
    const z = zapsData.find(x => String(x.id) === String(zapId));
    if (!z) return;

    const enabling = z.enabled === false;
    z.enabled = enabling;
    enabledCb.checked = enabling;
    enabledLabel.textContent = enabling ? 'Ativo' : 'Desativado';
    saveZaps();

    toggleZapBtn.disabled = true;
    const origText = toggleZapBtn.querySelector('#panelToggleZapText').textContent;
    toggleZapBtn.querySelector('#panelToggleZapText').textContent = enabling ? 'Ativando...' : 'Desativando...';

    try {
      if (window.electronAPI) {
        if (!enabling) {
          // Disabling: disconnect
          await window.electronAPI.whatsappDisconnect(zapId.toString());
          applyRuntimeStatus(z, 'disconnected');
        } else {
          // Enabling: try to reconnect with saved method
          applyRuntimeStatus(z, 'connecting');
          const method = z.lastConnectMethod || 'qrcode';
          await window.electronAPI.whatsappConnect(zapId.toString(), z.phone.replace(/\D/g, ''), method);
        }
      }
      saveZaps();
      renderZaps(zapsData);
      refreshPanelStatusUI(zapId);
    } catch (err) {
      alert('Erro: ' + err.message);
      applyRuntimeStatus(z, 'disconnected');
      refreshPanelStatusUI(zapId);
    } finally {
      toggleZapBtn.disabled = false;
      updateToggleZapBtn(zapsData.find(x => String(x.id) === String(zapId)) || z);
    }
  };

  // Save & Restart
  const saveRestartBtn = document.getElementById('panelSaveRestart');
  saveRestartBtn.onclick = async () => {
    const z = zapsData.find(x => String(x.id) === String(zapId));
    if (!z) return;

    // Apply personality changes
    z.personality = personalitySelect.value;
    z.area = areaInput.value.trim();
    if (z.personality === 'especialista' && !z.area) {
      alert('Informe a rea de atuao do especialista.');
      areaInput.focus();
      return;
    }
    z.autoReply = autoReplyCb.checked;
    z.enabled = enabledCb.checked;
    saveZaps();
    renderZaps(zapsData);

    // Restart: disconnect then reconnect
    saveRestartBtn.disabled = true;
    saveRestartBtn.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> Reiniciando...`;

    try {
      if (window.electronAPI && z.enabled !== false) {
        const wasOnline = getZapStatusInfo(z).online;
        if (wasOnline) {
          await window.electronAPI.whatsappDisconnect(zapId.toString());
        }
        // Always reconnect if enabled (even if wasn't online - user wants it working)
        applyRuntimeStatus(z, 'connecting');
        refreshPanelStatusUI(zapId);
        await window.electronAPI.whatsappConnect(zapId.toString(), z.phone.replace(/\D/g, ''), 'qrcode');
      }
      saveZaps();
      alert('Alteraes salvas!' + (z.enabled !== false ? ' Zap reiniciado.' : ''));
    } catch (err) {
      alert('Erro ao reiniciar: ' + err.message);
      applyRuntimeStatus(z, 'disconnected');
    } finally {
      saveRestartBtn.disabled = false;
      saveRestartBtn.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> Salvar alteraes e reiniciar Zap`;
      // Refresh panel
      openZapPanel(zapId);
    }
  };

  // Charts
  renderPanelCharts(zap);

  // Providers
  renderPanelProviders(zap);

  // Model config
  renderPanelModelConfig(zap);

  // Contacts
  loadPanelContacts(zapId);

  // Delete
  const deleteBtn = document.getElementById('panelDeleteZap');
  deleteBtn.onclick = () => {
    if (confirm('Tem certeza que deseja excluir este Zap?')) {
      closeZapPanel();
      zapsData = zapsData.filter(z => z.id !== zapId);
      saveZaps();
      delete trainingsData[String(zapId)];
      if (window.electronAPI) {
        try {
          const p = window.electronAPI.deleteTrainingsForZap(String(zapId));
          if (p && p.catch) p.catch(() => {});
        } catch (e) {}
      }
      renderZaps(zapsData);
      if (window.electronAPI && window.electronAPI.focusWindow) {
        window.electronAPI.focusWindow();
      }
    }
  };
}

function closeZapPanel() {
  const listView = document.getElementById('zapsListView');
  const panelView = document.getElementById('zapPanelView');
  listView.style.display = 'block';
  panelView.style.display = 'none';
  currentPanelZapId = null;
}

function updateToggleZapBtn(zap) {
  const btn = document.getElementById('panelToggleZap');
  const text = document.getElementById('panelToggleZapText');
  if (!btn || !text) return;
  const enabled = zap.enabled !== false;
  text.textContent = enabled ? 'Desativar Zap' : 'Ativar Zap';
  btn.className = enabled ? 'btn-toggle-zap deactivate' : 'btn-toggle-zap activate';
}

// ============================================
// Panel Charts (Canvas)
// ============================================
function renderPanelCharts(zap) {
  const tokensData = zap.tokenHistory || [];
  const usageData = zap.usageHistory || [];
  const totalTokens = zap.tokensUsed || 0;
  const totalMessages = zap.messageCount || 0;

  document.getElementById('tokensValue').textContent = totalTokens.toLocaleString('pt-BR');
  document.getElementById('usageValue').textContent = totalMessages.toLocaleString('pt-BR');

  drawChart('tokensChart', 'tokensTooltip', tokensData, '#111', 'tokens');
  drawChart('usageChart', 'usageTooltip', usageData, '#555', 'msgs');
}

function drawChart(canvasId, tooltipId, data, color, unit) {
  const canvas = document.getElementById(canvasId);
  const tooltip = document.getElementById(tooltipId);
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const w = rect.width;
  const h = rect.height;
  ctx.clearRect(0, 0, w, h);

  if (data.length === 0) {
    ctx.fillStyle = '#ccc';
    ctx.font = '11px Inter';
    ctx.textAlign = 'center';
    ctx.fillText('Sem dados ainda', w / 2, h / 2 + 4);
    return;
  }

  // Group by time buckets for bar chart (last 12 buckets)
  const now = Math.floor(Date.now() / 1000);
  const bucketSize = 3600; // 1 hour buckets
  const numBuckets = Math.min(12, Math.max(data.length, 1));
  const buckets = [];

  for (let i = numBuckets - 1; i >= 0; i--) {
    const bucketEnd = now - i * bucketSize;
    const bucketStart = bucketEnd - bucketSize;
    let value = 0;
    data.forEach(p => {
      if (p.x >= bucketStart && p.x < bucketEnd) value += (p.y || 0);
    });
    // For cumulative data (tokens), use max in bucket
    if (unit === 'tokens') {
      value = 0;
      data.forEach(p => {
        if (p.x >= bucketStart && p.x < bucketEnd) value = Math.max(value, p.y);
      });
      // Get the value at end of bucket
      let lastVal = 0;
      data.forEach(p => {
        if (p.x < bucketEnd) lastVal = p.y;
      });
      value = lastVal;
    }
    buckets.push({ time: bucketEnd, value });
  }

  // If all zeros, show sample data pattern
  const hasData = buckets.some(b => b.value > 0);
  if (!hasData) {
    // Draw flat baseline
    ctx.fillStyle = '#eee';
    ctx.fillRect(0, h - 3, w, 3);
    ctx.fillStyle = '#ccc';
    ctx.font = '11px Inter';
    ctx.textAlign = 'center';
    ctx.fillText('Aguardando dados...', w / 2, h / 2 + 4);
    return;
  }

  const maxVal = Math.max(...buckets.map(b => b.value), 1);
  const barCount = buckets.length;
  const gap = 3;
  const totalGap = gap * (barCount + 1);
  const barWidth = (w - totalGap) / barCount;
  const maxBarH = h - 8;

  // Store bar positions for hover
  const barPositions = [];

  buckets.forEach((bucket, i) => {
    const x = gap + i * (barWidth + gap);
    const barH = Math.max(2, (bucket.value / maxVal) * maxBarH);
    const y = h - barH;

    barPositions.push({ x, y, w: barWidth, h: barH, bucket });

    // Bar gradient - handle 3-digit hex like #111
    const colorTransparent = color.length === 4 ? color + '66' : color + '40';
    const grad = ctx.createLinearGradient(0, y, 0, h);
    grad.addColorStop(0, color);
    grad.addColorStop(1, colorTransparent);

    ctx.fillStyle = grad;
    // Rounded top
    const r = Math.min(3, barWidth / 2, barH / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + barWidth - r, y);
    ctx.quadraticCurveTo(x + barWidth, y, x + barWidth, y + r);
    ctx.lineTo(x + barWidth, h);
    ctx.lineTo(x, h);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.fill();
  });

  // Hover tooltip
  canvas.onmousemove = (e) => {
    const canvasRect = canvas.getBoundingClientRect();
    const mx = e.clientX - canvasRect.left;
    let hovered = null;

    barPositions.forEach(bp => {
      if (mx >= bp.x && mx <= bp.x + bp.w) hovered = bp;
    });

    if (hovered) {
      tooltip.style.display = 'block';
      const time = new Date(hovered.bucket.time * 1000);
      const label = time.toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit'});
      tooltip.textContent = `${label} - ${hovered.bucket.value.toLocaleString('pt-BR')} ${unit}`;
      tooltip.style.left = Math.min(hovered.x, w - 120) + 'px';
      tooltip.style.top = Math.max(hovered.y - 30, 0) + 'px';

      // Highlight bar
      canvas.style.cursor = 'pointer';
    } else {
      tooltip.style.display = 'none';
      canvas.style.cursor = 'default';
    }
  };
  canvas.onmouseleave = () => {
    tooltip.style.display = 'none';
    canvas.style.cursor = 'default';
  };
}

// ============================================
// Panel Providers
// ============================================
function maskApiKey(key) {
  if (!key) return 'Vazia';
  if (key.length <= 12) return key.substring(0, 4) + '...';
  return key.substring(0, 8) + '...' + key.substring(key.length - 4);
}

function renderPanelProviders(zap) {
  const container = document.getElementById('panelProvidersList');
  container.innerHTML = '';

  if (providersData.length === 0) {
    container.innerHTML = '<p style="font-size:12px;color:#999;">Nenhum provedor configurado.</p>';
    return;
  }

  const selectedProviders = zap.providers || [];
  if (!zap.apiKeySelections) zap.apiKeySelections = {};

  providersData.forEach(provider => {
    const isChecked = selectedProviders.includes(provider.id);
    const providerKeys = provider.apiKeys && provider.apiKeys.length
      ? provider.apiKeys
      : (provider.apiKey ? [provider.apiKey] : []);

    const item = document.createElement('div');
    item.className = 'provider-toggle-item';

    let keySelectHtml = '';
    if (providerKeys.length > 0) {
      const selIndex = zap.apiKeySelections[provider.id] != null
        ? zap.apiKeySelections[provider.id]
        : 0;
      const options = providerKeys.map((k, i) =>
        `<option value="${i}" ${i === selIndex ? 'selected' : ''}>Chave ${i + 1}: ${maskApiKey(k)}</option>`
      ).join('');
      keySelectHtml = `
        <div class="provider-key-row">
          <label class="provider-key-label">Chave API</label>
          <select class="provider-key-select" data-provider="${provider.id}">
            ${options}
          </select>
        </div>
      `;
    } else {
      keySelectHtml = `
        <div class="provider-key-row">
          <span class="provider-key-empty">Nenhuma chave cadastrada</span>
        </div>
      `;
    }

    item.innerHTML = `
      <input type="checkbox" data-provider="${provider.id}" ${isChecked ? 'checked' : ''}>
      <div class="provider-toggle-info">
        <div class="provider-toggle-name">${provider.name}</div>
        <div class="provider-toggle-models">${provider.models.length} modelos · ${providerKeys.length} chave(s)</div>
        ${keySelectHtml}
      </div>
    `;
    container.appendChild(item);

    const cb = item.querySelector('input');
    cb.addEventListener('change', () => {
      const z = zapsData.find(x => String(x.id) === String(zap.id));
      if (!z) return;
      if (!z.providers) z.providers = [];
      if (cb.checked) {
        if (!z.providers.includes(provider.id)) z.providers.push(provider.id);
      } else {
        z.providers = z.providers.filter(id => id !== provider.id);
      }
      saveZaps();
      renderPanelModelConfig(z);
    });

    const keySelect = item.querySelector('.provider-key-select');
    if (keySelect) {
      keySelect.addEventListener('change', () => {
        const z = zapsData.find(x => String(x.id) === String(zap.id));
        if (!z) return;
        if (!z.apiKeySelections) z.apiKeySelections = {};
        z.apiKeySelections[provider.id] = parseInt(keySelect.value, 10);
        saveZaps();
      });
      // Prevent checkbox toggle when interacting with select
      keySelect.addEventListener('click', (e) => e.stopPropagation());
    }
  });
}

// ============================================
// Panel Model Config
// ============================================
function renderPanelModelConfig(zap) {
  const select = document.getElementById('panelModelSelect');
  const autoSwitch = document.getElementById('panelAutoSwitch');

  // Build model options from selected providers
  select.innerHTML = '<option value="auto">Automtico (Melhor para Pior)</option>';
  const selectedIds = zap.providers || [];

  selectedIds.forEach(pId => {
    const provider = providersData.find(p => p.id === pId);
    if (!provider) return;
    provider.models.forEach(model => {
      const opt = document.createElement('option');
      opt.value = `${provider.name}|${model.id}`;
      opt.textContent = `${model.name} (${provider.name})`;
      select.appendChild(opt);
    });
  });

  select.value = zap.model || 'auto';
  autoSwitch.checked = zap.autoSwitch !== false;

  select.onchange = () => {
    const z = zapsData.find(x => String(x.id) === String(zap.id));
    if (z) { z.model = select.value; saveZaps(); }
  };

  autoSwitch.onchange = () => {
    const z = zapsData.find(x => String(x.id) === String(zap.id));
    if (z) { z.autoSwitch = autoSwitch.checked; saveZaps(); }
  };
}

// ============================================
// Panel Contacts
// ============================================
async function loadPanelContacts(zapId) {
  const container = document.getElementById('panelContactsList');
  container.innerHTML = '<div class="spinner" style="margin:16px auto;"></div>';

  if (!window.electronAPI) {
    container.innerHTML = '<p style="font-size:12px;color:#999;">API nao disponivel.</p>';
    return;
  }

  try {
    const conversations = await window.electronAPI.whatsappConversations(zapId.toString());
    const zap = zapsData.find(z => String(z.id) === String(zapId));
    const blocked = (zap && zap.blockedContacts) || [];

    if (!conversations || conversations.length === 0) {
      container.innerHTML = '<p style="font-size:12px;color:#999;">Nenhum contato encontrado. Conecte o Zap e receba mensagens.</p>';
      return;
    }

    container.innerHTML = '';
    conversations.forEach(conv => {
      if (conv.contact && conv.contact.id && conv.contact.id.includes('@g.us')) return;
      if (conv.contact && conv.contact.id && conv.contact.id.includes('@newsletter')) return;

      const isBlocked = blocked.includes(conv.contact.id);
      const item = document.createElement('div');
      item.className = 'panel-contact-item';
      item.innerHTML = `
        <input type="checkbox" data-contact="${conv.contact.id}" ${!isBlocked ? 'checked' : ''}>
        <div class="panel-contact-avatar">
          <svg viewBox="0 0 24 24" fill="none" stroke="#666" stroke-width="2">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
            <circle cx="12" cy="7" r="4"/>
          </svg>
        </div>
        <div class="panel-contact-info">
          <div class="panel-contact-name">${conv.contact.name || 'Sem nome'}</div>
          <div class="panel-contact-number">${conv.contact.number}</div>
        </div>
        <div class="panel-contact-auth">${!isBlocked ? 'Autorizado' : 'Bloqueado'}</div>
      `;
      container.appendChild(item);

      const cb = item.querySelector('input');
      cb.addEventListener('change', () => {
        const z = zapsData.find(x => String(x.id) === String(zapId));
        if (!z) return;
        if (!z.blockedContacts) z.blockedContacts = [];
        if (cb.checked) {
          z.blockedContacts = z.blockedContacts.filter(id => id !== conv.contact.id);
        } else {
          if (!z.blockedContacts.includes(conv.contact.id)) z.blockedContacts.push(conv.contact.id);
        }
        item.querySelector('.panel-contact-auth').textContent = cb.checked ? 'Autorizado' : 'Bloqueado';
        saveZaps();
      });
    });

  } catch (err) {
    container.innerHTML = `<p style="font-size:12px;color:#dc2626;">Erro: ${err.message}</p>`;
  }
}

async function openZapContactsModal(zapId, zapName) {
  const modal = document.getElementById('zapContactsModal');
  const listContainer = document.getElementById('zapContactsList');
  if (!modal || !listContainer) return;

  document.getElementById('zapContactsModalTitle').textContent = `Contatos - ${zapName}`;
  
  modal.classList.add('active');
  listContainer.innerHTML = '<div class="spinner" style="margin: 20px auto;"></div>';

  if (!window.electronAPI) {
    listContainer.innerHTML = '<p class="error-text">API nao disponivel.</p>';
    return;
  }

  try {
    const conversations = await window.electronAPI.whatsappConversations(zapId.toString());
    const zap = zapsData.find(z => String(z.id) === String(zapId));
    const blocked = zap.blockedContacts || [];

    if (!conversations || conversations.length === 0) {
      listContainer.innerHTML = '<p style="text-align:center; padding: 20px; color:#666;">Nenhum contato encontrado para este Zap.</p>';
      return;
    }

    listContainer.innerHTML = '';
    conversations.forEach(conv => {
      // Ignore groups visually here
      if (conv.contact && conv.contact.id && conv.contact.id.includes('@g.us')) return;

      const isBlocked = blocked.includes(conv.contact.id);
      
      const item = document.createElement('div');
      item.className = 'provider-item'; // reuse styles from providers
      item.innerHTML = `
        <div class="provider-item-icon">
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#666" stroke-width="2">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
            <circle cx="12" cy="7" r="4"/>
          </svg>
        </div>
        <div class="provider-item-info">
          <div class="provider-item-name">${conv.contact.name || conv.contact.number}</div>
          <div class="provider-item-models">${conv.contact.number}</div>
        </div>
        <div class="provider-item-actions">
          <label class="auto-reply-toggle">
            <input type="checkbox" class="contact-auth-checkbox" data-zap="${zapId}" data-contact="${conv.contact.id}" ${!isBlocked ? 'checked' : ''}>
            <span class="auto-reply-label">Autorizado</span>
          </label>
        </div>
      `;
      listContainer.appendChild(item);
    });

    listContainer.querySelectorAll('.contact-auth-checkbox').forEach(cb => {
      cb.addEventListener('change', (e) => {
        toggleContactAuth(e.target.dataset.zap, e.target.dataset.contact, e.target.checked);
      });
    });

  } catch (err) {
    listContainer.innerHTML = `<p class="error-text">Erro ao buscar contatos: ${err.message}</p>`;
  }
}

function toggleContactAuth(zapId, contactId, isAuthorized) {
  const zap = zapsData.find(z => String(z.id) === String(zapId));
  if (zap) {
    if (!zap.blockedContacts) zap.blockedContacts = [];
    
    if (isAuthorized) {
      // Remove from blocked list
      zap.blockedContacts = zap.blockedContacts.filter(id => id !== contactId);
    } else {
      // Add to blocked list
      if (!zap.blockedContacts.includes(contactId)) {
        zap.blockedContacts.push(contactId);
      }
    }
    saveZaps();
  }
}

function clearForm() {
  document.getElementById('zapName').value = '';
  document.getElementById('zapNumber').value = '';
  document.getElementById('zapPersonality').value = 'padrao';
  document.getElementById('zapArea').value = '';
  document.getElementById('zapAreaGroup').style.display = 'none';
  document.getElementById('zapModelGroup').style.display = 'none';
  document.getElementById('zapModel').innerHTML = '<option value="auto">Automtico (Melhor para Pior)</option>';
  document.querySelectorAll('.provider-checkbox:checked').forEach(cb => { cb.checked = false; });
}

// ============================================
// Add New Zap
// ============================================
function addNewZap() {
  const name = document.getElementById('zapName').value.trim();
  const phone = document.getElementById('zapNumber').value.trim();
  const personality = document.getElementById('zapPersonality').value;
  const area = document.getElementById('zapArea').value.trim();
  const selectedProviders = Array.from(document.querySelectorAll('.provider-checkbox:checked')).map(cb => cb.value);
  const modelValue = document.getElementById('zapModel').value;

  if (!name) {
    alert('Por favor, insira um nome para o Zap.');
    return;
  }

  if (!phone) {
    alert('Por favor, insira o nmero do WhatsApp.');
    return;
  }
  const digitsOnly = phone.replace(/\D/g, '');
  if (digitsOnly.length < 10 || digitsOnly.length > 15) {
    alert('Nmero invlido. Use formato internacional: cdigo do pas + DDD + nmero (ex: 5511999999999) - 10 a 15 dgitos.');
    return;
  }

  if (personality === 'especialista' && !area) {
    alert('Por favor, informe a rea de atuao do especialista (ex: Psicologia, Dentista).');
    return;
  }

  if (selectedProviders.length === 0) {
    alert('Por favor, selecione pelo menos um provedor de IA.');
    return;
  }

  const now = new Date();
  const createdAt = now.toLocaleDateString('pt-BR') + ' s ' + now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  const newZap = {
    id: Date.now(),
    name: name,
    phone: phone,
    personality: personality,
    area: area,
    providers: selectedProviders,
    model: modelValue,
    autoReply: true,
    enabled: true,
    runtimeStatus: 'disconnected',
    status: 'Desconectado',
    statusClass: 'offline',
    createdAt: createdAt
  };

  zapsData.unshift(newZap);
  saveZaps();
  renderZaps(zapsData);
  closeModalHandler();
}

// ============================================
// Providers System
// ============================================
let currentProviderModels = [];

const PROVIDER_APIS = {
  openai: { url: 'https://api.openai.com/v1/models', auth: 'Bearer' },
  groq: { url: 'https://api.groq.com/openai/v1/models', auth: 'Bearer' },
  anthropic: { url: null, auth: 'x-api-key' },
  google: { url: null, auth: 'x-goog-api-key' },
  deepseek: { url: 'https://api.deepseek.com/v1/models', auth: 'Bearer' },
  mistral: { url: 'https://api.mistral.ai/v1/models', auth: 'Bearer' },
  openrouter: { url: 'https://openrouter.ai/api/v1/models', auth: 'Bearer' },
  together: { url: 'https://api.together.xyz/v1/models', auth: 'Bearer' },
  fireworks: { url: 'https://api.fireworks.ai/inference/v1/models', auth: 'Bearer' },
  nvidia: { url: 'https://integrate.api.nvidia.com/v1/models', auth: 'Bearer' },
  ollama: { url: 'http://localhost:11434/api/tags', auth: null },
  huggingface: { url: 'https://huggingface.co/api/models', auth: 'Bearer' }
};

function initProviders() {
  const addProviderBtn = document.getElementById('addProviderBtn');
  const providerModal = document.getElementById('providerModal');
  const closeProviderModalBtn = document.getElementById('closeProviderModal');
  const cancelProviderConfig = document.getElementById('cancelProviderConfig');
  const cancelProviderConfig2 = document.getElementById('cancelProviderConfig2');
  const cancelProviderConfig3 = document.getElementById('cancelProviderConfig3');
  const saveProviderConfig = document.getElementById('saveProviderConfig');
  const confirmSaveProvider = document.getElementById('confirmSaveProvider');
  const retryProviderConfig = document.getElementById('retryProviderConfig');

  if (addProviderBtn) addProviderBtn.addEventListener('click', openProviderModal);
  if (closeProviderModalBtn) closeProviderModalBtn.addEventListener('click', closeProviderModal);
  if (cancelProviderConfig) cancelProviderConfig.addEventListener('click', closeProviderModal);
  if (cancelProviderConfig2) cancelProviderConfig2.addEventListener('click', closeProviderModal);
  if (cancelProviderConfig3) cancelProviderConfig3.addEventListener('click', closeProviderModal);
  if (saveProviderConfig) saveProviderConfig.addEventListener('click', saveAndFetchModels);
  if (confirmSaveProvider) confirmSaveProvider.addEventListener('click', confirmSaveProviderHandler);
  if (retryProviderConfig) retryProviderConfig.addEventListener('click', retryFetchModels);

  if (providerModal) {
    providerModal.addEventListener('click', (e) => {
      if (e.target === providerModal) closeProviderModal();
    });
  }

  renderProvidersList();
}

function renderProvidersList() {
  const container = document.getElementById('providersList');
  if (!container) return;

  if (providersData.length === 0) {
    container.innerHTML = '<div class="provider-empty">Nenhum provedor adicionado. Clique em "Adicionar Provedor" para comear.</div>';
    return;
  }

  container.innerHTML = '';
  providersData.forEach(provider => {
    const item = document.createElement('div');
    item.className = 'provider-item';
    item.innerHTML = `
      <div class="provider-item-icon">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#111" stroke-width="2">
          <rect x="2" y="2" width="20" height="8" rx="2" ry="2"/>
          <rect x="2" y="14" width="20" height="8" rx="2" ry="2"/>
          <line x1="6" y1="6" x2="6.01" y2="6"/>
          <line x1="6" y1="18" x2="6.01" y2="18"/>
        </svg>
      </div>
      <div class="provider-item-info">
        <div class="provider-item-name">${provider.name}</div>
        <div class="provider-item-models">${provider.models.length} modelos disponveis</div>
      </div>
      <div class="provider-item-actions">
        <button class="provider-card-edit" data-id="${provider.id}" title="Configurar">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
          Configurar
        </button>
        <button class="provider-item-btn delete" data-id="${provider.id}" title="Excluir">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        </button>
      </div>
    `;
    container.appendChild(item);
  });

  // Add edit listeners
  container.querySelectorAll('.provider-card-edit').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      openProviderConfig(id);
    });
  });

  // Add delete listeners
  container.querySelectorAll('.provider-item-btn.delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      if (confirm('Tem certeza que deseja excluir este provedor?')) {
        providersData = providersData.filter(p => p.id !== id);
        saveProviders();
        renderProvidersList();
      }
    });
  });
}

function openProviderModal() {
  document.getElementById('providerName').value = '';
  document.getElementById('apiKey').value = '';
  document.getElementById('providerFormStep').style.display = 'block';
  document.getElementById('providerModelsStep').style.display = 'none';
  document.getElementById('loadingModels').style.display = 'none';
  document.getElementById('modelsResult').style.display = 'none';
  document.getElementById('modelsError').style.display = 'none';
  currentProviderModels = [];
  currentProviderName = '';
  currentProviderApiKey = '';
  document.getElementById('providerModal').classList.add('active');
  setTimeout(() => {
    document.getElementById('providerName').focus();
  }, 50);
}

function closeProviderModal() {
  document.getElementById('providerModal').classList.remove('active');
  currentProviderModels = [];
  currentProviderName = '';
  currentProviderApiKey = '';
}

let currentProviderName = '';
let currentProviderApiKey = '';

async function saveAndFetchModels() {
  const name = document.getElementById('providerName').value.trim();
  const apiKey = document.getElementById('apiKey').value.trim();

  if (!name) {
    alert('Por favor, insira um nome para o provedor.');
    return;
  }

  if (!apiKey) {
    alert('Por favor, insira uma chave API.');
    return;
  }

  currentProviderName = name;
  currentProviderApiKey = apiKey;

  // Show loading step
  document.getElementById('providerFormStep').style.display = 'none';
  document.getElementById('providerModelsStep').style.display = 'block';
  document.getElementById('loadingModels').style.display = 'block';
  document.getElementById('modelsResult').style.display = 'none';
  document.getElementById('modelsError').style.display = 'none';

  try {
    const models = await fetchFromKnownProviders(name.toLowerCase(), apiKey);

    if (models.length === 0) {
      throw new Error('Nenhum modelo encontrado');
    }

    currentProviderModels = models;
    renderModelsList(models);
    document.getElementById('loadingModels').style.display = 'none';
    document.getElementById('modelsResult').style.display = 'block';

  } catch (error) {
    console.error('Erro ao buscar modelos:', error);
    document.getElementById('loadingModels').style.display = 'none';
    document.getElementById('modelsError').style.display = 'block';
  }
}

function retryFetchModels() {
  document.getElementById('modelsError').style.display = 'none';
  document.getElementById('providerFormStep').style.display = 'block';
  document.getElementById('providerModelsStep').style.display = 'none';
  document.getElementById('providerName').value = currentProviderName;
  document.getElementById('apiKey').value = currentProviderApiKey;
}

function confirmSaveProviderHandler() {
  const selectedModels = [];
  document.querySelectorAll('#modelsList input[type="checkbox"]:checked').forEach(cb => {
    const model = currentProviderModels.find(m => m.id === cb.value);
    if (model) {
      selectedModels.push(model);
    }
  });

  if (selectedModels.length === 0) {
    alert('Selecione pelo menos um modelo.');
    return;
  }

  const newProvider = {
    id: Date.now().toString(),
    name: currentProviderName,
    apiKey: currentProviderApiKey,
    models: selectedModels,
    createdAt: new Date().toISOString()
  };

  providersData.push(newProvider);
  saveProviders();
  renderProvidersList();
  closeProviderModal();
}

function renderModelsList(models) {
  const container = document.getElementById('modelsList');
  container.innerHTML = '';

  models.forEach(model => {
    const item = document.createElement('div');
    item.className = 'model-item';
    item.innerHTML = `
      <input type="checkbox" id="model-${model.id}" value="${model.id}" checked>
      <label for="model-${model.id}">
        <span class="model-id">${model.id}</span>
        <span class="model-name">${model.name}</span>
        ${model.free ? '<span class="model-free-badge">Gratuito</span>' : ''}
      </label>
    `;
    container.appendChild(item);
  });
}

// ============================================
// Provider Config Page
// ============================================
let currentEditingProvider = null;
let currentTestProvider = null;
let currentTestModel = null;
let testChatHistory = [];

function initProviderConfig() {
  const closeBtn = document.getElementById('closeProviderConfigModal');
  const cancelBtn = document.getElementById('cancelProviderConfigBtn');
  const saveBtn = document.getElementById('saveProviderConfigBtn');
  const addApiBtn = document.getElementById('addApiKeyBtn');

  const closeChatBtn = document.getElementById('closeTestChatModal');
  const sendBtn = document.getElementById('sendTestMessage');
  const chatInput = document.getElementById('testChatInput');

  if (closeBtn) closeBtn.addEventListener('click', closeProviderConfig);
  if (cancelBtn) cancelBtn.addEventListener('click', closeProviderConfig);
  if (saveBtn) saveBtn.addEventListener('click', saveProviderChanges);
  if (addApiBtn) addApiBtn.addEventListener('click', addNewApiKey);

  if (closeChatBtn) closeChatBtn.addEventListener('click', closeTestChat);
  if (sendBtn) sendBtn.addEventListener('click', sendTestMessage);
  if (chatInput) {
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendTestMessage();
      }
    });
  }

  const configModal = document.getElementById('providerConfigModal');
  if (configModal) {
    configModal.addEventListener('click', (e) => {
      if (e.target === configModal) closeProviderConfig();
    });
  }

  const chatModal = document.getElementById('testChatModal');
  if (chatModal) {
    chatModal.addEventListener('click', (e) => {
      if (e.target === chatModal) closeTestChat();
    });
  }
}

function openProviderConfig(providerId) {
  const provider = providersData.find(p => p.id === providerId);
  if (!provider) return;

  currentEditingProvider = provider;

  // Fill form
  document.getElementById('editProviderName').value = provider.name;

  // Render API keys
  renderApiKeysList(provider);

  // Render models
  renderConfigModelsList(provider);

  // Open modal
  document.getElementById('providerConfigTitle').textContent = `Configurar: ${provider.name}`;
  document.getElementById('providerConfigModal').classList.add('active');
}

function closeProviderConfig() {
  document.getElementById('providerConfigModal').classList.remove('active');
  currentEditingProvider = null;
}

function renderApiKeysList(provider) {
  const container = document.getElementById('apiKeysList');
  const apiKeys = provider.apiKeys || [provider.apiKey];

  container.innerHTML = '';
  apiKeys.forEach((key, index) => {
    const item = document.createElement('div');
    item.className = 'api-key-item';
    item.innerHTML = `
      <input type="password" value="${key}" data-index="${index}" class="api-key-input" readonly>
      <button class="btn-icon toggle-visibility" title="Mostrar/Ocultar">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
          <circle cx="12" cy="12" r="3"/>
        </svg>
      </button>
      ${apiKeys.length > 1 ? `<button class="btn-icon delete" data-index="${index}" title="Remover">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>` : ''}
    `;
    container.appendChild(item);
  });

  // Toggle visibility
  container.querySelectorAll('.toggle-visibility').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = btn.parentElement.querySelector('.api-key-input');
      input.type = input.type === 'password' ? 'text' : 'password';
    });
  });

  // Delete key
  container.querySelectorAll('.btn-icon.delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const index = parseInt(btn.dataset.index);
      const keys = provider.apiKeys || [provider.apiKey];
      keys.splice(index, 1);
      provider.apiKeys = keys;
      provider.apiKey = keys[0] || '';
      renderApiKeysList(provider);
    });
  });
}

function addNewApiKey() {
  if (!currentEditingProvider) return;

  const keys = currentEditingProvider.apiKeys || [currentEditingProvider.apiKey];
  keys.push('');
  currentEditingProvider.apiKeys = keys;
  renderApiKeysList(currentEditingProvider);

  // Focus on the new input
  const inputs = document.querySelectorAll('#apiKeysList .api-key-input');
  if (inputs.length > 0) {
    const lastInput = inputs[inputs.length - 1];
    lastInput.readOnly = false;
    lastInput.type = 'text';
    lastInput.focus();
  }
}

function renderConfigModelsList(provider) {
  const container = document.getElementById('configModelsList');
  container.innerHTML = '';

  provider.models.forEach(model => {
    const item = document.createElement('div');
    item.className = 'config-model-item';
    item.innerHTML = `
      <div class="config-model-info">
        <div class="config-model-name">${model.name}</div>
        <div class="config-model-id">${model.id}</div>
        ${model.limits ? `<div class="config-model-limits">${model.limits}</div>` : ''}
      </div>
      <div class="config-model-actions">
        <button class="provider-card-edit test-model-btn" data-model-id="${model.id}" title="Testar Modelo">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
          Testar
        </button>
      </div>
    `;
    container.appendChild(item);
  });

  // Add test listeners
  container.querySelectorAll('.test-model-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const modelId = btn.dataset.modelId;
      openTestChat(modelId);
    });
  });
}

function saveProviderChanges() {
  if (!currentEditingProvider) return;

  const newName = document.getElementById('editProviderName').value.trim();
  if (!newName) {
    alert('Por favor, insira um nome para o provedor.');
    return;
  }

  // Save API keys
  const keyInputs = document.querySelectorAll('#apiKeysList .api-key-input');
  const apiKeys = [];
  keyInputs.forEach(input => {
    const val = input.value.trim();
    if (val) apiKeys.push(val);
  });

  if (apiKeys.length === 0) {
    alert('Por favor, mantenha pelo menos uma chave API.');
    return;
  }

  // Update provider
  currentEditingProvider.name = newName;
  currentEditingProvider.apiKeys = apiKeys;
  currentEditingProvider.apiKey = apiKeys[0];

  saveProviders();
  renderProvidersList();
  closeProviderConfig();
}

// ============================================
// Test Chat
// ============================================
function openTestChat(modelId) {
  if (!currentEditingProvider) return;

  const model = currentEditingProvider.models.find(m => m.id === modelId);
  if (!model) return;

  currentTestModel = model;
  currentTestProvider = currentEditingProvider;
  testChatHistory = [];

  document.getElementById('testChatTitle').textContent = `Testar: ${model.name}`;
  document.getElementById('testChatHistory').innerHTML = '<div class="test-chat-empty">Envie uma mensagem para testar o modelo...</div>';
  document.getElementById('testChatInput').value = '';
  document.getElementById('testChatModal').classList.add('active');

  setTimeout(() => {
    document.getElementById('testChatInput').focus();
  }, 100);
}

function closeTestChat() {
  document.getElementById('testChatModal').classList.remove('active');
  currentTestModel = null;
  currentTestProvider = null;
  testChatHistory = [];
}

async function sendTestMessage() {
  const input = document.getElementById('testChatInput');
  const message = input.value.trim();

  if (!message || !currentTestModel || !currentTestProvider) return;

  // Clear input
  input.value = '';

  // Add user message to history
  addChatMessage('user', message);

  // Show loading
  const loadingId = addChatMessage('assistant', 'Pensando...', true);

  // Get API key
  const apiKeys = currentTestProvider.apiKeys || [currentTestProvider.apiKey];
  const apiKey = apiKeys[0];

  if (!apiKey) {
    updateChatMessage(loadingId, 'error', 'Nenhuma chave API configurada.');
    return;
  }

  try {
    const response = await callAIModel(currentTestProvider.name, currentTestModel.id, apiKey, message);
    updateChatMessage(loadingId, 'assistant', response);
  } catch (error) {
    updateChatMessage(loadingId, 'error', `Erro: ${error.message}`);
  }
}

function addChatMessage(role, content, isLoading = false) {
  const container = document.getElementById('testChatHistory');
  const emptyMsg = container.querySelector('.test-chat-empty');
  if (emptyMsg) emptyMsg.remove();

  const id = 'msg-' + Date.now();
  const div = document.createElement('div');
  div.className = `test-chat-message ${role}`;
  div.id = id;
  div.textContent = content;

  if (isLoading) {
    div.style.opacity = '0.6';
  }

  container.appendChild(div);
  container.scrollTop = container.scrollHeight;

  return id;
}

function updateChatMessage(id, role, content) {
  const div = document.getElementById(id);
  if (!div) return;

  div.className = `test-chat-message ${role}`;
  div.textContent = content;
  div.style.opacity = '1';

  const container = document.getElementById('testChatHistory');
  container.scrollTop = container.scrollHeight;
}

async function callAIModel(providerName, modelId, apiKey, message) {
  const lowerProvider = providerName.toLowerCase();

  // OpenRouter
  if (lowerProvider.includes('openrouter')) {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://link-no-whatsapp.app',
        'X-Title': 'Link no WhatsApp'
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: message }],
        max_tokens: 1024
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error?.message || `Erro HTTP: ${response.status}`);
    }

    return data.choices?.[0]?.message?.content || 'Sem resposta';
  }

  // Google AI Studio
  if (lowerProvider.includes('google')) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: message }] }]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error?.message || `Erro HTTP: ${response.status}`);
    }

    return data.candidates?.[0]?.content?.parts?.[0]?.text || 'Sem resposta';
  }

  // OpenAI compatible
  if (lowerProvider.includes('openai') || lowerProvider.includes('groq') || lowerProvider.includes('deepseek') || lowerProvider.includes('mistral')) {
    const baseUrl = lowerProvider.includes('groq') ? 'https://api.groq.com/openai' :
                    lowerProvider.includes('deepseek') ? 'https://api.deepseek.com' :
                    lowerProvider.includes('mistral') ? 'https://api.mistral.ai' :
                    'https://api.openai.com';

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: message }],
        max_tokens: 1024
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error?.message || `Erro HTTP: ${response.status}`);
    }

    return data.choices?.[0]?.message?.content || 'Sem resposta';
  }

  throw new Error('Provedor no suportado para teste');
}

// ============================================
// WhatsApp Integration
// ============================================
let selectedConversation = null;
let currentZapId = null;
let currentConnectMethod = 'qrcode';

function initWhatsApp() {
  if (!window.electronAPI) return;

  window.electronAPI.onWhatsAppQR((data) => {
    const { zapId, qr, dataUrl } = data;
    showQRCode(zapId, qr, dataUrl);
  });

  window.electronAPI.onWhatsAppPairingCode((data) => {
    const { zapId, code } = data;
    showPairingCode(zapId, code);
  });

  window.electronAPI.onWhatsAppStatus((data) => {
    const { zapId, status, error } = data;
    updateZapStatus(zapId, status, error);
  });

  window.electronAPI.onWhatsAppMessage((data) => {
    handleIncomingMessage(data);
    // Track usage when AI sends a reply
    if (data.isReply && data.reply) {
      const tokens = estimateTokens(data.reply) + estimateTokens(data.body || '');
      trackUsage(data.zapId, tokens, 1);
    } else if (!data.fromMe && data.body && data.body !== '[AUDIO]') {
      // Track incoming message count
      trackUsage(data.zapId, 0, 1);
    }
  });

  window.electronAPI.onWhatsAppTyping((data) => {
    const { zapId, chatId, isTyping } = data;
    showTypingIndicator(zapId, chatId, isTyping);
  });

  window.electronAPI.onWhatsAppLog((data) => {
    addLog(data.zapId, data.type, data.msg);
  });

  if (window.electronAPI.onWhatsAppContactsUpdated) {
    window.electronAPI.onWhatsAppContactsUpdated((data) => {
      if (currentPanelZapId != null && String(data.zapId) === String(currentPanelZapId)) {
        loadPanelContacts(currentPanelZapId);
      }
    });
  }

  initConnectModal();
  initConversationsPage();
}

// ============================================
// Typing Indicator
// ============================================
function showTypingIndicator(zapId, chatId, isTyping) {
  const chatMessages = document.getElementById('chatMessages');
  if (!chatMessages) return;

  // Remove existing typing indicator
  const existing = chatMessages.querySelector('.typing-indicator');
  if (existing) existing.remove();

  if (isTyping) {
    const typingDiv = document.createElement('div');
    typingDiv.className = 'typing-indicator';
    typingDiv.innerHTML = `
      <div class="typing-bubble">
        <span class="typing-dot"></span>
        <span class="typing-dot"></span>
        <span class="typing-dot"></span>
      </div>
      <span class="typing-text">digitando...</span>
    `;
    chatMessages.appendChild(typingDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
}

// ============================================
// Connection Modal
// ============================================
function initConnectModal() {
  const modal = document.getElementById('connectModal');
  const closeBtn = document.getElementById('closeConnectModal');
  const tabs = document.querySelectorAll('.connect-tab');
  const generateBtn = document.getElementById('generatePairingCode');
  const copyBtn = document.getElementById('copyPairingCode');

  if (closeBtn) closeBtn.addEventListener('click', closeConnectModal);
  if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeConnectModal(); });

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const method = tab.dataset.method;
      currentConnectMethod = method;
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.connect-tab-content').forEach(c => c.classList.remove('active'));
      document.getElementById(method === 'qrcode' ? 'tabQrcode' : 'tabPairing').classList.add('active');
    });
  });

  if (generateBtn) generateBtn.addEventListener('click', generatePairingCode);
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      const code = document.getElementById('pairingCodeValue').textContent;
      navigator.clipboard.writeText(code).then(() => {
        copyBtn.textContent = 'Copiado!';
        setTimeout(() => { copyBtn.textContent = 'Copiar Cdigo'; }, 2000);
      });
    });
  }
}

function openConnectModal(zapId, zapName, zapPhone) {
  currentZapId = zapId;
  const modal = document.getElementById('connectModal');

  document.getElementById('connectZapNameQr').textContent = zapName;
  document.getElementById('connectZapNamePair').textContent = zapName;

  document.getElementById('qrLoading').style.display = 'flex';
  document.getElementById('qrImage').style.display = 'none';
  document.getElementById('qrStatus').textContent = 'Aguardando QR Code...';
  document.getElementById('qrStatus').className = 'connect-status';

  document.getElementById('pairingForm').style.display = 'block';
  document.getElementById('pairingCodeDisplay').style.display = 'none';
  document.getElementById('pairingStatus').textContent = '';
  document.getElementById('pairingPhone').value = zapPhone ? zapPhone.replace(/\D/g, '') : '';

  document.getElementById('connectProgress').style.display = 'none';

  document.querySelectorAll('.connect-tab').forEach(t => t.classList.remove('active'));
  document.querySelector('.connect-tab[data-method="qrcode"]').classList.add('active');
  document.querySelectorAll('.connect-tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById('tabQrcode').classList.add('active');
  currentConnectMethod = 'qrcode';

  modal.classList.add('active');
}

function closeConnectModal() {
  document.getElementById('connectModal').classList.remove('active');
  currentZapId = null;
}

function showQRCode(zapId, qr, dataUrl) {
  if (currentZapId != zapId && currentZapId != String(zapId)) return;

  const qrLoading = document.getElementById('qrLoading');
  const qrImage = document.getElementById('qrImage');
  const qrStatus = document.getElementById('qrStatus');
  const connectProgress = document.getElementById('connectProgress');

  connectProgress.style.display = 'none';
  qrLoading.style.display = 'none';
  qrImage.style.display = 'block';
  qrImage.innerHTML = '';

  const img = document.createElement('img');
  // Prefer dataUrl generated locally in main process (privacy, no external request)
  if (dataUrl && dataUrl.startsWith('data:')) {
    img.src = dataUrl;
  } else {
    // Fallback: generate via canvas using a tiny inline QR if possible, otherwise use remote (last resort)
    // Try to use browser's own generation if we have raw qr string - fallback to remote
    img.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(qr)}`;
    img.onerror = () => { qrStatus.textContent = 'Falha ao carregar QR. Tente reconectar.'; qrStatus.className='connect-status error'; };
  }
  img.alt = 'QR Code';
  img.style.width = '180px'; img.style.height = '180px';
  qrImage.appendChild(img);

  qrStatus.textContent = 'Escaneie o QR Code com seu WhatsApp';
  qrStatus.className = 'connect-status';
}

function showPairingCode(zapId, code) {
  if (currentZapId != zapId) return;

  // Clear progress interval
  const connectProgress = document.getElementById('connectProgress');
  if (connectProgress.dataset.interval) {
    clearInterval(parseInt(connectProgress.dataset.interval));
    delete connectProgress.dataset.interval;
  }

  document.getElementById('pairingForm').style.display = 'none';
  document.getElementById('pairingCodeDisplay').style.display = 'block';
  document.getElementById('pairingCodeValue').textContent = code;
  document.getElementById('pairingStatus').textContent = 'Digite o cdigo no seu celular';
  document.getElementById('pairingStatus').className = 'connect-status';
  connectProgress.style.display = 'none';
}

function generatePairingCode() {
  const phone = document.getElementById('pairingPhone').value.trim();
  if (!phone) { alert('Por favor, insira o nmero do celular.'); return; }

  const cleanPhone = phone.replace(/\D/g, '');

  if (!/^\d+$/.test(cleanPhone)) { alert('Use apenas nmeros, sem espacos ou traos.'); return; }
  if (cleanPhone.length < 10) { alert('Numero muito curto. Use o formato: cdigo do pas + DDD + numero (ex: 5511999999999)'); return; }
  if (cleanPhone.length > 15) { alert('Numero muito longo. Verifique o numero.'); return; }

  // Show progress with time estimate
  const pairingStatus = document.getElementById('pairingStatus');
  const connectProgress = document.getElementById('connectProgress');
  const connectProgressText = document.getElementById('connectProgressText');

  connectProgress.style.display = 'flex';
  connectProgressText.textContent = 'Iniciando WhatsApp Web... (pode levar 30-60 segundos)';

  let elapsed = 0;
  const progressInterval = setInterval(() => {
    elapsed += 5;
    if (elapsed < 30) {
      connectProgressText.textContent = `Carregando WhatsApp Web... (${elapsed}s)`;
    } else if (elapsed < 60) {
      connectProgressText.textContent = `Gerando cdigo de pareamento... (${elapsed}s)`;
    } else {
      connectProgressText.textContent = `Ainda processando... (${elapsed}s) - pode demorar um pouco mais`;
    }
  }, 5000);

  // Store interval so we can clear it later
  connectProgress.dataset.interval = progressInterval;

  connectZapWithMethod(currentZapId, cleanPhone, 'pairing');
}

async function connectZapWithMethod(zapId, phone, method) {
  if (!window.electronAPI) { alert('Integracao com WhatsApp nao disponivel.'); return; }

  const connectProgress = document.getElementById('connectProgress');
  const connectProgressText = document.getElementById('connectProgressText');

  connectProgress.style.display = 'flex';
  connectProgressText.textContent = method === 'pairing' ? 'Gerando cdigo...' : 'Iniciando conexo...';

  try {
    const result = await window.electronAPI.whatsappConnect(zapId.toString(), phone, method);
    // Save connect method for restart
    const zap = zapsData.find(z => String(z.id) === String(zapId));
    if (zap) {
      zap.lastConnectMethod = method;
      saveZaps();
    }
    if (result.status === 'already_connected') {
      alert('Este Zap ja esta conectado.');
      closeConnectModal();
    } else if (result.status === 'error') {
      alert('Erro ao conectar: ' + result.error);
      connectProgress.style.display = 'none';
    }
  } catch (error) {
    console.error('Erro ao conectar:', error);
    alert('Erro ao conectar: ' + error.message);
    connectProgress.style.display = 'none';
  }
}

function updateZapStatus(zapId, status, error) {
  if (currentZapId == zapId) {
    const connectProgress = document.getElementById('connectProgress');
    const qrStatus = document.getElementById('qrStatus');
    const pairingStatus = document.getElementById('pairingStatus');

    // Clear progress interval on any status change
    if (connectProgress.dataset.interval) {
      clearInterval(parseInt(connectProgress.dataset.interval));
      delete connectProgress.dataset.interval;
    }

    if (status === 'connecting') {
      connectProgress.style.display = 'flex';
      document.getElementById('connectProgressText').textContent = 'Conectando...';
    } else if (status === 'waiting_qr' || status === 'waiting_pairing') {
      connectProgress.style.display = 'none';
    } else if (status === 'ready') {
      connectProgress.style.display = 'none';
      qrStatus.textContent = 'Conectado com sucesso!';
      qrStatus.className = 'connect-status ready';
      pairingStatus.textContent = 'Conectado com sucesso!';
      pairingStatus.className = 'connect-status ready';
      setTimeout(closeConnectModal, 1500);
    } else if (status === 'auth_failure') {
      connectProgress.style.display = 'none';
      let friendlyMsg = error || 'Autenticacao negada';

      if (error && (error.includes('query_link') || error.includes('not allowed') || error.includes('linked'))) {
        friendlyMsg = 'Nao foi possivel vincular. Verifique:\n1. O numero esta correto?\n2. O WhatsApp esta aberto no celular?\n3. Ja existe outro dispositivo vinculado?';
      }

      if (currentConnectMethod === 'pairing') {
        pairingStatus.textContent = 'Erro: ' + friendlyMsg;
        pairingStatus.className = 'connect-status error';
        document.getElementById('pairingForm').style.display = 'block';
        document.getElementById('pairingCodeDisplay').style.display = 'none';
      } else {
        qrStatus.textContent = 'Erro: ' + friendlyMsg;
        qrStatus.className = 'connect-status error';
      }
    } else if (status === 'disconnected') {
      connectProgress.style.display = 'none';
      qrStatus.textContent = 'Desconectado'; qrStatus.className = 'connect-status error';
      pairingStatus.textContent = 'Desconectado'; pairingStatus.className = 'connect-status error';
    }
  }

  const zap = zapsData.find(z => z.id == zapId);
  if (zap) {
    const runtimeMap = {
      'connecting': 'connecting', 'waiting_qr': 'waiting_qr',
      'waiting_pairing': 'waiting_pairing', 'authenticated': 'authenticated',
      'ready': 'ready', 'auth_failure': 'auth_failure', 'disconnected': 'disconnected'
    };
    const runtime = runtimeMap[status] || status;
    applyRuntimeStatus(zap, runtime);
    saveZaps();
    renderZaps(zapsData);

    // Refresh panel status if open for this zap
    if (currentPanelZapId != null && String(currentPanelZapId) === String(zapId)) {
      refreshPanelStatusUI(zapId);
      const info = getZapStatusInfo(zap);
      if (info.online) {
        loadPanelContacts(zapId);
      }
    }
  }
}

// ============================================
// Conversations Page
// ============================================
function initConversationsPage() {
  const zapSelector = document.getElementById('zapSelector');
  const sendChatBtn = document.getElementById('sendChatBtn');
  const chatInput = document.getElementById('chatInput');

  if (zapSelector) {
    zapSelector.addEventListener('change', (e) => {
      const zapId = e.target.value;
      if (zapId) {
        loadConversations(zapId);
      } else {
        clearConversations();
      }
    });
  }

  if (sendChatBtn) {
    sendChatBtn.addEventListener('click', sendChatMessage);
  }

  if (chatInput) {
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage();
      }
    });
  }

  updateZapSelector();
}

function updateZapSelector() {
  const selector = document.getElementById('zapSelector');
  if (!selector) return;

  selector.innerHTML = '<option value="">Selecione um Zap</option>';
  zapsData.forEach(zap => {
    const opt = document.createElement('option');
    opt.value = zap.id;
    opt.textContent = `${zap.name} (${zap.phone})`;
    selector.appendChild(opt);
  });
}

async function loadConversations(zapId) {
  const container = document.getElementById('conversationsList');
  if (!container) return;

  container.innerHTML = '<div class="conversations-empty"><p>Carregando conversas...</p></div>';

  try {
    const conversations = await window.electronAPI.whatsappConversations(zapId.toString());
    renderConversations(conversations, zapId);
  } catch (error) {
    container.innerHTML = '<div class="conversations-empty"><p>Erro ao carregar conversas</p></div>';
  }
}

function renderConversations(conversations, zapId) {
  const container = document.getElementById('conversationsList');
  if (!container) return;

  if (!conversations || conversations.length === 0) {
    container.innerHTML = '<div class="conversations-empty"><p>Nenhuma conversa ainda</p></div>';
    return;
  }

  container.innerHTML = '';
  conversations.forEach(conv => {
    const item = document.createElement('div');
    item.className = 'conversation-item';
    item.dataset.chatId = conv.chatId;

    const lastMsg = conv.lastMessage;
    const lastMsgText = lastMsg ? (lastMsg.body || '').substring(0, 40) : 'Nenhuma mensagem';
    const lastMsgTime = lastMsg ? formatTime(lastMsg.timestamp) : '';

    item.innerHTML = `
      <div class="conversation-avatar">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#666" stroke-width="2">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
          <circle cx="12" cy="7" r="4"/>
        </svg>
      </div>
      <div class="conversation-info">
        <div class="conversation-name">${conv.contact.name}</div>
        <div class="conversation-last-msg">${lastMsgText}</div>
      </div>
      <div class="conversation-time">${lastMsgTime}</div>
    `;

    item.addEventListener('click', () => openChat(zapId, conv));
    container.appendChild(item);
  });
}

function clearConversations() {
  const container = document.getElementById('conversationsList');
  if (container) {
    container.innerHTML = '<div class="conversations-empty"><p>Selecione um Zap para ver as conversas</p></div>';
  }
  clearChat();
}

async function openChat(zapId, conversation) {
  selectedConversation = conversation;

  // Update header
  document.getElementById('chatContactName').textContent = conversation.contact.name;
  document.getElementById('chatContactStatus').textContent = `${conversation.contact.number}`;

  // Highlight selected conversation
  document.querySelectorAll('.conversation-item').forEach(item => {
    item.classList.remove('active');
    if (item.dataset.chatId === conversation.chatId) {
      item.classList.add('active');
    }
  });

  // Show input area
  document.getElementById('chatInputArea').style.display = 'flex';

  // Load messages
  try {
    const messages = await window.electronAPI.whatsappMessages(zapId.toString(), conversation.chatId);
    renderChatMessages(messages);
  } catch (error) {
    console.error('Erro ao carregar mensagens:', error);
  }
}

function renderChatMessages(messages) {
  const container = document.getElementById('chatMessages');
  if (!container) return;

  if (!messages || messages.length === 0) {
    container.innerHTML = '<div class="chat-empty"><p>Nenhuma mensagem</p></div>';
    return;
  }

  container.innerHTML = '';
  messages.forEach(msg => {
    const div = document.createElement('div');
    const isOutgoing = msg.fromMe;
    const isReply = msg.isReply;

    let msgClass = 'incoming';
    if (isOutgoing) msgClass = 'outgoing';
    if (isReply) msgClass = 'ai-reply';

    div.className = `chat-message ${msgClass}`;
    div.innerHTML = `
      <div class="chat-message-text">${msg.body}</div>
      <div class="chat-message-time">${formatTime(msg.timestamp)}</div>
    `;
    container.appendChild(div);
  });

  container.scrollTop = container.scrollHeight;
}

function clearChat() {
  const container = document.getElementById('chatMessages');
  if (container) {
    container.innerHTML = `
      <div class="chat-empty">
        <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="#ccc" stroke-width="1.5">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        <p>Selecione uma conversa para visualizar</p>
      </div>
    `;
  }
  document.getElementById('chatInputArea').style.display = 'none';
}

async function sendChatMessage() {
  const input = document.getElementById('chatInput');
  const message = input.value.trim();
  if (!message || !selectedConversation || !currentZapId) return;

  input.value = '';

  try {
    await window.electronAPI.whatsappSend(
      currentZapId.toString(),
      selectedConversation.contact.number,
      message
    );

    // Add message to chat
    const container = document.getElementById('chatMessages');
    const div = document.createElement('div');
    div.className = 'chat-message outgoing';
    div.innerHTML = `
      <div class="chat-message-text">${message}</div>
      <div class="chat-message-time">${formatTime(Date.now() / 1000)}</div>
    `;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  } catch (error) {
    console.error('Erro ao enviar mensagem:', error);
    alert('Erro ao enviar mensagem: ' + error.message);
  }
}

function handleIncomingMessage(data) {
  const { zapId, body, from, contact, chat, isReply, reply } = data;

  // Update conversations list if viewing this zap
  const zapSelector = document.getElementById('zapSelector');
  if (zapSelector && zapSelector.value == zapId) {
    loadConversations(zapId);
  }

  // Update chat if viewing this conversation
  if (selectedConversation && selectedConversation.chatId === chat.id) {
    const container = document.getElementById('chatMessages');
    const div = document.createElement('div');

    if (isReply && reply) {
      div.className = 'chat-message ai-reply';
      div.innerHTML = `
        <div class="chat-message-text">${reply}</div>
        <div class="chat-message-time">${formatTime(data.timestamp)}</div>
      `;
    } else {
      div.className = 'chat-message incoming';
      div.innerHTML = `
        <div class="chat-message-text">${body}</div>
        <div class="chat-message-time">${formatTime(data.timestamp)}</div>
      `;
    }

    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }
}

function formatTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp * 1000);
  return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

// ============================================
// Training System
// ============================================
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDateShort(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function createThumb(base64, maxDim = 120) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let w = img.width;
      let h = img.height;
      if (w > h) {
        if (w > maxDim) { h = Math.round(h * maxDim / w); w = maxDim; }
      } else {
        if (h > maxDim) { w = Math.round(w * maxDim / h); h = maxDim; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = () => resolve(base64);
    img.src = base64;
  });
}

async function persistTrainings(deletedFiles = []) {
  if (!window.electronAPI) return;
  try {
    await window.electronAPI.saveTrainings(trainingsData, deletedFiles);
  } catch (e) {
    console.error('Erro ao salvar treinamentos:', e);
    alert('Erro ao salvar treinamentos.');
  }
}

function renderTrainingZapsList() {
  const container = document.getElementById('trainingZapsList');
  if (!container) return;

  if (zapsData.length === 0) {
    container.innerHTML = '<p class="empty-hint">Nenhum Zap criado ainda. Crie um Zap primeiro.</p>';
    return;
  }

  container.innerHTML = '';
  zapsData.forEach(zap => {
    const count = (trainingsData[String(zap.id)] || []).length;
    const item = document.createElement('div');
    item.className = 'training-zap-item';
    item.innerHTML = `
      <div class="training-zap-info">
        <span class="training-zap-name">${escapeHtml(zap.name)}</span>
        <span class="training-zap-phone">${escapeHtml(zap.phone)}</span>
      </div>
      <div class="training-zap-meta">
        <span class="training-zap-count">${count} treinamento${count === 1 ? '' : 's'}</span>
        <span class="training-zap-arrow">&rsaquo;</span>
      </div>
    `;
    item.addEventListener('click', () => openTrainingEditor(zap.id));
    container.appendChild(item);
  });
}

function openTrainingEditor(zapId) {
  currentTrainingZapId = String(zapId);
  const zap = zapsData.find(z => String(z.id) === String(zapId));
  const zapsView = document.getElementById('trainingZapsView');
  const editorView = document.getElementById('trainingEditorView');
  if (zapsView) zapsView.style.display = 'none';
  if (editorView) editorView.style.display = 'block';
  const title = document.getElementById('trainingEditorTitle');
  if (title) title.textContent = zap ? `Treinamentos - ${zap.name}` : 'Treinamentos';
  renderTrainingsList();
}

function closeTrainingEditor() {
  currentTrainingZapId = null;
  const zapsView = document.getElementById('trainingZapsView');
  const editorView = document.getElementById('trainingEditorView');
  if (zapsView) zapsView.style.display = 'block';
  if (editorView) editorView.style.display = 'none';
}

function renderTrainingsList() {
  const container = document.getElementById('trainingsList');
  if (!container || currentTrainingZapId == null) return;

  const list = trainingsData[String(currentTrainingZapId)] || [];
  if (list.length === 0) {
    container.innerHTML = '<p class="empty-hint">Nenhum treinamento ainda. Clique em "Adicionar Treinamento" para começar.</p>';
    return;
  }

  container.innerHTML = '';
  list.forEach(t => {
    const content = t.content || '';
    const preview = content.substring(0, 180);
    const imgs = Array.isArray(t.images) ? t.images : [];
    const item = document.createElement('div');
    item.className = 'training-item' + (t.enabled === false ? ' disabled' : '');
    item.innerHTML = `
      <div class="training-item-main">
        <div class="training-item-title">${escapeHtml(t.title || 'Sem título')}</div>
        <div class="training-item-preview">${escapeHtml(preview)}${content.length > 180 ? '...' : ''}</div>
        <div class="training-item-meta">
          <span>${t.enabled === false ? 'Desativado' : 'Ativado'}</span>
          ${imgs.length ? `<span>${imgs.length} imagem${imgs.length === 1 ? '' : 's'}</span>` : ''}
          <span>Atualizado ${formatDateShort(t.updatedAt || t.createdAt)}</span>
        </div>
        ${imgs.length ? `<div class="training-item-thumbs">${imgs.map(i => `<img src="${i.thumb || ''}" alt="" class="training-item-thumb">`).join('')}</div>` : ''}
      </div>
      <div class="training-item-actions">
        <button class="btn btn-outline" data-action="toggle" data-id="${t.id}">${t.enabled === false ? 'Ativar' : 'Desativar'}</button>
        <button class="btn btn-outline" data-action="edit" data-id="${t.id}">Editar</button>
        <button class="btn btn-outline" data-action="delete" data-id="${t.id}">Excluir</button>
      </div>
    `;
    container.appendChild(item);
  });
}

function updateTrainingCharCount() {
  const el = document.getElementById('trainingCharCount');
  const content = document.getElementById('trainingContent');
  if (el && content) {
    el.textContent = `${content.value.length} caracteres`;
  }
}

function renderModalImages() {
  const container = document.getElementById('trainingImagesList');
  if (!container) return;

  if (modalPendingImages.length === 0) {
    container.innerHTML = '<p class="form-hint" style="margin-top:8px;margin-bottom:0">Nenhuma imagem adicionada.</p>';
    return;
  }

  container.innerHTML = '';
  modalPendingImages.forEach((img, idx) => {
    const div = document.createElement('div');
    div.className = 'modal-image-item';
    const thumb = img.thumb || img.data || '';
    div.innerHTML = `
      <img src="${thumb}" alt="${escapeHtml(img.filename || 'imagem')}" class="modal-image-thumb">
      <div class="modal-image-info">
        <div class="modal-image-name">${escapeHtml(img.filename || 'imagem')}</div>
        <input type="text" class="modal-image-desc" placeholder="Descrição (ex: Cardápio do almoço)" value="${escapeHtml(img.description || '')}" data-idx="${idx}">
      </div>
      <button type="button" class="modal-image-remove" data-idx="${idx}" title="Remover">&times;</button>
    `;
    container.appendChild(div);
  });

  container.querySelectorAll('.modal-image-desc').forEach(input => {
    input.addEventListener('input', (e) => {
      const idx = parseInt(e.target.dataset.idx, 10);
      if (modalPendingImages[idx]) {
        modalPendingImages[idx].description = e.target.value;
      }
    });
  });

  container.querySelectorAll('.modal-image-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.currentTarget.dataset.idx, 10);
      const img = modalPendingImages[idx];
      if (img && img.file) {
        modalDeletedFiles.push(img.file);
      }
      modalPendingImages.splice(idx, 1);
      renderModalImages();
    });
  });
}

async function processTrainingFiles(fileList) {
  const files = Array.from(fileList || []);
  for (const file of files) {
    if (!file.type || !file.type.startsWith('image/')) continue;
    if (file.size > 5 * 1024 * 1024) {
      alert(`Imagem "${file.name}" maior que 5MB.`);
      continue;
    }
    if (modalPendingImages.length >= 10) {
      alert('Máximo de 10 imagens por treinamento.');
      break;
    }
    try {
      const data = await fileToBase64(file);
      const thumb = await createThumb(data);
      modalPendingImages.push({
        id: 'img_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        filename: file.name,
        mimeType: file.type,
        description: '',
        thumb,
        data
      });
    } catch (e) {
      console.error('Erro ao ler imagem:', e);
      alert(`Erro ao ler a imagem "${file.name}".`);
    }
  }
  renderModalImages();
}

function openTrainingModal(trainingId = null) {
  editingTrainingId = trainingId;
  modalPendingImages = [];
  modalDeletedFiles = [];

  const modal = document.getElementById('trainingModal');
  const titleInput = document.getElementById('trainingTitle');
  const contentInput = document.getElementById('trainingContent');
  const modalTitle = document.getElementById('trainingModalTitle');
  if (!modal || !titleInput || !contentInput) return;

  if (trainingId) {
    const list = trainingsData[String(currentTrainingZapId)] || [];
    const t = list.find(x => x.id === trainingId);
    if (!t) return;
    if (modalTitle) modalTitle.textContent = 'Editar Treinamento';
    titleInput.value = t.title || '';
    contentInput.value = t.content || '';
    modalPendingImages = JSON.parse(JSON.stringify(t.images || []));
  } else {
    if (modalTitle) modalTitle.textContent = 'Adicionar Treinamento';
    titleInput.value = '';
    contentInput.value = '';
  }

  updateTrainingCharCount();
  renderModalImages();
  modal.classList.add('active');
}

function closeTrainingModal() {
  const modal = document.getElementById('trainingModal');
  if (modal) modal.classList.remove('active');
  editingTrainingId = null;
  modalPendingImages = [];
  modalDeletedFiles = [];
}

async function saveTrainingFromModal() {
  if (currentTrainingZapId == null) return;

  const title = (document.getElementById('trainingTitle')?.value || '').trim();
  const content = (document.getElementById('trainingContent')?.value || '').trim();

  if (!content && modalPendingImages.length === 0) {
    alert('Adicione um conteúdo ou pelo menos uma imagem.');
    return;
  }

  const images = modalPendingImages.map(img => {
    const out = {
      id: img.id,
      filename: img.filename,
      mimeType: img.mimeType,
      description: img.description || '',
      thumb: img.thumb || null
    };
    if (img.file) out.file = img.file;
    if (img.data) out.data = img.data;
    return out;
  });

  const key = String(currentTrainingZapId);
  if (!trainingsData[key]) trainingsData[key] = [];
  const list = trainingsData[key];
  const now = Date.now();

  if (editingTrainingId) {
    const t = list.find(x => x.id === editingTrainingId);
    if (t) {
      t.title = title;
      t.content = content;
      t.images = images;
      t.updatedAt = now;
    }
  } else {
    list.push({
      id: 'tr_' + now + '_' + Math.random().toString(36).slice(2, 8),
      title,
      content,
      images,
      enabled: true,
      createdAt: now,
      updatedAt: now
    });
  }

  const deleted = modalDeletedFiles.slice();
  await persistTrainings(deleted);
  closeTrainingModal();
  renderTrainingsList();
}

async function handleTrainingListAction(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn || currentTrainingZapId == null) return;
  const id = btn.dataset.id;
  const action = btn.dataset.action;
  const key = String(currentTrainingZapId);
  const list = trainingsData[key] || [];
  const t = list.find(x => x.id === id);
  if (!t) return;

  if (action === 'edit') {
    openTrainingModal(id);
    return;
  }

  if (action === 'toggle') {
    t.enabled = t.enabled === false ? true : false;
    t.updatedAt = Date.now();
    await persistTrainings();
    renderTrainingsList();
    return;
  }

  if (action === 'delete') {
    if (!confirm('Excluir este treinamento?')) return;
    const deleted = [];
    if (Array.isArray(t.images)) {
      t.images.forEach(img => {
        if (img && img.file) deleted.push(img.file);
      });
    }
    trainingsData[key] = list.filter(x => x.id !== id);
    await persistTrainings(deleted);
    renderTrainingsList();
  }
}

function setupTrainingListeners() {
  document.getElementById('backToTrainingZaps')?.addEventListener('click', closeTrainingEditor);
  document.getElementById('addTrainingBtn')?.addEventListener('click', () => openTrainingModal());
  document.getElementById('closeTrainingModal')?.addEventListener('click', closeTrainingModal);
  document.getElementById('cancelTraining')?.addEventListener('click', closeTrainingModal);
  document.getElementById('saveTraining')?.addEventListener('click', saveTrainingFromModal);

  document.getElementById('trainingModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'trainingModal') closeTrainingModal();
  });

  document.getElementById('trainingImageInput')?.addEventListener('change', (e) => {
    processTrainingFiles(e.target.files);
    e.target.value = '';
  });

  document.getElementById('trainingContent')?.addEventListener('input', updateTrainingCharCount);
  document.getElementById('trainingsList')?.addEventListener('click', handleTrainingListAction);
}

// ============================================
// Start App
// ============================================
document.addEventListener('DOMContentLoaded', () => {
  try { init(); } catch (e) { console.error('Erro no init:', e); }
  try { initWhatsApp(); } catch (e) { console.error('Erro no initWhatsApp:', e); }
  try { setupTrainingListeners(); } catch (e) { console.error('Erro em setupTrainingListeners:', e); }
});
