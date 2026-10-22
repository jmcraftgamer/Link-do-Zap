// ============================================
// Link no WhatsApp - App Logic
// ============================================

// Defensive patch for native dialog focus bug
if (window.electronAPI && window.electronAPI.nativeAlert) {
  window.alert = (m) => window.electronAPI.nativeAlert(String(m));
  window.confirm = (m) => window.electronAPI.nativeConfirm(String(m));
}

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

// Modo servidor: o app local e o painel; o WhatsApp roda 24h no servidor.
// Nesse modo nao conectamos nada por aqui e as configs sincronizam sozinhas.
let serverManaged = false;

// Training state
let trainingsData = {};
let currentTrainingZapId = null;
let editingTrainingId = null;
let modalPendingImages = [];
let modalDeletedFiles = [];
let modalPendingLinks = [];

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

// Chaves de IA vem do ambiente (preload -> env), nunca hardcoded no repositorio
const BOOTSTRAP_KEYS = (window.electronAPI && window.electronAPI.bootstrapKeys) || {};

// Pre-configured OpenRouter provider
const OPENROUTER_PRECONFIGURED = {
  id: 'openrouter-preconfig',
  name: 'OpenRouter',
  apiKey: BOOTSTRAP_KEYS.openrouter || '',
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
  apiKey: BOOTSTRAP_KEYS.googleai || '',
  models: [
    { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', free: true, limits: '10 RPM | 250k TPM | 250 RPD' },
    { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', free: true, limits: '10 RPM | 250k TPM | 250 RPD' },
    { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash-Lite', free: true, limits: '15 RPM | 250k TPM | 1.000 RPD' },
    { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash-Lite', free: true, limits: '15 RPM | 250k TPM | 1.000 RPD' }
  ],
  createdAt: new Date().toISOString(),
  preconfigured: true
};

const existingGoogle = providersData.find(p => p.id === 'googleai-preconfig');
if (!existingGoogle) {
  providersData.unshift(GOOGLEAI_PRECONFIGURED);
  localStorage.setItem('linknozap_providers', JSON.stringify(providersData));
} else {
  // Remove modelos que contas novas do AI Studio nao aceitam mais (2.5/2.0/1.5
  // retornam 404 "no longer available to new users") antes de garantir os
  // oficiais - sem isso eles ficam no painel e toda requisicao cai neles.
  existingGoogle.models = (existingGoogle.models || [])
    .filter(em => em && em.id && !/^gemini-(2\.5|2\.0|1\.5)/.test(em.id));
  // Garante que o provedor existente receba os modelos oficiais
  GOOGLEAI_PRECONFIGURED.models.forEach(m => {
    if (!existingGoogle.models.some(em => em && em.id === m.id)) {
      existingGoogle.models.push(m);
    }
  });
  localStorage.setItem('linknozap_providers', JSON.stringify(providersData));
}

// Se o preconfig existe mas sem chave, preenche a partir do ambiente
function fillEmptyBootstrapKey(providerId, envKey) {
  if (!envKey) return;
  const p = providersData.find(pp => pp.id === providerId);
  if (p && !p.apiKey) {
    p.apiKey = envKey;
    localStorage.setItem('linknozap_providers', JSON.stringify(providersData));
  }
}
fillEmptyBootstrapKey('openrouter-preconfig', BOOTSTRAP_KEYS.openrouter);
fillEmptyBootstrapKey('googleai-preconfig', BOOTSTRAP_KEYS.googleai);

// DOM Elements
const menuItems = document.querySelectorAll('.menu-item');
const pages = document.querySelectorAll('.page');
const zapsList = document.getElementById('zapsList');
const searchInput = document.getElementById('searchInput');
const searchClearBtn = document.getElementById('searchClear');
const searchDropdown = document.getElementById('searchDropdown');
let globalSearchQuery = '';
let searchDdItems = [];
let searchDdIndex = -1;
let lastRenderedConversations = null;
let lastRenderedConversationsZapId = null;
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
    pairing_accepted: { label: 'Sincronizando...', className: 'connecting', online: false },
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

// Indicador de status do painel: verde (ok), amarelo (falhas recentes) e
// vermelho (desligado/desconectado ou erro - neste caso com X no circulo).
const RECENT_ERROR_MS = 10 * 60 * 1000;

function computePanelIndicator(zap, info) {
  info = info || getZapStatusInfo(zap);
  const lastErr = Number(zap.lastErrorAt || 0);
  const recentError = lastErr && (Date.now() - lastErr) < RECENT_ERROR_MS;

  if (info.online) {
    return recentError
      ? { cls: 'warn', title: 'Funcionando, mas com falhas recentes' }
      : { cls: 'ok', title: 'Servidor funcionando e IA respondendo' };
  }
  if (info.className === 'error') {
    return { cls: 'bad error', title: 'Erro: ' + info.label };
  }
  return { cls: 'bad', title: info.label || 'Desconectado' };
}

async function refreshAllZapStatuses() {
  if (!window.electronAPI || !zapsData.length) return;

  let serverZaps = null;
  if (serverManaged && window.electronAPI.serverStatus) {
    try {
      const bs = await window.electronAPI.serverStatus();
      if (bs && Array.isArray(bs.zaps)) serverZaps = bs.zaps;
    } catch (_) {}
  }

  let changed = false;
  for (const zap of zapsData) {
    try {
      let next;
      if (serverZaps) {
        const sz = serverZaps.find(s => String(s.id) === String(zap.id));
        next = sz ? (sz.status || 'disconnected') : 'disconnected';
        zap.lastErrorAt = sz && sz.lastErrorAt ? Number(sz.lastErrorAt) : null;
      } else {
        const st = await window.electronAPI.whatsappStatus(String(zap.id));
        next = (st && st.status) || 'disconnected';
      }
      const prev = zap.runtimeStatus;
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

  if (autoMsgInitialized) {
    renderAutoMsgAccounts();
    updateAutoMsgConnectBtn();
  }
}

function refreshPanelStatusUI(zapId) {
  const zap = zapsData.find(z => String(z.id) === String(zapId));
  if (!zap) return;

  const statusEl = document.getElementById('zapPanelStatus');
  const info = getZapStatusInfo(zap);
  if (statusEl) {
    const ind = computePanelIndicator(zap, info);
    statusEl.className = 'panel-status-dot ' + ind.cls;
    statusEl.title = ind.title;
  }

  const connectBtn = document.getElementById('zapPanelConnect');
  if (serverManaged) {
    connectBtn.disabled = false;
    connectBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M5 12h14"/><path d="M12 5v14"/></svg> Gerenciado pelo servidor`;
    connectBtn.className = 'zap-panel-connect-btn';
    connectBtn.onclick = () => { openConnectModal(zap.id, zap.name, zap.phone); };
    return;
  }
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
    if (zap.enabled !== true) zap.enabled = true;
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

  // Detecta se este app e o painel do servidor 24h
  if (window.electronAPI && window.electronAPI.serverInfo) {
    window.electronAPI.serverInfo().then((info) => {
      serverManaged = !!(info && info.enabled);
      renderZaps(zapsData);
      if (serverManaged && currentPanelZapId != null) refreshPanelStatusUI(currentPanelZapId);
    }).catch(() => {});
  }

  setupEventListeners();
  initProviders();
  initProviderConfig();

  // O config real fica no processo principal (zaps.json). Carrega dele antes de
  // qualquer escrita; so usa o cache do localStorage se ainda nao houver config.
  if (window.electronAPI) {
    Promise.resolve(window.electronAPI.loadZaps()).then((list) => {
      if (Array.isArray(list)) {
        // O arquivo de config existe e manda, mesmo quando esta vazio (zap removido).
        zapsData = list;
        zapsData.forEach((zap) => {
          if (zap.enabled !== true) zap.enabled = true;
          try { applyRuntimeStatus(zap, zap.runtimeStatus || 'disconnected'); } catch (_) {}
        });
        try { localStorage.setItem('linknozap_zaps', JSON.stringify(zapsData)); } catch (_) {}
        renderZaps(zapsData);
        updateZapSelector();
      } else if (zapsData.length) {
        // Primeira execucao (sem arquivo): migra o cache antigo uma unica vez.
        window.electronAPI.saveZaps(zapsData);
      }
    }).catch(() => {
      if (zapsData.length) {
        try { window.electronAPI.saveZaps(zapsData); } catch (_) {}
      }
    });
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
  const list = globalSearchQuery
    ? zaps.filter(zap => zapMatchesSearch(zap, globalSearchQuery))
    : zaps;

  zapsList.innerHTML = '';

  if (list.length === 0) {
    const msg = globalSearchQuery
      ? 'Nenhum Zap encontrado para a busca.'
      : 'Nenhum Zap adicionado ainda.';
    zapsList.innerHTML = `<p style="color: #999; font-size: 14px; text-align: center; padding: 40px 0;">${msg}</p>`;
    return;
  }

  list.forEach(zap => {
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

  card.innerHTML = `
    <div class="zap-card-icon">
      <svg viewBox="0 0 32 32" fill="#111">
        <path d="M16.004 0h-.008C7.174 0 0 7.176 0 16c0 3.5 1.132 6.744 3.054 9.374L1.054 31.25l6.118-1.978A15.912 15.912 0 0016.004 32C24.826 32 32 24.822 32 16S24.826 0 16.004 0zm9.336 22.608c-.39 1.098-1.932 2.01-3.168 2.274-.84.18-1.938.324-5.628-1.206-4.722-1.956-7.758-6.756-7.992-7.068-.228-.312-1.878-2.502-1.878-4.77s1.188-3.39 1.614-3.858c.39-.426.936-.57 1.248-.57.156 0 .294.006.42.012.402.018.6.042.864.654.33.768 1.128 2.748 1.224 2.946.096.198.162.426.036.684-.126.258-.234.414-.462.642-.228.228-.48.51-.684.684-.198.162-.408.342-.174.672.234.33 1.038 1.716 2.226 2.784 1.53 1.374 2.706 1.848 3.18 2.062.372.168.588.138.804-.084.222-.228.756-.882 1.164-1.416.288-.378.648-.426 1.038-.288.396.132 2.496 1.176 2.922 1.392.426.216.714.324.816.504.102.18.102 1.05-.288 2.148z"/>
      </svg>
    </div>
    <div class="zap-card-info">
      <div class="zap-card-name-row">
        <span class="zap-card-name">${zap.name}</span>
      </div>
      <div class="zap-card-phone">${zap.phone}</div>
    </div>
    <button class="zap-card-arrow open-panel" data-id="${zap.id}" title="Abrir painel">
      &rsaquo;
    </button>
  `;

  if (zap.icon) {
    const iconEl = card.querySelector('.zap-card-icon');
    if (iconEl) {
      iconEl.innerHTML = `<img src="${zap.icon}" alt="" style="width:36px;height:36px;object-fit:cover;border-radius:50%">`;
    }
  }

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
  openDeleteZapModal(id);
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
  // Redraw activity chart on resize (panel open)
  window.addEventListener('resize', () => {
    if (currentPanelZapId == null) return;
    const zap = zapsData.find(z => String(z.id) === String(currentPanelZapId));
    if (zap) renderPanelCharts(zap);
  });

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
      if (!rendererDragging || !(e.buttons & 1)) { rendererDragging = false; return; }
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

  searchInput.addEventListener('input', () => {
    updateSearchClearBtn();
    const value = searchInput.value.trim();
    if (!value) {
      hideSearchDropdown();
      if (globalSearchQuery) clearGlobalSearch(false);
      return;
    }
    showSearchDropdown();
    renderSearchDropdown(value);
  });

  searchInput.addEventListener('focus', () => {
    updateSearchClearBtn();
    showSearchDropdown();
    renderSearchDropdown(searchInput.value.trim());
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const picked = (searchDdIndex >= 0 && searchDdItems[searchDdIndex])
        ? searchDdItems[searchDdIndex]
        : searchInput.value;
      applyGlobalSearch(picked);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveSearchHighlight(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveSearchHighlight(-1);
    } else if (e.key === 'Escape') {
      if (searchInput.value || globalSearchQuery) clearGlobalSearch(true);
      hideSearchDropdown();
    }
  });

  if (searchClearBtn) searchClearBtn.addEventListener('click', () => clearGlobalSearch(true));

  document.addEventListener('click', (e) => {
    if (!searchDropdown) return;
    if (e.target && typeof e.target.closest === 'function' && e.target.closest('.search-bar')) return;
    hideSearchDropdown();
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

  // Cada pagina tem sua propria busca: trocar de pagina limpa o filtro
  resetSearchForPage(page);

  if (page === 'treinamento') {
    closeTrainingEditor();
  }

  if (page === 'mensagem-automatica') {
    onAutoMsgPageOpen();
  }

  // Close zap panel when leaving "adicionar-whatsapp" page
  if (page !== 'adicionar-whatsapp' && currentPanelZapId != null) {
    closeZapPanel();
  }

  // Volta para a lista de provedores ao sair da pagina (mantem edies pendentes)
  if (page !== 'provedores' && currentEditingProvider != null && !provDirty) {
    closeProviderConfig();
  }

  // (Re)monta a lista da pagina ativa ja sem filtro de busca
  refreshPageList();
}

// ============================================
// Busca universal (topo)
// ============================================
const SEARCH_PLACEHOLDERS = {
  'dashboard': 'Buscar no dashboard...',
  'adicionar-whatsapp': 'Buscar Zaps, nmeros...',
  'contatos': 'Buscar contatos, nmeros...',
  'conversas': 'Buscar conversas...',
  'treinamento': 'Buscar Zaps e treinamentos...',
  'provedores': 'Buscar provedores...',
  'relatorios': 'Buscar relatrios...',
  'configuracoes': 'Buscar configuraes...',
  'mensagem-automatica': 'Buscar na conversa...',
  'ajuda': 'Buscar na ajuda...'
};

function getActivePageId() {
  const active = document.querySelector('.menu-item.active');
  return active ? active.dataset.page : null;
}

function searchMatches(value, query) {
  return String(value == null ? '' : value).toLowerCase().includes(query);
}

function zapMatchesSearch(zap, query) {
  if (searchMatches(zap.name, query)) return true;
  if (searchMatches(zap.phone, query)) return true;
  if (searchMatches(zap.status, query)) return true;
  if (searchMatches(zap.personality, query)) return true;
  return (zap.providers || []).some(id => {
    const p = providersData.find(pp => pp.id === id);
    return searchMatches(p ? p.name : id, query);
  });
}

function getSearchItemsForPage() {
  const page = getActivePageId();
  const items = [];
  const push = (v) => {
    const s = (v == null ? '' : String(v)).trim();
    if (s) items.push(s);
  };

  if (page === 'adicionar-whatsapp') {
    zapsData.forEach(z => { push(z.name); push(z.phone); });
  } else if (page === 'contatos') {
    zapsData.forEach(z => { push(z.name); push(z.phone); });
    document.querySelectorAll('#contactsZapsList .contact-row-name, #contactsZapsList .contact-row-number')
      .forEach(el => push(el.textContent));
  } else if (page === 'treinamento') {
    zapsData.forEach(z => { push(z.name); push(z.phone); });
    Object.keys(trainingsData || {}).forEach(key => {
      (trainingsData[key] || []).forEach(t => push(t.title));
    });
  } else if (page === 'provedores') {
    providersData.forEach(p => push(p.name));
  } else if (page === 'conversas') {
    zapsData.forEach(z => push(z.name));
    document.querySelectorAll('#conversationsList .conversation-name').forEach(el => push(el.textContent));
  } else if (page === 'mensagem-automatica') {
    const st = getAutoMsgStateSafe();
    const chat = (st.chats || {})[autoMsgViewZap] || [];
    chat.forEach(c => push(c.content));
    (st.queue || []).forEach(q => push(q.phone));
  }

  return items;
}

function buildSearchSuggestions(value) {
  const query = value.toLowerCase();
  const unique = [];
  const seen = new Set();

  getSearchItemsForPage().forEach(item => {
    const key = item.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    unique.push(item);
  });

  const startsWith = unique.filter(s => s.toLowerCase().startsWith(query)).slice(0, 3);
  const contains = unique.filter(s => !s.toLowerCase().startsWith(query) && s.toLowerCase().includes(query)).slice(0, 2);

  return startsWith.concat(contains);
}

function getRecentSearches() {
  const list = safeParseLS('linknozap_recent_searches', []);
  return Array.isArray(list) ? list : [];
}

function pushRecentSearch(value) {
  if (!value) return;
  const lower = value.toLowerCase();
  const list = getRecentSearches().filter(x => String(x).toLowerCase() !== lower);
  list.unshift(value);
  localStorage.setItem('linknozap_recent_searches', JSON.stringify(list.slice(0, 8)));
}

function updateSearchClearBtn() {
  if (searchClearBtn) searchClearBtn.style.display = searchInput && searchInput.value ? 'flex' : 'none';
}

function showSearchDropdown() {
  if (searchDropdown) searchDropdown.style.display = 'block';
}

function hideSearchDropdown() {
  if (searchDropdown) searchDropdown.style.display = 'none';
  searchDdItems = [];
  searchDdIndex = -1;
}

function renderSearchDropdown(value) {
  if (!searchDropdown) return;

  const recentBlock = document.getElementById('searchRecentBlock');
  const recentList = document.getElementById('searchRecentList');
  const suggestBlock = document.getElementById('searchSuggestBlock');
  const suggestList = document.getElementById('searchSuggestList');
  const empty = document.getElementById('searchDdEmpty');

  const query = (value || '').toLowerCase();
  const recents = getRecentSearches()
    .filter(r => !query || String(r).toLowerCase().includes(query))
    .slice(0, 5);
  const suggestions = query ? buildSearchSuggestions(query) : [];

  if (recents.length) {
    recentBlock.style.display = '';
    recentList.innerHTML = recents.map(r => `
      <div class="search-dd-item" data-value="${escapeHtml(r)}">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="9"/>
          <polyline points="12 7 12 12 15 14"/>
        </svg>
        <span>${escapeHtml(r)}</span>
      </div>
    `).join('');
  } else {
    recentBlock.style.display = 'none';
  }

  if (suggestions.length) {
    suggestBlock.style.display = '';
    suggestList.innerHTML = suggestions.map(s => `
      <div class="search-dd-item" data-value="${escapeHtml(s)}">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8"/>
          <line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <span>${escapeHtml(s)}</span>
      </div>
    `).join('');
  } else {
    suggestBlock.style.display = 'none';
  }

  searchDdItems = Array.from(searchDropdown.querySelectorAll('.search-dd-item')).map(el => el.dataset.value);
  searchDdIndex = -1;
  if (empty) empty.style.display = searchDdItems.length ? 'none' : '';

  if (!searchDdItems.length) {
    hideSearchDropdown();
    return;
  }

  searchDropdown.querySelectorAll('.search-dd-item').forEach(el => {
    el.addEventListener('click', () => applyGlobalSearch(el.dataset.value));
  });
}

function moveSearchHighlight(delta) {
  if (!searchDdItems.length) return;
  searchDdIndex = (searchDdIndex + delta + searchDdItems.length) % searchDdItems.length;
  const nodes = searchDropdown.querySelectorAll('.search-dd-item');
  nodes.forEach((el, i) => el.classList.toggle('active', i === searchDdIndex));
  const active = nodes[searchDdIndex];
  if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
}

function preparePageForSearch() {
  const page = getActivePageId();
  if (page === 'adicionar-whatsapp' && currentPanelZapId != null) closeZapPanel();
  if (page === 'provedores' && currentEditingProvider != null && !provDirty) closeProviderConfig();
  if (page === 'treinamento' && currentTrainingZapId != null) closeTrainingEditor();
}

function refreshPageList() {
  const page = getActivePageId();
  if (page === 'adicionar-whatsapp') {
    renderZaps(zapsData);
  } else if (page === 'contatos') {
    renderContactsPage();
  } else if (page === 'treinamento') {
    renderTrainingZapsList();
    renderTrainingsList();
  } else if (page === 'provedores') {
    renderProvidersList();
  } else if (page === 'conversas') {
    if (lastRenderedConversations != null) {
      renderConversations(lastRenderedConversations, lastRenderedConversationsZapId);
    }
  } else if (page === 'mensagem-automatica') {
    renderAutoMsgChat();
  }
}

function applyGlobalSearch(value) {
  const raw = (value || '').trim();
  const query = raw.toLowerCase();
  if (!query) {
    clearGlobalSearch(true);
    return;
  }

  globalSearchQuery = query;
  searchInput.value = raw;
  updateSearchClearBtn();
  hideSearchDropdown();
  pushRecentSearch(raw);
  preparePageForSearch();
  refreshPageList();
}

function clearGlobalSearch(resetInput) {
  globalSearchQuery = '';
  if (resetInput && searchInput) searchInput.value = '';
  updateSearchClearBtn();
  hideSearchDropdown();
  refreshPageList();
}

function resetSearchForPage(page) {
  globalSearchQuery = '';
  if (searchInput) {
    searchInput.value = '';
    searchInput.placeholder = SEARCH_PLACEHOLDERS[page] || 'Buscar...';
  }
  updateSearchClearBtn();
  hideSearchDropdown();
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

// Renomeia o Zap com edicao inline (Enter salva, Esc cancela)
function startRenameZap(zap, nameEl) {
  if (!zap || !nameEl || nameEl.dataset.renaming) return;
  nameEl.dataset.renaming = '1';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'zap-name-edit-input';
  input.value = zap.name || '';
  nameEl.style.display = 'none';
  nameEl.parentNode.insertBefore(input, nameEl);
  input.focus();
  input.select();

  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    const novo = input.value.trim();
    if (input.parentNode) input.parentNode.removeChild(input);
    delete nameEl.dataset.renaming;
    nameEl.style.display = '';
    if (save && novo && novo !== zap.name) {
      zap.name = novo;
      saveZaps();
      renderZaps(zapsData);
      if (currentPanelZapId != null && String(currentPanelZapId) === String(zap.id)) {
        document.getElementById('zapPanelName').textContent = novo;
      }
      renderAutoMsgAccounts();
    } else {
      nameEl.textContent = zap.name;
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  input.addEventListener('blur', () => commit(true));
}

// ============================================
// Personalidades (lista + criacao)
// ============================================
const BUILTIN_PERSONALITIES = [
  { id: 'padrao', name: 'Jovem de 17 anos' },
  { id: 'vendedor', name: 'Vendedor' },
  { id: 'atendente', name: 'Atendente' },
  { id: 'especialista', name: 'Especialista' }
];

function loadCustomPersonalities() {
  try {
    const raw = localStorage.getItem('linknozap_personalities');
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter(p => p && p.id && p.name) : [];
  } catch (_) {
    return [];
  }
}

function saveCustomPersonalities(list) {
  try { localStorage.setItem('linknozap_personalities', JSON.stringify(list)); } catch (_) {}
}

function getPersonalitiesList() {
  return BUILTIN_PERSONALITIES.concat(loadCustomPersonalities());
}

function openPersonalityModal(onDone) {
  const modal = document.getElementById('personalityModal');
  const nameInput = document.getElementById('personalityName');
  const promptInput = document.getElementById('personalityPrompt');
  if (!modal || !nameInput || !promptInput) return;

  nameInput.value = '';
  promptInput.value = '';
  modal.classList.add('active');
  setTimeout(() => nameInput.focus(), 50);

  const close = () => modal.classList.remove('active');
  const closeBtn = document.getElementById('closePersonalityModal');
  const cancelBtn = document.getElementById('cancelPersonality');
  const saveBtn = document.getElementById('savePersonality');
  if (closeBtn) closeBtn.onclick = close;
  if (cancelBtn) cancelBtn.onclick = close;
  if (saveBtn) saveBtn.onclick = () => {
    const name = nameInput.value.trim();
    const instructions = promptInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    if (!instructions) { promptInput.focus(); return; }
    const list = loadCustomPersonalities();
    const id = 'custom_' + Date.now().toString(36);
    list.push({ id, name, instructions });
    saveCustomPersonalities(list);
    close();
    if (typeof onDone === 'function') onDone(id);
  };
}

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

  // Editar nome do Zap (lapis)
  const editNameBtn = document.getElementById('panelEditName');
  editNameBtn.onclick = () => startRenameZap(zap, document.getElementById('zapPanelName'));

  // Copiar numero (somente o simbolo)
  const copyBtn = document.getElementById('copyZapPhone');
  copyBtn.onclick = () => {
    navigator.clipboard.writeText(zap.phone).then(() => {
      const orig = copyBtn.innerHTML;
      copyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><polyline points="20 6 9 17 4 12"/></svg>';
      setTimeout(() => { copyBtn.innerHTML = orig; }, 2000);
    });
  };

  // Trocar icone do Zap (lapis no canto do icone)
  const editIconBtn = document.getElementById('panelEditIcon');
  const iconImg = document.getElementById('zapPanelIconImg');
  const defaultIcon = document.querySelector('#zapPanelIcon .panel-icon-default');
  const applyZapIcon = (z) => {
    if (z && z.icon) {
      if (iconImg) { iconImg.src = z.icon; iconImg.style.display = 'block'; }
      if (defaultIcon) defaultIcon.style.display = 'none';
    } else {
      if (iconImg) { iconImg.style.display = 'none'; iconImg.removeAttribute('src'); }
      if (defaultIcon) defaultIcon.style.display = 'block';
    }
  };
  applyZapIcon(zap);
  if (editIconBtn) {
    editIconBtn.onclick = async () => {
      if (!window.electronAPI || !window.electronAPI.pickZapIcon) return;
      try {
        const r = await window.electronAPI.pickZapIcon();
        if (!r || !r.ok || !r.dataUrl) return;
        const z = zapsData.find(x => String(x.id) === String(zapId));
        if (!z) return;
        z.icon = r.dataUrl;
        saveZaps();
        applyZapIcon(z);
        renderZaps(zapsData);
      } catch (e) {
        alert('Nao foi possivel trocar o icone: ' + e.message);
      }
    };
  }

  // Indicador de status (circulo) - detalhe em refreshPanelStatusUI

  // Auto-reply toggle (na frente, junto do nome)
  const autoReplyCb = document.getElementById('panelAutoReply');
  autoReplyCb.checked = zap.autoReply !== false;
  autoReplyCb.onchange = () => {
    const z = zapsData.find(x => String(x.id) === String(zapId));
    if (z) {
      z.autoReply = autoReplyCb.checked;
      saveZaps();
    }
  };

  // Resposta instantanea (ignora o sorteio de 15/25/35s)
  const instantCb = document.getElementById('panelInstantReply');
  instantCb.checked = !!zap.instantReply;
  instantCb.onchange = () => {
    const z = zapsData.find(x => String(x.id) === String(zapId));
    if (z) {
      z.instantReply = instantCb.checked;
      saveZaps();
    }
  };

  // Horario de atendimento
  const whCb = document.getElementById('panelWorkHours');
  const whRow = document.getElementById('panelWorkHoursRow');
  const whDays = document.getElementById('panelWorkDays');
  const whStart = document.getElementById('panelWorkStart');
  const whEnd = document.getElementById('panelWorkEnd');
  const whLabel = document.getElementById('panelWorkHoursLabel');
  const whDayBoxes = Array.from(document.querySelectorAll('.panel-work-day'));
  const wh = zap.workHours || {};
  whCb.checked = wh.enabled === true;
  whStart.value = wh.start || '08:00';
  whEnd.value = wh.end || '18:00';
  const whDaysSel = Array.isArray(wh.days) ? wh.days.map(Number) : [1, 2, 3, 4, 5];
  whDayBoxes.forEach(cb => { cb.checked = whDaysSel.includes(Number(cb.value)); });
  const whToggleUI = () => {
    whRow.style.display = whCb.checked ? 'flex' : 'none';
    whDays.style.display = whCb.checked ? 'flex' : 'none';
    if (whLabel) whLabel.textContent = whCb.checked ? 'IA responde so no horario definido' : 'IA responde a qualquer hora';
  };
  whToggleUI();
  const readWorkHoursForm = () => ({
    enabled: whCb.checked,
    start: whStart.value || '08:00',
    end: whEnd.value || '18:00',
    days: whDayBoxes.filter(cb => cb.checked).map(cb => Number(cb.value)),
    tz: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) { return ''; } })()
  });
  const persistWorkHours = () => {
    const z = zapsData.find(x => String(x.id) === String(zapId));
    if (!z) return;
    z.workHours = readWorkHoursForm();
    saveZaps();
  };
  whCb.onchange = () => { whToggleUI(); persistWorkHours(); };
  whStart.onchange = persistWorkHours;
  whEnd.onchange = persistWorkHours;
  whDayBoxes.forEach(cb => { cb.onchange = persistWorkHours; });

  // Personalidade (lista de opcoes)
  const areaRow = document.getElementById('panelAreaRow');
  const areaInput = document.getElementById('panelArea');
  const personalityBadge = document.getElementById('zapPanelPersonality');
  const personalityList = document.getElementById('panelPersonalityList');

  const currentZap = () => zapsData.find(x => String(x.id) === String(zapId));

  const updatePersonalityBadge = () => {
    if (!personalityBadge) return;
    const z = currentZap();
    const selId = (z && z.personality) || 'padrao';
    const item = getPersonalitiesList().find(p => p.id === selId);
    personalityBadge.textContent = item ? item.name : 'Jovem de 17 anos';
  };

  const renderPersonalityList = () => {
    if (!personalityList) return;
    const z = currentZap();
    const selId = (z && z.personality) || 'padrao';
    personalityList.innerHTML = getPersonalitiesList().map(p => `
      <label class="panel-personality-item ${p.id === selId ? 'selected' : ''}">
        <input type="radio" name="panelPersonalityRadio" value="${escapeHtml(p.id)}" ${p.id === selId ? 'checked' : ''}>
        <span class="panel-personality-name">${escapeHtml(p.name)}</span>
      </label>
    `).join('');
    personalityList.querySelectorAll('input[type="radio"]').forEach(radio => {
      radio.onchange = () => {
        const zz = currentZap();
        if (!zz) return;
        zz.personality = radio.value;
        saveZaps();
        areaRow.style.display = radio.value === 'especialista' ? 'flex' : 'none';
        renderPersonalityList();
        updatePersonalityBadge();
        renderZaps(zapsData);
      };
    });
  };

  const z0 = currentZap();
  areaInput.value = (z0 && z0.area) || '';
  areaRow.style.display = ((z0 && z0.personality) || 'padrao') === 'especialista' ? 'flex' : 'none';
  renderPersonalityList();
  updatePersonalityBadge();

  areaInput.oninput = () => {
    const zz = currentZap();
    if (zz) zz.area = areaInput.value.trim();
    updatePersonalityBadge();
  };
  areaInput.onchange = () => {
    const zz = currentZap();
    if (!zz) return;
    zz.area = areaInput.value.trim();
    saveZaps();
    renderZaps(zapsData);
  };

  const addPersonalityBtn = document.getElementById('addPersonalityBtn');
  if (addPersonalityBtn) {
    addPersonalityBtn.onclick = () => openPersonalityModal((id) => {
      const zz = currentZap();
      if (zz && id) { zz.personality = id; saveZaps(); }
      renderPersonalityList();
      updatePersonalityBadge();
      renderZaps(zapsData);
    });
  }

  // Connect/Disconnect button
  refreshPanelStatusUI(zapId);

  // Log button
  const logBtn = document.getElementById('zapPanelLog');
  logBtn.onclick = () => openLogModal(zap.id, zap.name);

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
    if (typeof readWorkHoursForm === 'function') z.workHours = readWorkHoursForm();
    saveZaps();
    renderZaps(zapsData);

    if (serverManaged) {
      // O zap roda no servidor: so enviamos as configs (sem reiniciar local)
      saveRestartBtn.disabled = true;
      const origHtml = saveRestartBtn.innerHTML;
      saveRestartBtn.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> Enviando ao servidor...`;
      try {
        const r = await window.electronAPI.serverSyncNow();
        if (r && r.ok) alert('Alteracoes salvas e enviadas ao servidor!');
        else alert('Nao foi possivel enviar ao servidor: ' + ((r && r.error) || 'erro'));
      } catch (e) {
        alert('Erro ao enviar ao servidor: ' + e.message);
      } finally {
        saveRestartBtn.disabled = false;
        saveRestartBtn.innerHTML = origHtml;
        openZapPanel(zapId);
      }
      return;
    }

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
      saveRestartBtn.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> Salvar alteracoes`;
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

  // Apagar Zap (modal de confirmacao)
  const deleteBtn = document.getElementById('panelDeleteZap');
  deleteBtn.onclick = () => openDeleteZapModal(zapId);
}

let pendingDeleteZapId = null;

function openDeleteZapModal(zapId) {
  const zap = zapsData.find((z) => String(z.id) === String(zapId));
  if (!zap) return;
  const modal = document.getElementById('deleteZapModal');
  if (!modal) return;
  pendingDeleteZapId = zap.id;

  const nome = String(zap.name);
  const warning = document.getElementById('deleteZapWarning');
  const input = document.getElementById('deleteZapConfirmInput');
  const confirmBtn = document.getElementById('confirmDeleteZap');
  const cancelBtn = document.getElementById('cancelDeleteZap');
  const closeBtn = document.getElementById('closeDeleteZapModal');
  const status = document.getElementById('deleteZapStatus');
  if (!warning || !input || !confirmBtn || !cancelBtn || !closeBtn || !status) return;

  warning.textContent = `"${nome}" sera apagado do app e do servidor. O WhatsApp sera desconectado e nao vai mais responder mensagens. Essa acao nao pode ser desfeita.`;
  input.value = '';
  status.textContent = '';
  status.classList.remove('error');
  confirmBtn.textContent = 'Apagar definitivamente';
  confirmBtn.disabled = true;
  delete confirmBtn.dataset.busy;
  modal.classList.add('active');
  setTimeout(() => input.focus(), 50);

  const syncBtn = () => {
    confirmBtn.disabled = confirmBtn.dataset.busy === '1' || input.value.trim() !== nome.trim();
  };
  input.oninput = syncBtn;

  const close = () => {
    if (confirmBtn.dataset.busy === '1') return;
    modal.classList.remove('active');
    pendingDeleteZapId = null;
  };
  closeBtn.onclick = close;
  cancelBtn.onclick = close;
  modal.onclick = (e) => { if (e.target === modal) close(); };
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !confirmBtn.disabled) confirmBtn.click();
  };

  confirmBtn.onclick = async () => {
    if (confirmBtn.disabled) return;
    const id = pendingDeleteZapId;
    if (id == null) return;
    confirmBtn.dataset.busy = '1';
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Apagando...';
    status.classList.remove('error');
    status.textContent = 'Apagando do app e do servidor...';
    try {
      const res = await deleteZapCompletely(id);
      status.textContent = res && res.synced
        ? 'Zap apagado. O servidor nao vai mais responder por ele.'
        : 'Zap apagado do app. A sincronizacao com o servidor esta pendente e sera tentada de novo.';
      delete confirmBtn.dataset.busy;
      setTimeout(() => {
        modal.classList.remove('active');
        pendingDeleteZapId = null;
      }, res && res.synced ? 1200 : 2600);
    } catch (e) {
      status.classList.add('error');
      status.textContent = 'Falha ao apagar: ' + (e && e.message ? e.message : e);
      delete confirmBtn.dataset.busy;
      confirmBtn.textContent = 'Apagar definitivamente';
      syncBtn();
    }
  };
}

async function deleteZapCompletely(zapId) {
  const id = String(zapId);
  const zap = zapsData.find((z) => String(z.id) === id);
  if (!zap) throw new Error('Zap nao encontrado');
  if (!window.electronAPI || !window.electronAPI.saveZaps) throw new Error('IPC saveZaps indisponivel');

  if (currentPanelZapId != null && String(currentPanelZapId) === id) closeZapPanel();

  // Remove da UI e do cache imediatamente
  zapsData = zapsData.filter((z) => String(z.id) !== id);
  try { localStorage.setItem('linknozap_zaps', JSON.stringify(zapsData)); } catch (_) {}
  renderZaps(zapsData);
  if (typeof updateZapSelector === 'function') { try { updateZapSelector(); } catch (_) {} }

  // 1) persiste a remocao no zaps.json (processo principal)
  const saved = await window.electronAPI.saveZaps(zapsData);
  if (saved === false) throw new Error('nao foi possivel gravar o zaps.json');

  // 2) desconecta no app (se estiver conectado localmente)
  if (window.electronAPI.whatsappDisconnect) {
    try { await window.electronAPI.whatsappDisconnect(id); } catch (_) {}
  }

  // 3) empurra a config sem o zap; o servidor para de responder ao receber
  let synced = false;
  let lastErr = '';
  if (window.electronAPI.serverSyncNow) {
    for (let i = 0; i < 3 && !synced; i++) {
      try {
        const r = await window.electronAPI.serverSyncNow();
        if (r && (r.ok || r.disabled)) { synced = true; break; }
        lastErr = (r && r.error) || 'sincronizacao falhou';
      } catch (e) {
        lastErr = e && e.message ? e.message : String(e);
      }
      if (!synced) await new Promise((res) => setTimeout(res, 1500));
    }
    if (!synced) console.warn('[DELETE] sync imediato falhou:', lastErr);
  } else {
    synced = true;
  }

  // 4) apaga a sessao (repo de dados + pasta local) e os treinamentos
  if (window.electronAPI.serverDeleteZapSession) {
    try {
      const r = await window.electronAPI.serverDeleteZapSession(id);
      if (r && r.ok === false && !r.disabled) console.warn('[DELETE] sessao:', r.error);
    } catch (e) {
      console.warn('[DELETE] sessao:', e && e.message);
    }
  }
  delete trainingsData[id];
  if (window.electronAPI.deleteTrainingsForZap) {
    try { await window.electronAPI.deleteTrainingsForZap(id); } catch (_) {}
  }

  // 5) push final (garante sessao/treinos removidos no repo)
  if (window.electronAPI.serverSyncNow) {
    try { await window.electronAPI.serverSyncNow(); } catch (_) {}
  }

  if (window.electronAPI.focusWindow) { try { window.electronAPI.focusWindow(); } catch (_) {} }
  return { ok: true, synced };
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
// Panel Chart (Canvas) - Atividade da IA por hora
// ============================================
function renderPanelCharts(zap) {
  const usageData = zap.usageHistory || [];
  const totalMessages = zap.messageCount || 0;

  const valueEl = document.getElementById('usageValue');
  if (valueEl) valueEl.textContent = totalMessages.toLocaleString('pt-BR');

  drawActivityChart('usageChart', 'usageTooltip', usageData);
}

function getHourlyActivity(data, numBuckets) {
  const now = Math.floor(Date.now() / 1000);
  const bucketSize = 3600;
  const buckets = [];

  for (let i = numBuckets - 1; i >= 0; i--) {
    const end = now - i * bucketSize;
    const start = end - bucketSize;
    let before = 0;
    let inside = 0;

    (data || []).forEach(p => {
      const y = p.y || 0;
      if (p.x < start) {
        if (y > before) before = y;
      } else if (p.x < end) {
        if (y > inside) inside = y;
      }
    });

    buckets.push({ time: end, value: Math.max(0, inside - before) });
  }

  return buckets;
}

// Curva suave (Catmull-Rom -> Bezier) com clamp para nao passar dos limites
function smoothLinePath(ctx, pts, minY, maxY) {
  if (!pts.length) return;
  const clampY = (y) => Math.min(Math.max(y, minY), maxY);
  ctx.moveTo(pts[0].x, clampY(pts[0].y));
  if (pts.length === 1) return;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    ctx.bezierCurveTo(
      p1.x + (p2.x - p0.x) / 6,
      clampY(p1.y + (p2.y - p0.y) / 6),
      p2.x - (p3.x - p1.x) / 6,
      clampY(p2.y - (p3.y - p1.y) / 6),
      p2.x,
      clampY(p2.y)
    );
  }
}

function drawActivityChart(canvasId, tooltipId, data) {
  const canvas = document.getElementById(canvasId);
  const tooltip = document.getElementById(tooltipId);
  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const w = rect.width;
  const h = rect.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, w, h);

  const pad = { l: 10, r: 10, t: 16, b: 22 };
  const innerW = Math.max(1, w - pad.l - pad.r);
  const innerH = Math.max(1, h - pad.t - pad.b);

  const buckets = getHourlyActivity(data, 12);
  const hasData = buckets.some(b => b.value > 0);

  const baseY = pad.t + innerH;

  if (!hasData) {
    ctx.strokeStyle = '#3A3A3A';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pad.l, baseY);
    ctx.lineTo(w - pad.r, baseY);
    ctx.stroke();

    ctx.fillStyle = '#666666';
    ctx.font = '11px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('IA parada - nenhuma mensagem nas ultimas 12 horas', w / 2, pad.t + innerH / 2);

    if (tooltip) tooltip.style.display = 'none';
    canvas.style.cursor = 'default';
    canvas.onmousemove = null;
    canvas.onmouseleave = null;
    return;
  }

  const maxVal = Math.max(...buckets.map(b => b.value), 1);
  const stepX = innerW / (buckets.length - 1);
  const points = buckets.map((bucket, i) => ({
    x: pad.l + i * stepX,
    y: baseY - (bucket.value / maxVal) * innerH,
    bucket
  }));

  // Linha suave e limpa: sem grade, sem pontos e sem brilho
  ctx.beginPath();
  smoothLinePath(ctx, points, pad.t, baseY);
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = 2.4;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();

  // Hour labels
  ctx.fillStyle = '#6B6B6B';
  ctx.font = '9px Inter, sans-serif';
  ctx.textAlign = 'center';
  points.forEach((p, i) => {
    if (i % 3 !== 0 && i !== points.length - 1) return;
    const t = new Date(p.bucket.time * 1000);
    ctx.fillText(t.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }), p.x, h - 7);
  });

  // Hover tooltip
  canvas.style.cursor = 'default';
  canvas.onmousemove = (e) => {
    const cr = canvas.getBoundingClientRect();
    const mx = e.clientX - cr.left;
    let nearest = null;
    let best = Infinity;

    points.forEach(p => {
      const d = Math.abs(p.x - mx);
      if (d < best) { best = d; nearest = p; }
    });

    if (nearest && best <= stepX / 2 + 6 && tooltip) {
      tooltip.style.display = 'block';
      const t = new Date(nearest.bucket.time * 1000);
      const label = t.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      tooltip.textContent = `${label} - ${nearest.bucket.value} msg`;
      tooltip.style.left = (canvas.offsetLeft + Math.min(nearest.x + 10, w - 120)) + 'px';
      tooltip.style.top = (canvas.offsetTop + Math.max(nearest.y - 34, 0)) + 'px';
      canvas.style.cursor = 'pointer';
    } else {
      if (tooltip) tooltip.style.display = 'none';
      canvas.style.cursor = 'default';
    }
  };
  canvas.onmouseleave = () => {
    if (tooltip) tooltip.style.display = 'none';
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

    let keyControlHtml = '';
    if (providerKeys.length > 1) {
      const selIndex = zap.apiKeySelections[provider.id] != null
        ? zap.apiKeySelections[provider.id]
        : 0;
      const options = providerKeys.map((k, i) => {
        const label = (provider.apiKeyNames && provider.apiKeyNames[i]) || `Chave ${i + 1}`;
        return `<option value="${i}" ${i === selIndex ? 'selected' : ''}>${escapeHtml(label)} · ${maskApiKey(k)}</option>`;
      }).join('');
      keyControlHtml = `
        <div class="provider-key-row">
          <select class="provider-key-select" data-provider="${provider.id}" title="Chave API">
            ${options}
          </select>
        </div>
      `;
    } else if (providerKeys.length === 1) {
      const label = (provider.apiKeyNames && provider.apiKeyNames[0]) || 'Chave 1';
      keyControlHtml = `
        <div class="provider-key-row">
          <span class="provider-key-value" title="Chave API">${escapeHtml(label)} · ${maskApiKey(providerKeys[0])}</span>
        </div>
      `;
    } else {
      keyControlHtml = `
        <div class="provider-key-row">
          <span class="provider-key-empty">Sem chave</span>
        </div>
      `;
    }

    item.innerHTML = `
      <input type="checkbox" data-provider="${provider.id}" ${isChecked ? 'checked' : ''}>
      <div class="provider-toggle-info">
        <div class="provider-toggle-name">${provider.name}</div>
        ${keyControlHtml}
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
// Panel Model Config (lista de modelos p/ marcar)
// ============================================
function modelKeyOf(provider, model) {
  return `${provider.id}|${model.id}`;
}

function getPanelModelEntries(zap) {
  const entries = [];
  (zap.providers || []).forEach(pId => {
    const provider = providersData.find(p => p.id === pId);
    if (!provider) return;
    (provider.models || []).forEach(model => {
      entries.push({ provider, model, key: modelKeyOf(provider, model) });
    });
  });
  return entries;
}

function savePanelModelSelection(zapId) {
  const z = zapsData.find(x => String(x.id) === String(zapId));
  if (!z) return;

  const boxes = document.querySelectorAll('#panelModelsList input[type="checkbox"]');
  z.selectedModels = Array.from(boxes)
    .filter(cb => cb.checked)
    .map(cb => cb.dataset.key);
  saveZaps();

  const selectAll = document.getElementById('panelSelectAllModels');
  if (selectAll) {
    selectAll.disabled = boxes.length === 0;
    selectAll.checked = boxes.length > 0 && z.selectedModels.length === boxes.length;
  }
}

function renderPanelModelConfig(zap) {
  const list = document.getElementById('panelModelsList');
  const selectAll = document.getElementById('panelSelectAllModels');
  const autoSwitch = document.getElementById('panelAutoSwitch');
  if (!list) return;

  if (autoSwitch) {
    autoSwitch.checked = zap.autoSwitch !== false;
    autoSwitch.onchange = () => {
      const z = zapsData.find(x => String(x.id) === String(zap.id));
      if (z) { z.autoSwitch = autoSwitch.checked; saveZaps(); }
    };
  }

  const entries = getPanelModelEntries(zap);

  if (entries.length === 0) {
    list.innerHTML = '<p class="panel-models-empty">Selecione pelo menos um provedor para ver os modelos disponveis.</p>';
    if (selectAll) {
      selectAll.checked = false;
      selectAll.disabled = true;
      selectAll.onchange = null;
    }
    return;
  }

  const available = new Set(entries.map(e => e.key));
  let saved = Array.isArray(zap.selectedModels)
    ? zap.selectedModels.filter(k => available.has(k))
    : null;

  // Migracao: zap.model especifico salvo pelo antigo select
  if (saved === null && zap.model && zap.model !== 'auto' && zap.model.includes('|')) {
    const sep = zap.model.indexOf('|');
    const provName = zap.model.slice(0, sep);
    const modelId = zap.model.slice(sep + 1);
    const prov = providersData.find(p => p.name === provName);
    const legacyKey = prov ? `${prov.id}|${modelId}` : null;
    if (legacyKey && available.has(legacyKey)) saved = [legacyKey];
  }

  const selected = new Set(saved !== null ? saved : entries.map(e => e.key));

  list.innerHTML = '';
  entries.forEach(entry => {
    const row = document.createElement('div');
    row.className = 'panel-model-item';
    const providerKeys = entry.provider.apiKeys && entry.provider.apiKeys.length
      ? entry.provider.apiKeys
      : (entry.provider.apiKey ? [entry.provider.apiKey] : []);
    const keyIdx = (zap.apiKeySelections && zap.apiKeySelections[entry.provider.id] != null)
      ? zap.apiKeySelections[entry.provider.id]
      : 0;
    const keyLabel = (entry.provider.apiKeyNames && entry.provider.apiKeyNames[keyIdx]) || ('Chave ' + (keyIdx + 1));
    const hasManyKeys = providerKeys.length > 1;
    row.innerHTML = `
      <input type="checkbox" data-key="${entry.key}" ${selected.has(entry.key) ? 'checked' : ''}>
      <div class="panel-model-info">
        <div class="panel-model-name-row">
          <button type="button" class="panel-model-key-btn ${hasManyKeys ? '' : 'single'}" data-provider="${entry.provider.id}" title="${hasManyKeys ? 'Chave: ' + escapeHtml(keyLabel) + ' (clique para alternar)' : 'Uma unica chave configurada'}">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
            </svg>
          </button>
          <span class="panel-model-name">${entry.model.name || entry.model.id}</span>
        </div>
        <span class="panel-model-provider">${entry.provider.name} &middot; ${entry.model.id}</span>
      </div>
      <button type="button" class="panel-test-btn" data-provider="${entry.provider.id}" data-model="${entry.model.id}" title="Testar modelo">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        Testar
      </button>
    `;
    list.appendChild(row);
  });

  list.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => savePanelModelSelection(zap.id));
  });

  list.querySelectorAll('.panel-test-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const provider = providersData.find(p => p.id === btn.dataset.provider);
      if (!provider) return;
      const model = (provider.models || []).find(m => m.id === btn.dataset.model);
      if (!model) return;
      openTestChatWith(provider, model);
    });
  });

  // Icone do provedor: alterna entre as chaves de API configuradas
  list.querySelectorAll('.panel-model-key-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const provider = providersData.find(p => p.id === btn.dataset.provider);
      if (!provider) return;
      const keys = provider.apiKeys && provider.apiKeys.length
        ? provider.apiKeys
        : (provider.apiKey ? [provider.apiKey] : []);
      if (keys.length < 2) return;
      const z = zapsData.find(x => String(x.id) === String(zap.id));
      if (!z) return;
      if (!z.apiKeySelections) z.apiKeySelections = {};
      const cur = z.apiKeySelections[provider.id] != null ? z.apiKeySelections[provider.id] : 0;
      z.apiKeySelections[provider.id] = (cur + 1) % keys.length;
      saveZaps();
      renderPanelModelConfig(z);
      renderPanelProviders(z);
    });
  });

  if (selectAll) {
    selectAll.disabled = false;
    selectAll.checked = entries.every(e => selected.has(e.key));
    selectAll.onchange = () => {
      list.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.checked = selectAll.checked;
      });
      savePanelModelSelection(zap.id);
    };
  }
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

// ============================================
// Pagina Contatos
// ============================================
function renderContactsPage() {
  const container = document.getElementById('contactsZapsList');
  if (!container) return;

  container.innerHTML = '';

  if (zapsData.length === 0) {
    container.innerHTML = '<p class="empty-hint">Nenhum Zap criado ainda.</p>';
    return;
  }

  zapsData.forEach(zap => {
    const item = document.createElement('div');
    item.className = 'contact-zap-item';
    item.innerHTML = `
      <div class="contact-zap-card">
        <div class="contact-zap-info">
          <div class="contact-zap-name">${escapeHtml(zap.name)}</div>
          <div class="contact-zap-phone">${escapeHtml(zap.phone || '')}</div>
        </div>
        <span class="contact-zap-chevron">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
        </span>
      </div>
      <div class="contact-zap-contacts"><div class="spinner" style="margin:14px auto;"></div></div>
    `;
    container.appendChild(item);

    item.querySelector('.contact-zap-card').addEventListener('click', () => {
      item.classList.toggle('collapsed');
    });

    loadContactsForZap(zap, item.querySelector('.contact-zap-contacts'));
  });

  filterContactsDOM();
}

// Esconde zaps/contatos que nao batem com a busca ativa
function filterContactsDOM() {
  const container = document.getElementById('contactsZapsList');
  if (!container) return;

  const items = container.querySelectorAll('.contact-zap-item');

  if (!globalSearchQuery) {
    items.forEach(item => { item.style.display = ''; });
    return;
  }

  items.forEach(item => {
    const name = item.querySelector('.contact-zap-name');
    const phone = item.querySelector('.contact-zap-phone');
    const zapMatch = searchMatches(name ? name.textContent : '', globalSearchQuery)
      || searchMatches(phone ? phone.textContent : '', globalSearchQuery);

    let rowMatch = false;
    item.querySelectorAll('.contact-row').forEach(row => {
      const rn = row.querySelector('.contact-row-name');
      const rp = row.querySelector('.contact-row-number');
      const match = zapMatch
        || searchMatches(rn ? rn.textContent : '', globalSearchQuery)
        || searchMatches(rp ? rp.textContent : '', globalSearchQuery);
      row.style.display = match ? '' : 'none';
      if (match) rowMatch = true;
    });

    item.style.display = (zapMatch || rowMatch) ? '' : 'none';
    if (zapMatch || rowMatch) item.classList.remove('collapsed');
  });
}

async function loadContactsForZap(zap, container) {
  if (!container) return;

  if (!window.electronAPI) {
    container.innerHTML = '<p class="empty-hint">API nao disponivel.</p>';
    filterContactsDOM();
    return;
  }

  try {
    const conversations = await window.electronAPI.whatsappConversations(String(zap.id));
    const blocked = (zap.blockedContacts || []);
    const contacts = (conversations || []).filter(c =>
      c && c.contact && c.contact.id &&
      !c.contact.id.includes('@g.us') &&
      !c.contact.id.includes('@newsletter')
    );

    if (contacts.length === 0) {
      container.innerHTML = '<p class="empty-hint">Nenhum contato encontrado. Conecte o Zap e receba mensagens.</p>';
      return;
    }

    container.innerHTML = '';
    contacts.forEach(conv => {
      const isBlocked = blocked.includes(conv.contact.id);
      const row = document.createElement('div');
      row.className = 'contact-row';
      row.innerHTML = `
        <div class="contact-row-info">
          <span class="contact-row-name">${escapeHtml(conv.contact.name || 'Sem nome')}</span>
          <span class="contact-row-number">${escapeHtml(conv.contact.number || '')}</span>
        </div>
        <div class="contact-row-actions">
          <button type="button" class="contact-chat-btn" title="Conversar">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
            </svg>
          </button>
          <input type="checkbox" class="contact-ai-check" title="A IA tem acesso para responder" ${!isBlocked ? 'checked' : ''}>
        </div>
      `;
      container.appendChild(row);

      row.querySelector('.contact-chat-btn').addEventListener('click', () => {
        openContactChat(zap.id, conv.contact.id);
      });

      const cb = row.querySelector('.contact-ai-check');
      cb.addEventListener('change', () => {
        const z = zapsData.find(x => String(x.id) === String(zap.id));
        if (!z) return;
        if (!z.blockedContacts) z.blockedContacts = [];
        if (cb.checked) {
          z.blockedContacts = z.blockedContacts.filter(id => id !== conv.contact.id);
        } else if (!z.blockedContacts.includes(conv.contact.id)) {
          z.blockedContacts.push(conv.contact.id);
        }
        saveZaps();
      });
    });
  } catch (err) {
    container.innerHTML = `<p class="empty-hint" style="color:#dc2626;">Erro: ${escapeHtml(err.message)}</p>`;
  } finally {
    filterContactsDOM();
  }
}

async function openContactChat(zapId, contactId) {
  navigateTo('conversas');
  updateZapSelector();

  const selector = document.getElementById('zapSelector');
  if (selector) selector.value = String(zapId);

  try {
    const conversations = await window.electronAPI.whatsappConversations(String(zapId));
    renderConversations(conversations, zapId);
    const conv = (conversations || []).find(c => c.contact && c.contact.id === contactId);
    if (conv) await openChat(zapId, conv);
  } catch (err) {
    console.error('Erro ao abrir conversa:', err);
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
    workHours: { enabled: false, start: '08:00', end: '18:00', days: [1, 2, 3, 4, 5] },
    runtimeStatus: 'disconnected',
    status: 'Desconectado',
    statusClass: 'offline',
    createdAt: createdAt
  };

  zapsData.unshift(newZap);
  saveZaps();
  renderZaps(zapsData);
  closeModalHandler();

  if (serverManaged && window.electronAPI && window.electronAPI.serverSyncNow) {
    // Envia na hora; o servidor conecta/pareia e o codigo chega pelo watcher
    window.electronAPI.serverSyncNow().catch(() => {});
    setTimeout(() => {
      if (typeof openConnectModal === 'function') openConnectModal(newZap.id, newZap.name, newZap.phone);
    }, 1500);
  }
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

  const list = globalSearchQuery
    ? providersData.filter(p => searchMatches(p.name, globalSearchQuery)
        || (p.models || []).some(m => searchMatches(m.name || m, globalSearchQuery)))
    : providersData;

  if (list.length === 0) {
    container.innerHTML = globalSearchQuery
      ? '<div class="provider-empty">Nenhum provedor encontrado para a busca.</div>'
      : '<div class="provider-empty">Nenhum provedor adicionado. Clique em "Adicionar Provedor" para comear.</div>';
    return;
  }

  container.innerHTML = '';
  list.forEach(provider => {
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
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
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
let providerSnapshot = null;
let provDirty = false;
let currentTestProvider = null;
let currentTestModel = null;
let testChatHistory = [];

function initProviderConfig() {
  const backBtn = document.getElementById('provBackBtn');
  const saveBtn = document.getElementById('provSaveBtn');
  const renameBtn = document.getElementById('provRenameBtn');
  const nameConfirm = document.getElementById('provNameConfirm');
  const nameCancel = document.getElementById('provNameCancel');
  const nameInput = document.getElementById('provNameInput');
  const addKeyBtn = document.getElementById('provAddKeyBtn');
  const keyConfirm = document.getElementById('provKeyConfirmBtn');
  const keyCancel = document.getElementById('provKeyCancelBtn');
  const keyNameInput = document.getElementById('provKeyNameInput');
  const keyValueInput = document.getElementById('provKeyValueInput');

  const closeChatBtn = document.getElementById('closeTestChatModal');
  const sendBtn = document.getElementById('sendTestMessage');
  const chatInput = document.getElementById('testChatInput');

  if (backBtn) backBtn.addEventListener('click', closeProviderConfig);
  if (saveBtn) saveBtn.addEventListener('click', saveProviderChanges);
  if (renameBtn) renameBtn.addEventListener('click', startEditProvName);
  if (nameConfirm) nameConfirm.addEventListener('click', confirmEditProvName);
  if (nameCancel) nameCancel.addEventListener('click', cancelEditProvName);
  if (nameInput) {
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); confirmEditProvName(); }
      if (e.key === 'Escape') { e.preventDefault(); cancelEditProvName(); }
    });
  }
  if (addKeyBtn) addKeyBtn.addEventListener('click', openProvKeyForm);
  if (keyConfirm) keyConfirm.addEventListener('click', confirmAddProvKey);
  if (keyCancel) keyCancel.addEventListener('click', closeProvKeyForm);
  if (keyValueInput) {
    keyValueInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); confirmAddProvKey(); }
      if (e.key === 'Escape') { e.preventDefault(); closeProvKeyForm(); }
    });
  }
  if (keyNameInput) {
    keyNameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); confirmAddProvKey(); }
      if (e.key === 'Escape') { e.preventDefault(); closeProvKeyForm(); }
    });
  }

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
  providerSnapshot = JSON.parse(JSON.stringify(provider));
  provDirty = false;

  // Normaliza estrutura de chaves (legado: s apiKey)
  if (!Array.isArray(provider.apiKeys) || provider.apiKeys.length === 0) {
    provider.apiKeys = provider.apiKey ? [provider.apiKey] : [];
  }
  provider.apiKeyNames = provider.apiKeys.map((k, i) =>
    (Array.isArray(provider.apiKeyNames) && provider.apiKeyNames[i]) || `Chave ${i + 1}`
  );

  document.getElementById('providersListView').style.display = 'none';
  document.getElementById('providerDetailView').style.display = 'block';

  document.getElementById('provDetailName').textContent = provider.name;
  cancelEditProvName();
  closeProvKeyForm();
  setProvDirty(false);
  renderProvKeysList();
  renderProvModelsList();
}

function closeProviderConfig() {
  if (provDirty && providerSnapshot) {
    if (!confirm('Descartar as alteraes feitas neste provedor?')) return;
    const idx = providersData.findIndex(p => p.id === providerSnapshot.id);
    if (idx >= 0) providersData[idx] = providerSnapshot;
  }

  currentEditingProvider = null;
  providerSnapshot = null;
  provDirty = false;

  const detail = document.getElementById('providerDetailView');
  const list = document.getElementById('providersListView');
  if (detail) detail.style.display = 'none';
  if (list) list.style.display = 'block';
  renderProvidersList();
}

function setProvDirty(value) {
  provDirty = !!value;
  const btn = document.getElementById('provSaveBtn');
  if (btn) btn.style.display = provDirty ? 'inline-flex' : 'none';
}

function provKeyNameAt(provider, index) {
  const names = provider.apiKeyNames || [];
  return names[index] || `Chave ${index + 1}`;
}

function normalizeKeyValue(value) {
  return String(value || '').replace(/\s+/g, '').trim();
}

function keyPrefixHint(providerId) {
  const id = String(providerId || '').toLowerCase();
  if (id.includes('openrouter')) return 'sk-or-...';
  if (id.includes('google')) return 'AIza... ou AQ....';
  return null;
}

function keyLooksValidFor(providerId, key) {
  const k = normalizeKeyValue(key);
  if (k.length < 16) return false;
  const id = String(providerId || '').toLowerCase();
  if (id.includes('openrouter')) return k.startsWith('sk-or-');
  if (id.includes('google')) return k.startsWith('AIza') || k.startsWith('AQ.');
  return true;
}

// Persiste o estado atual das chaves imediatamente (localStorage + providers.json
// via IPC). Chaves NUNCA devem depender do botao "Salvar" principal: se o app
// fechar ou o usuario navegar, a chave tem que estar gravada.
function persistProviderKeys() {
  const provider = currentEditingProvider;
  if (!provider) return;
  provider.apiKeys = (provider.apiKeys || [])
    .map(k => normalizeKeyValue(k))
    .filter(Boolean);
  provider.apiKey = provider.apiKeys[0] || '';
  saveProviders();
  const oldName = providerSnapshot ? providerSnapshot.name : provider.name;
  if (typeof syncZapsWithProvider === 'function' && syncZapsWithProvider(provider, oldName)) {
    saveZaps();
    renderZaps(zapsData);
  }
  providerSnapshot = JSON.parse(JSON.stringify(provider));
  setProvDirty(false);
  renderProvKeysList();
}

function renderProvKeysList() {
  const provider = currentEditingProvider;
  const container = document.getElementById('provKeysList');
  if (!container) return;
  if (!provider) { container.innerHTML = ''; return; }

  const keys = provider.apiKeys || [];
  if (keys.length === 0) {
    container.innerHTML = '<div class="prov-empty">Nenhuma chave API cadastrada.</div>';
    return;
  }

  container.innerHTML = '';
  keys.forEach((key, index) => {
    const item = document.createElement('div');
    item.className = 'prov-key-row';
    item.dataset.index = index;
    item.innerHTML = `
      <div class="prov-key-main">
        <span class="prov-key-name">${escapeHtml(provKeyNameAt(provider, index))}</span>
        <span class="prov-key-secret">${escapeHtml(maskApiKey(key))}</span>
      </div>
      <div class="prov-key-actions">
        <button class="prov-icon-btn" data-action="reveal" title="Mostrar/Ocultar">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
        </button>
        <button class="prov-icon-btn" data-action="edit" title="Editar chave">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
          </svg>
        </button>
        <button class="prov-icon-btn danger" data-action="remove" title="Remover chave">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        </button>
      </div>
    `;
    container.appendChild(item);
  });

  container.querySelectorAll('.prov-key-row').forEach(row => {
    const index = parseInt(row.dataset.index, 10);
    row.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action === 'reveal') toggleProvKeySecret(row, index);
        if (action === 'edit') startEditProvKey(row, index);
        if (action === 'remove') removeProvKey(index);
      });
    });
  });
}

function toggleProvKeySecret(row, index) {
  const provider = currentEditingProvider;
  if (!provider) return;
  const secret = row.querySelector('.prov-key-secret');
  if (!secret) return;
  const revealed = secret.dataset.revealed === '1';
  secret.dataset.revealed = revealed ? '0' : '1';
  secret.textContent = revealed
    ? maskApiKey((provider.apiKeys || [])[index] || '')
    : ((provider.apiKeys || [])[index] || '');
}

function startEditProvKey(row, index) {
  const provider = currentEditingProvider;
  if (!provider) return;
  const key = (provider.apiKeys || [])[index] || '';
  const main = row.querySelector('.prov-key-main');
  const actions = row.querySelector('.prov-key-actions');
  if (!main || row.dataset.editing === '1') return;
  row.dataset.editing = '1';
  actions.style.display = 'none';
  main.className = 'prov-key-edit';
  main.innerHTML = `
    <input type="text" class="prov-key-edit-input name" value="${escapeHtml(provKeyNameAt(provider, index))}" placeholder="Nome da chave" maxlength="40">
    <input type="password" class="prov-key-edit-input value" value="${escapeHtml(key)}" placeholder="Chave API">
    <button class="prov-icon-btn ok" data-action="confirm" title="Salvar">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
    </button>
    <button class="prov-icon-btn" data-action="cancel" title="Cancelar">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="6" x2="6" y2="18"/>
        <line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    </button>
  `;
  const nameInput = main.querySelector('.name');
  const valueInput = main.querySelector('.value');
  const confirmBtn = main.querySelector('[data-action="confirm"]');
  const cancelBtn = main.querySelector('[data-action="cancel"]');

  confirmBtn.addEventListener('click', () => {
    const newValue = normalizeKeyValue(valueInput.value);
    if (!newValue) { alert('Informe a chave API.'); return; }
    const hint = keyPrefixHint(provider.id);
    if (hint && !keyLooksValidFor(provider.id, newValue)) {
      if (!confirm(`Esta chave não parece válida para ${provider.name} (formato esperado: ${hint}).\nSalvar mesmo assim?`)) {
        return;
      }
    }
    provider.apiKeys[index] = newValue;
    provider.apiKeyNames = provider.apiKeyNames || [];
    provider.apiKeyNames[index] = nameInput.value.trim() || `Chave ${index + 1}`;
    persistProviderKeys();
  });

  cancelBtn.addEventListener('click', () => renderProvKeysList());

  const onKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); confirmBtn.click(); }
    if (e.key === 'Escape') { e.preventDefault(); cancelBtn.click(); }
  };
  nameInput.addEventListener('keydown', onKey);
  valueInput.addEventListener('keydown', onKey);
  // Seleciona tudo: se o usuario colar por cima sem Ctrl+A, substitui a chave
  // antiga inteira em vez de concatenar (causa classica de chave invalida)
  valueInput.focus();
  valueInput.select();
}

function removeProvKey(index) {
  const provider = currentEditingProvider;
  if (!provider) return;
  const keys = provider.apiKeys || [];
  if (keys.length <= 1) {
    alert('O provedor precisa de pelo menos uma chave API.');
    return;
  }
  if (!confirm('Remover esta chave API?')) return;
  keys.splice(index, 1);
  provider.apiKeys = keys;
  if (Array.isArray(provider.apiKeyNames)) provider.apiKeyNames.splice(index, 1);
  persistProviderKeys();
}

function openProvKeyForm() {
  const form = document.getElementById('provKeyForm');
  if (!form) return;
  form.style.display = 'flex';
  document.getElementById('provKeyNameInput').value = '';
  document.getElementById('provKeyValueInput').value = '';
  document.getElementById('provKeyNameInput').focus();
}

function closeProvKeyForm() {
  const form = document.getElementById('provKeyForm');
  if (form) form.style.display = 'none';
}

function confirmAddProvKey() {
  const provider = currentEditingProvider;
  if (!provider) return;
  const name = document.getElementById('provKeyNameInput').value.trim();
  const value = normalizeKeyValue(document.getElementById('provKeyValueInput').value);
  if (!value) { alert('Informe a chave API.'); return; }

  const hint = keyPrefixHint(provider.id);
  if (hint && !keyLooksValidFor(provider.id, value)) {
    if (!confirm(`Esta chave não parece válida para ${provider.name} (formato esperado: ${hint}).\nAdicionar mesmo assim?`)) {
      return;
    }
  }

  provider.apiKeys = provider.apiKeys || [];
  provider.apiKeyNames = provider.apiKeyNames || [];
  provider.apiKeys.push(value);
  provider.apiKeyNames.push(name || `Chave ${provider.apiKeys.length}`);
  const newIndex = provider.apiKeys.length - 1;

  closeProvKeyForm();
  persistProviderKeys();

  // A chave recem-adicionada passa a valer nos zaps que usam este provedor -
  // senao ela fica guardada e o zap continua tentando a chave antiga (que e
  // exatamente o "adicionei a chave e nao funciona").
  let selectionChanged = false;
  (zapsData || []).forEach(zap => {
    if (!Array.isArray(zap.providers) || !zap.providers.includes(provider.id)) return;
    if (!zap.apiKeySelections) zap.apiKeySelections = {};
    if (zap.apiKeySelections[provider.id] !== newIndex) {
      zap.apiKeySelections[provider.id] = newIndex;
      selectionChanged = true;
    }
  });
  if (selectionChanged) {
    saveZaps();
    renderZaps(zapsData);
  }
}

function renderProvModelsList() {
  const provider = currentEditingProvider;
  const container = document.getElementById('provModelsList');
  const count = document.getElementById('provModelsCount');
  if (!container) return;
  if (!provider) { container.innerHTML = ''; if (count) count.textContent = ''; return; }

  const models = provider.models || [];
  if (count) count.textContent = models.length ? `${models.length} modelos` : '';

  if (models.length === 0) {
    container.innerHTML = '<div class="prov-empty">Nenhum modelo disponvel.</div>';
    return;
  }

  container.innerHTML = '';
  models.forEach(model => {
    const item = document.createElement('div');
    item.className = 'prov-model-row';
    item.innerHTML = `
      <span class="prov-model-name">${escapeHtml(model.name || model.id)}</span>
      <span class="prov-model-id">${escapeHtml(model.id)}</span>
      <button class="prov-icon-btn" data-model-id="${escapeHtml(model.id)}" title="Testar modelo">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
      </button>
    `;
    container.appendChild(item);
  });

  container.querySelectorAll('[data-model-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      const model = models.find(m => m.id === btn.dataset.modelId);
      if (model) openTestChatWith(provider, model);
    });
  });
}

function startEditProvName() {
  if (!currentEditingProvider) return;
  document.getElementById('provDetailName').style.display = 'none';
  document.getElementById('provRenameBtn').style.display = 'none';
  const editor = document.getElementById('provNameEditor');
  editor.style.display = 'flex';
  const input = document.getElementById('provNameInput');
  input.value = currentEditingProvider.name;
  input.focus();
  input.select();
}

function confirmEditProvName() {
  if (!currentEditingProvider) return;
  const input = document.getElementById('provNameInput');
  const value = input.value.trim();
  if (!value) { alert('Informe um nome para o provedor.'); return; }
  if (value !== currentEditingProvider.name) {
    currentEditingProvider.name = value;
    document.getElementById('provDetailName').textContent = value;
    setProvDirty(true);
  }
  cancelEditProvName();
}

function cancelEditProvName() {
  const editor = document.getElementById('provNameEditor');
  const name = document.getElementById('provDetailName');
  const renameBtn = document.getElementById('provRenameBtn');
  if (editor) editor.style.display = 'none';
  if (name) name.style.display = '';
  if (renameBtn) renameBtn.style.display = '';
}

function syncZapsWithProvider(provider, oldName) {
  let changed = false;
  const keys = provider.apiKeys || [];
  const validModelKeys = new Set();
  providersData.forEach(p => (p.models || []).forEach(m => validModelKeys.add(`${p.id}|${m.id}`)));

  zapsData.forEach(zap => {
    // Selecao de chave invalidada pela remocao de chaves
    if (zap.apiKeySelections && zap.apiKeySelections[provider.id] != null) {
      const idx = zap.apiKeySelections[provider.id];
      if (idx >= keys.length) {
        delete zap.apiKeySelections[provider.id];
        changed = true;
      }
    }

    // Referencia legada "Nome do Provedor|modelId"
    if (typeof zap.model === 'string' && zap.model.includes('|')) {
      const [provName, modelId] = zap.model.split('|');
      if (provName === oldName && provider.name !== oldName) {
        zap.model = `${provider.name}|${modelId}`;
        changed = true;
      } else if (provName === provider.name && !(provider.models || []).some(m => m.id === modelId)) {
        zap.model = 'auto';
        changed = true;
      }
    }

    // Modelos marcados que deixaram de existir
    if (Array.isArray(zap.selectedModels) && zap.selectedModels.length) {
      const before = zap.selectedModels.length;
      zap.selectedModels = zap.selectedModels.filter(k => validModelKeys.has(k));
      if (zap.selectedModels.length !== before) changed = true;
      if (zap.selectedModels.length === 0) delete zap.selectedModels;
    }
  });

  return changed;
}

function saveProviderChanges() {
  const provider = currentEditingProvider;
  if (!provider) return;

  const name = (document.getElementById('provDetailName').textContent || '').trim();
  if (!name) { alert('Por favor, insira um nome para o provedor.'); return; }
  provider.name = name;

  const keys = (provider.apiKeys || []).map(k => (k || '').trim()).filter(Boolean);
  if (keys.length === 0) { alert('Por favor, mantenha pelo menos uma chave API.'); return; }
  provider.apiKeys = keys;
  provider.apiKey = keys[0];

  const oldName = providerSnapshot ? providerSnapshot.name : provider.name;

  saveProviders();

  if (syncZapsWithProvider(provider, oldName)) {
    saveZaps();
    renderZaps(zapsData);
  }

  providerSnapshot = JSON.parse(JSON.stringify(provider));
  setProvDirty(false);
  document.getElementById('provDetailName').textContent = provider.name;
  cancelEditProvName();
  closeProvKeyForm();
  renderProvKeysList();
  renderProvModelsList();
  renderProvidersList();

  // Reaplica as mudancas no painel do Zap aberto
  if (currentPanelZapId != null) {
    const zap = zapsData.find(z => String(z.id) === String(currentPanelZapId));
    if (zap) {
      renderPanelProviders(zap);
      renderPanelModelConfig(zap);
    }
  }

  refreshAllZapStatuses();
}

// ============================================
// Test Chat
// ============================================
function openTestChat(modelId) {
  if (!currentEditingProvider) return;

  const model = currentEditingProvider.models.find(m => m.id === modelId);
  if (!model) return;

  openTestChatWith(currentEditingProvider, model);
}

function openTestChatWith(provider, model) {
  if (!provider || !model) return;

  currentTestModel = model;
  currentTestProvider = provider;
  testChatHistory = [];

  document.getElementById('testChatTitle').textContent = `Testar: ${model.name || model.id}`;
  document.getElementById('testChatHistory').innerHTML = `<div class="test-chat-empty">Conversando com <strong>${provider.name}</strong> / ${model.id}<br>Envie uma mensagem para testar o modelo...</div>`;
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

  // Chaves do provedor (apiKeys primeiro, limpas). Testa UMA a UMA: uma
  // chave invalida no topo da lista nao pode derrubar o teste - usa a proxima.
  const apiKeys = (Array.isArray(currentTestProvider.apiKeys) && currentTestProvider.apiKeys.length)
    ? currentTestProvider.apiKeys
    : [currentTestProvider.apiKey];
  const keys = apiKeys.map(k => normalizeKeyValue(k)).filter(Boolean);

  if (!keys.length) {
    updateChatMessage(loadingId, 'error', 'Nenhuma chave API configurada.');
    return;
  }

  try {
    let response = null;
    let lastErr = null;
    for (const key of keys) {
      try {
        response = await callAIModel(currentTestProvider.name, currentTestModel.id, key, message);
        break;
      } catch (e) {
        lastErr = e;
        const msg = String((e && e.message) || '');
        const keyError = /api[_ ]?key|unauthorized|forbidden|invalid.*key|permiss/i.test(msg);
        if (!keyError) throw e; // erro do modelo/rede: trocar de chave nao resolve
      }
    }
    if (response == null && lastErr) throw lastErr;
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

const TEST_SYSTEM_PROMPT = `Voce e um jovem de 17 anos, homem, que gosta de celulares e tecnologia. Voce conversa no WhatsApp como uma pessoa normal, educada e que sabe puxar conversa.

REGRAS DE RESPOSTA (IMPORTANTE):
- Responda com NO MAXIMO 1 frase. 2 frases so se realmente necessario. NUNCA mais que 2 linhas.
- Se a pessoa mandar "oi" ou "ola", responda em 1 frase curta: "Oi, em que posso ajudar?".
- Nao faca listas, nao faca paragrafos, nao seja formal e NAO repita a pergunta da pessoa.
- Responda apenas o que foi perguntado. Nao adicione informacoes extras, nem explicacoes longas.

ESTILO DE CONVERSA:
- Abreviacoes as vezes: "tmj", "vlw", "blz", "td bem".
- "kkkkkk" ou "rsrsrs" quando a conversa for engraçada.
- Seja descontraido, mas educado. Fale como um jovem normal no WhatsApp.

FORMATO DA RESPOSTA (LEIA POR ULTIMO - OBRIGATORIO):
- Responda com NO MAXIMO 1 frase. NUNCA mais de 2 linhas: tudo em uma unica linha.
- Direto ao ponto: sem preambulo, sem repetir a pergunta da pessoa, sem lista.
- Saudacao -> 1 frase: "Oi, em que posso ajudar?". Pergunta simples -> so a resposta.
- Economia de tokens: quanto mais curta e direta a resposta, melhor.`;

async function callAIModel(providerName, modelId, apiKey, message) {
  const lowerProvider = providerName.toLowerCase();
  const systemMessages = [{ role: 'system', content: TEST_SYSTEM_PROMPT }];

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
        messages: [...systemMessages, { role: 'user', content: message }],
        max_tokens: 200,
        temperature: 0.6
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
        contents: [{ role: 'user', parts: [{ text: message }] }],
        systemInstruction: { parts: [{ text: TEST_SYSTEM_PROMPT }] },
        generationConfig: {
          maxOutputTokens: 200,
          temperature: 0.6
        }
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
        messages: [...systemMessages, { role: 'user', content: message }],
        max_tokens: 200,
        temperature: 0.6
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
    if (data.type === 'error' && data.zapId != null) {
      const z = zapsData.find(x => String(x.id) === String(data.zapId));
      if (z) z.lastErrorAt = Date.now();
      if (currentPanelZapId != null && String(currentPanelZapId) === String(data.zapId)) {
        try { refreshPanelStatusUI(data.zapId); } catch (_) {}
      }
    }
  });

  if (window.electronAPI.onWhatsAppContactsUpdated) {
    window.electronAPI.onWhatsAppContactsUpdated((data) => {
      agentContactsCache = null;
      if (currentPanelZapId != null && String(data.zapId) === String(currentPanelZapId)) {
        loadPanelContacts(currentPanelZapId);
      }
    });
  }

  initConnectModal();
  initConversationsPage();
  try { initAutoMsgPage(); } catch (e) { console.error('Erro em initAutoMsgPage:', e); }
  try { initDashboardChat(); } catch (e) { console.error('Erro em initDashboardChat:', e); }
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

  if (serverManaged) {
    // Nao conecta pelo PC: o servidor gera codigo/QR e o painel recebe por evento.
    const cp = document.getElementById('connectProgress');
    if (cp) cp.style.display = 'none';
    const ps = document.getElementById('pairingStatus');
    if (ps) {
      ps.textContent = 'O servidor esta gerando o codigo/QR. Ele aparece aqui em instantes...';
      ps.className = 'connect-status';
    }
    if (window.electronAPI.serverSyncNow) {
      try { await window.electronAPI.serverSyncNow(); } catch (e) {}
    }
    return;
  }

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
    } else if (status === 'pairing_accepted') {
      // Celular ja aceitou o codigo - só falta sincronizar (watchdog de pareamento)
      connectProgress.style.display = 'none';
      pairingStatus.textContent = 'Codigo aceito! Sincronizando conversas...';
      pairingStatus.className = 'connect-status';
    } else if (status === 'authenticated') {
      connectProgress.style.display = 'none';
      pairingStatus.textContent = 'Autenticado! Preparando sistema...';
      pairingStatus.className = 'connect-status';
      qrStatus.textContent = 'Autenticado! Preparando sistema...';
      qrStatus.className = 'connect-status';
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
      'waiting_pairing': 'waiting_pairing', 'pairing_accepted': 'pairing_accepted',
      'authenticated': 'authenticated',
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

  lastRenderedConversations = conversations || [];
  lastRenderedConversationsZapId = zapId;

  if (!conversations || conversations.length === 0) {
    container.innerHTML = '<div class="conversations-empty"><p>Nenhuma conversa ainda</p></div>';
    return;
  }

  const list = globalSearchQuery
    ? conversations.filter(conv => {
        const last = conv.lastMessage ? (conv.lastMessage.body || '') : '';
        return searchMatches(conv.contact ? conv.contact.name : '', globalSearchQuery)
          || searchMatches(conv.contact ? conv.contact.number : '', globalSearchQuery)
          || searchMatches(last, globalSearchQuery);
      })
    : conversations;

  if (list.length === 0) {
    container.innerHTML = '<div class="conversations-empty"><p>Nenhuma conversa encontrada para a busca</p></div>';
    return;
  }

  container.innerHTML = '';
  list.forEach(conv => {
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

  if (selectedConversation) {
    container.querySelectorAll('.conversation-item').forEach(el => {
      if (el.dataset.chatId === selectedConversation.chatId) el.classList.add('active');
    });
  }
}

function clearConversations() {
  lastRenderedConversations = null;
  lastRenderedConversationsZapId = null;
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

  const list = globalSearchQuery
    ? zapsData.filter(zap => zapMatchesSearch(zap, globalSearchQuery)
        || (trainingsData[String(zap.id)] || []).some(t => searchMatches(t.title, globalSearchQuery)))
    : zapsData;

  if (list.length === 0) {
    container.innerHTML = '<p class="empty-hint">Nenhum resultado para a busca.</p>';
    return;
  }

  container.innerHTML = '';
  list.forEach(zap => {
    const count = (trainingsData[String(zap.id)] || []).length;
    const item = document.createElement('div');
    item.className = 'training-zap-item';
    item.innerHTML = `
      <div class="training-zap-info">
        <div class="training-zap-name-row">
          <span class="training-zap-name">${escapeHtml(zap.name)}</span>
          <span class="training-zap-phone">${escapeHtml(zap.phone)}</span>
          <button type="button" class="training-zap-copy" title="Copiar nmero">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="training-zap-meta">
        <span class="training-zap-count">${count} treinamento${count === 1 ? '' : 's'}</span>
        <span class="training-zap-arrow">&rsaquo;</span>
      </div>
    `;
    item.addEventListener('click', () => openTrainingEditor(zap.id));

    const copyBtn = item.querySelector('.training-zap-copy');
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(zap.phone).then(() => {
        const orig = copyBtn.innerHTML;
        copyBtn.classList.add('copied');
        copyBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
        setTimeout(() => {
          copyBtn.classList.remove('copied');
          copyBtn.innerHTML = orig;
        }, 1600);
      }).catch(() => {});
    });

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

  renderImageLibrary();

  const list = trainingsData[String(currentTrainingZapId)] || [];
  if (list.length === 0) {
    container.innerHTML = '<p class="empty-hint">Nenhum treinamento ainda. Clique em "Adicionar Treinamento" para começar.</p>';
    return;
  }

  const visible = globalSearchQuery
    ? list.filter(t => searchMatches(t.title, globalSearchQuery))
    : list;

  if (visible.length === 0) {
    container.innerHTML = '<p class="empty-hint">Nenhum treinamento encontrado para a busca.</p>';
    return;
  }

  container.innerHTML = '';
  visible.forEach(t => {
    const imgs = Array.isArray(t.images) ? t.images : [];
    const lnks = Array.isArray(t.links) ? t.links : [];
    const item = document.createElement('div');
    item.className = 'training-item' + (t.enabled === false ? ' disabled' : '');
    item.innerHTML = `
      <div class="training-item-main">
        <div class="training-item-title">${escapeHtml(t.title || 'Sem título')}</div>
        ${imgs.length ? `<div class="training-item-thumbs">${imgs.map(i => `<img src="${i.thumb || i.data || ''}" alt="" class="training-item-thumb">`).join('')}</div>` : ''}
        ${lnks.length ? `<div class="training-item-links">${lnks.length} link${lnks.length === 1 ? '' : 's'}</div>` : ''}
      </div>
      <div class="training-item-actions">
        <button type="button" class="train-act" data-action="toggle" data-id="${t.id}" title="${t.enabled === false ? 'Ativar' : 'Desativar'}">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18.36 6.64a9 9 0 1 1-12.73 0"/>
            <line x1="12" y1="2" x2="12" y2="12"/>
          </svg>
        </button>
        <button type="button" class="train-act" data-action="edit" data-id="${t.id}" title="Editar">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
          </svg>
        </button>
        <button type="button" class="train-act danger" data-action="delete" data-id="${t.id}" title="Excluir">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        </button>
      </div>
    `;
    container.appendChild(item);
  });
}

function renderImageLibrary() {
  const grid = document.getElementById('imageLibraryGrid');
  const count = document.getElementById('imageLibraryCount');
  if (!grid) return;

  const items = [];
  Object.keys(trainingsData || {}).forEach(zapId => {
    const zap = zapsData.find(z => String(z.id) === String(zapId));
    (trainingsData[zapId] || []).forEach(t => {
      (Array.isArray(t.images) ? t.images : []).forEach(img => {
        if (!img) return;
        items.push({
          img,
          zapName: zap ? zap.name : 'Zap',
          trainingTitle: t.title || 'Sem título'
        });
      });
    });
  });

  if (count) count.textContent = items.length ? `${items.length} imagem${items.length === 1 ? '' : 's'}` : '';

  if (items.length === 0) {
    grid.innerHTML = '<p class="empty-hint">Nenhuma imagem adicionada ainda.</p>';
    return;
  }

  grid.innerHTML = items.map((it, i) => `
    <button type="button" class="image-library-item" data-index="${i}" title="${escapeHtml(it.img.filename || 'Imagem')}">
      <img src="${it.img.thumb || it.img.data || ''}" alt="${escapeHtml(it.img.filename || 'Imagem')}">
      <span class="image-library-label">${escapeHtml(it.zapName)}</span>
    </button>
  `).join('');

  grid.querySelectorAll('[data-index]').forEach(btn => {
    btn.addEventListener('click', () => {
      const it = items[parseInt(btn.dataset.index, 10)];
      if (it) openImageViewer(it);
    });
  });
}

function openImageViewer(item) {
  const modal = document.getElementById('imageViewerModal');
  if (!modal) return;
  document.getElementById('imageViewerTitle').textContent = item.img.filename || 'Imagem';
  const img = document.getElementById('imageViewerImg');
  img.src = item.img.data || item.img.thumb || '';
  const parts = [item.zapName, item.trainingTitle];
  if (item.img.description) parts.push(item.img.description);
  document.getElementById('imageViewerCaption').textContent = parts.join(' · ');
  modal.classList.add('active');
}

function closeImageViewer() {
  const modal = document.getElementById('imageViewerModal');
  if (modal) modal.classList.remove('active');
  const img = document.getElementById('imageViewerImg');
  if (img) img.src = '';
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
        <input type="text" class="modal-image-name-field" placeholder="Nome (ex: Cardápio salgados)" value="${escapeHtml(img.name || '')}" data-idx="${idx}">
        <input type="text" class="modal-image-desc" placeholder="Sobre o que é esta imagem" value="${escapeHtml(img.description || '')}" data-idx="${idx}">
      </div>
      <button type="button" class="modal-image-remove" data-idx="${idx}" title="Remover">&times;</button>
    `;
    container.appendChild(div);
  });

  container.querySelectorAll('.modal-image-name-field').forEach(input => {
    input.addEventListener('input', (e) => {
      const idx = parseInt(e.target.dataset.idx, 10);
      if (modalPendingImages[idx]) {
        modalPendingImages[idx].name = e.target.value;
      }
    });
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

function renderModalLinks() {
  const container = document.getElementById('trainingLinksList');
  if (!container) return;

  if (modalPendingLinks.length === 0) {
    container.innerHTML = '<p class="form-hint" style="margin-top:8px;margin-bottom:0">Nenhum link adicionado.</p>';
    return;
  }

  container.innerHTML = '';
  modalPendingLinks.forEach((lk, idx) => {
    const div = document.createElement('div');
    div.className = 'modal-link-item';
    div.innerHTML = `
      <div class="modal-image-info">
        <div class="modal-image-name">${escapeHtml(lk.url || '')}</div>
        <input type="text" class="modal-link-url" placeholder="https://..." value="${escapeHtml(lk.url || '')}" data-idx="${idx}">
        <input type="text" class="modal-image-desc" placeholder="Nome/sobre o que é este link" value="${escapeHtml(lk.description || '')}" data-idx="${idx}">
      </div>
      <button type="button" class="modal-link-remove" data-idx="${idx}" title="Remover">&times;</button>
    `;
    container.appendChild(div);
  });

  container.querySelectorAll('.modal-link-url').forEach(input => {
    input.addEventListener('input', (e) => {
      const idx = parseInt(e.target.dataset.idx, 10);
      if (modalPendingLinks[idx]) modalPendingLinks[idx].url = e.target.value;
    });
  });

  container.querySelectorAll('.modal-image-desc').forEach(input => {
    input.addEventListener('input', (e) => {
      const idx = parseInt(e.target.dataset.idx, 10);
      if (modalPendingLinks[idx]) modalPendingLinks[idx].description = e.target.value;
    });
  });

  container.querySelectorAll('.modal-link-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.currentTarget.dataset.idx, 10);
      modalPendingLinks.splice(idx, 1);
      renderModalLinks();
    });
  });
}

function addTrainingLinkFromInputs() {
  const urlInput = document.getElementById('trainingLinkUrl');
  const descInput = document.getElementById('trainingLinkDesc');
  const url = (urlInput?.value || '').trim();
  const description = (descInput?.value || '').trim();

  if (!url) { alert('Digite o endereço do link.'); return; }
  if (!/^https?:\/\//i.test(url) && !/^[\w-]+(\.[\w-]+)+/.test(url)) {
    alert('Link inválido. Comece com https:// (ex: https://exemplo.com/cardapio).');
    return;
  }
  if (modalPendingLinks.length >= 10) { alert('Máximo de 10 links por treinamento.'); return; }

  const normalized = /^https?:\/\//i.test(url) ? url : 'https://' + url;
  modalPendingLinks.push({
    id: 'lnk_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    url: normalized,
    description
  });

  if (urlInput) urlInput.value = '';
  if (descInput) descInput.value = '';
  renderModalLinks();
  if (urlInput) urlInput.focus();
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
        name: '',
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
  modalPendingLinks = [];

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
    modalPendingLinks = JSON.parse(JSON.stringify(t.links || []));
  } else {
    if (modalTitle) modalTitle.textContent = 'Adicionar Treinamento';
    titleInput.value = '';
    contentInput.value = '';
  }

  updateTrainingCharCount();
  renderModalImages();
  renderModalLinks();
  modal.classList.add('active');
}

function closeTrainingModal() {
  const modal = document.getElementById('trainingModal');
  if (modal) modal.classList.remove('active');
  editingTrainingId = null;
  modalPendingImages = [];
  modalDeletedFiles = [];
  modalPendingLinks = [];
}

async function saveTrainingFromModal() {
  if (currentTrainingZapId == null) return;

  const title = (document.getElementById('trainingTitle')?.value || '').trim();
  const content = (document.getElementById('trainingContent')?.value || '').trim();

  if (!content && modalPendingImages.length === 0 && modalPendingLinks.length === 0) {
    alert('Adicione um conteúdo, uma imagem ou um link.');
    return;
  }

  const images = modalPendingImages.map(img => {
    const out = {
      id: img.id,
      filename: img.filename,
      mimeType: img.mimeType,
      name: img.name || '',
      description: img.description || '',
      thumb: img.thumb || null
    };
    if (img.file) out.file = img.file;
    if (img.data) out.data = img.data;
    return out;
  });

  const links = modalPendingLinks
    .filter(lk => lk && lk.url)
    .map(lk => ({
      id: lk.id,
      url: lk.url,
      description: lk.description || ''
    }));

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
      t.links = links;
      t.updatedAt = now;
    }
  } else {
    list.push({
      id: 'tr_' + now + '_' + Math.random().toString(36).slice(2, 8),
      title,
      content,
      images,
      links,
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

  document.getElementById('closeImageViewer')?.addEventListener('click', closeImageViewer);
  document.getElementById('imageViewerModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'imageViewerModal') closeImageViewer();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const viewer = document.getElementById('imageViewerModal');
      if (viewer && viewer.classList.contains('active')) closeImageViewer();
    }
  });

  document.getElementById('trainingImageInput')?.addEventListener('change', (e) => {
    processTrainingFiles(e.target.files);
    e.target.value = '';
  });

  document.getElementById('addTrainingLink')?.addEventListener('click', addTrainingLinkFromInputs);
  document.getElementById('trainingLinkUrl')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addTrainingLinkFromInputs(); }
  });
  document.getElementById('trainingLinkDesc')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addTrainingLinkFromInputs(); }
  });

  document.getElementById('trainingContent')?.addEventListener('input', updateTrainingCharCount);
  document.getElementById('trainingsList')?.addEventListener('click', handleTrainingListAction);
}

// ============================================
// Mensagem Automática (somente ChatBox)
// ============================================
let autoMsgState = null;
let autoMsgViewZap = '';
let autoMsgAttachments = [];
let autoMsgBusy = false;
let autoMsgRecorder = null;
let autoMsgRecChunks = [];
let autoMsgInitialized = false;

function getAutoMsgStateSafe() {
  return autoMsgState || { zapId: null, status: 'idle', chats: {}, log: [], queue: [], recipients: [], counts: {} };
}

function autoMsgTime(t) {
  try {
    return new Date(t || Date.now()).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  } catch (_) { return ''; }
}

function getAutoMsgSelectedZap() {
  if (!autoMsgViewZap) return null;
  return zapsData.find(z => String(z.id) === String(autoMsgViewZap)) || null;
}

function initAutoMsgPage() {
  if (autoMsgInitialized) return;
  autoMsgInitialized = true;

  const input = document.getElementById('autoMsgInput');
  const sendBtn = document.getElementById('autoMsgSendBtn');
  const stopBtn = document.getElementById('autoMsgStopBtn');
  const connectBtn = document.getElementById('autoMsgConnectBtn');
  const accountsBtn = document.getElementById('autoMsgAccountsBtn');
  const addZapBtn = document.getElementById('autoMsgAddZapBtn');
  const micBtn = document.getElementById('autoMsgMicBtn');
  const fileBtn = document.getElementById('autoMsgFileBtn');
  const fileInput = document.getElementById('autoMsgFileInput');

  if (sendBtn) sendBtn.addEventListener('click', autoMsgSend);
  if (stopBtn) stopBtn.addEventListener('click', autoMsgStop);
  if (connectBtn) connectBtn.addEventListener('click', autoMsgConnect);
  if (addZapBtn) addZapBtn.addEventListener('click', () => openModal());
  if (micBtn) micBtn.addEventListener('click', autoMsgToggleMic);
  if (fileBtn && fileInput) {
    fileBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
      autoMsgOnFiles(e.target.files);
      e.target.value = '';
    });
  }
  if (accountsBtn) {
    accountsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      autoMsgToggleAccounts();
    });
  }

  // Fecha a lista de contas ao clicar fora
  document.addEventListener('click', (e) => {
    const panel = document.getElementById('autoMsgAccountsPanel');
    const btn = document.getElementById('autoMsgAccountsBtn');
    if (!panel || panel.style.display === 'none') return;
    if (panel.contains(e.target) || (btn && btn.contains(e.target))) return;
    autoMsgCloseAccounts();
  });

  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        autoMsgSend();
      }
    });
  }

  if (window.electronAPI) {
    if (window.electronAPI.onAutoMsgUpdate) {
      window.electronAPI.onAutoMsgUpdate((s) => renderAutoMsgState(s));
    }
    if (window.electronAPI.onWhatsAppStatus) {
      window.electronAPI.onWhatsAppStatus(() => {
        updateAutoMsgConnectBtn();
        renderAutoMsgAccounts();
      });
    }
    if (window.electronAPI.onWhatsAppMessage) {
      window.electronAPI.onWhatsAppMessage((data) => autoMsgOnIncoming(data));
    }
    if (window.electronAPI.autoMsgState) {
      window.electronAPI.autoMsgState()
        .then(s => { if (s) renderAutoMsgState(s); })
        .catch(() => {});
    }
  }

  // Contagem regressiva do proximo envio (5 min)
  setInterval(() => {
    if (getActivePageId() === 'mensagem-automatica') updateAutoMsgCampaign();
  }, 1000);
}

function onAutoMsgPageOpen() {
  if (!autoMsgViewZap) {
    try { autoMsgViewZap = localStorage.getItem('linknozap_autoMsgViewZap') || ''; } catch (_) {}
  }
  const st = getAutoMsgStateSafe();
  const valid = (id) => id && zapsData.some(z => String(z.id) === String(id));
  if (!valid(autoMsgViewZap)) {
    autoMsgViewZap = valid(st.zapId) ? String(st.zapId) : (zapsData[0] ? String(zapsData[0].id) : '');
  }
  renderAutoMsgAccounts();
  updateAutoMsgConnectBtn();
  renderAutoMsgChat();
  updateAutoMsgCampaign();
  if (window.electronAPI && window.electronAPI.autoMsgState) {
    window.electronAPI.autoMsgState()
      .then(s => { if (s) renderAutoMsgState(s); })
      .catch(() => {});
  }
  const input = document.getElementById('autoMsgInput');
  if (input) input.focus();
}

// --- Lista de contas (botao >) ---
function autoMsgToggleAccounts() {
  const panel = document.getElementById('autoMsgAccountsPanel');
  const btn = document.getElementById('autoMsgAccountsBtn');
  if (!panel) return;
  if (panel.style.display === 'none') {
    renderAutoMsgAccounts();
    panel.style.display = 'block';
    if (btn) btn.classList.add('open');
  } else {
    autoMsgCloseAccounts();
  }
}

function autoMsgCloseAccounts() {
  const panel = document.getElementById('autoMsgAccountsPanel');
  const btn = document.getElementById('autoMsgAccountsBtn');
  if (panel) panel.style.display = 'none';
  if (btn) btn.classList.remove('open');
}

function renderAutoMsgAccounts() {
  const list = document.getElementById('autoMsgAccountsList');
  if (!list) return;
  list.innerHTML = '';
  if (!zapsData.length) {
    const div = document.createElement('div');
    div.className = 'am-account-row';
    div.style.cursor = 'default';
    div.textContent = 'Nenhuma conta cadastrada';
    list.appendChild(div);
    return;
  }
  zapsData.forEach(z => {
    const info = getZapStatusInfo(z);
    const row = document.createElement('div');
    row.className = 'am-account-row'
      + (info.online ? ' online' : '')
      + (String(z.id) === String(autoMsgViewZap) ? ' active' : '');
    const dot = document.createElement('span');
    dot.className = 'dot';
    const name = document.createElement('span');
    name.className = 'am-account-name';
    name.textContent = z.name;
    const phone = document.createElement('span');
    phone.className = 'am-account-phone';
    phone.textContent = z.phone || '';
    const infoBox = document.createElement('span');
    infoBox.className = 'am-account-info';
    infoBox.appendChild(name);
    infoBox.appendChild(phone);
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'am-account-edit';
    edit.title = 'Editar nome do Zap';
    edit.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>';
    edit.addEventListener('click', (e) => {
      e.stopPropagation();
      startRenameZap(z, name);
    });
    row.appendChild(dot);
    row.appendChild(infoBox);
    row.appendChild(edit);
    row.addEventListener('click', () => autoMsgSelectAccount(z.id));
    list.appendChild(row);
  });
}

function autoMsgSelectAccount(id) {
  autoMsgViewZap = String(id);
  try { localStorage.setItem('linknozap_autoMsgViewZap', autoMsgViewZap); } catch (_) {}
  renderAutoMsgAccounts();
  updateAutoMsgConnectBtn();
  renderAutoMsgChat();
  autoMsgCloseAccounts();
}

function updateAutoMsgConnectBtn() {
  const btn = document.getElementById('autoMsgConnectBtn');
  if (!btn) return;
  const zap = getAutoMsgSelectedZap();
  if (zap && getZapStatusInfo(zap).online) {
    btn.textContent = 'Conectado';
    btn.classList.add('connected');
  } else {
    btn.textContent = 'Conectar';
    btn.classList.remove('connected');
  }
}

function autoMsgConnect() {
  const zap = getAutoMsgSelectedZap();
  if (!zap) { alert('Escolha uma conta no botao > (canto inferior esquerdo).'); return; }
  if (getZapStatusInfo(zap).online) { alert('Esta conta ja esta conectada.'); return; }
  openConnectModal(zap.id, zap.name, zap.phone);
  connectZapWithMethod(zap.id, (zap.phone || '').replace(/\D/g, ''), 'qrcode');
}

// --- Historico da conversa ---
function autoMsgAppendMsg(role, content, t, pending) {
  const box = document.getElementById('autoMsgMessages');
  const empty = document.getElementById('autoMsgEmpty');
  if (!box) return;
  if (empty) empty.style.display = 'none';

  const div = document.createElement('div');
  const cls = role === 'agent' ? 'agent' : (role === 'system' ? 'system' : 'user');
  div.className = 'am-msg ' + cls + (pending ? ' pending' : '');
  div.textContent = String(content || '');
  const time = document.createElement('span');
  time.className = 'am-msg-time';
  time.textContent = autoMsgTime(t);
  div.appendChild(time);
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function renderAutoMsgChat() {
  const box = document.getElementById('autoMsgMessages');
  const empty = document.getElementById('autoMsgEmpty');
  if (!box) return;
  [...box.querySelectorAll('.am-msg')].forEach(el => el.remove());

  const st = getAutoMsgStateSafe();
  const all = (st.chats && st.chats[autoMsgViewZap]) || [];
  const q = (getActivePageId() === 'mensagem-automatica' ? globalSearchQuery : '') || '';
  const entries = q ? all.filter(c => searchMatches(c.content, q)) : all;

  if (!entries.length) {
    if (empty) empty.style.display = '';
    return;
  }
  if (empty) empty.style.display = 'none';
  entries.forEach(c => autoMsgAppendMsg(c.role, c.content, c.t, false));
  box.scrollTop = box.scrollHeight;
}

function renderAutoMsgState(s) {
  if (!s) return;
  autoMsgState = s;
  renderAutoMsgChat();
  renderAutoMsgAccounts();
  updateAutoMsgConnectBtn();
  updateAutoMsgCampaign();
}

// --- Status da campanha (dentro do painel de contas) ---
function updateAutoMsgCampaign() {
  const wrap = document.getElementById('autoMsgCampaign');
  const text = document.getElementById('autoMsgCampaignText');
  const stopBtn = document.getElementById('autoMsgStopBtn');
  if (!wrap || !text) return;

  const s = getAutoMsgStateSafe();
  const c = s.counts || null;
  if (!c || (!c.total && s.status === 'idle')) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = 'flex';

  let label = '';
  if (s.status === 'running') {
    let countdown = '';
    if (s.nextAt && s.nextAt > Date.now()) {
      const d = Math.max(0, Math.round((s.nextAt - Date.now()) / 1000));
      countdown = ` - proxima em ${Math.floor(d / 60)}:${String(d % 60).padStart(2, '0')}`;
    }
    label = `Enviando... ${c.sent}/${c.total}${countdown}`;
  } else if (s.status === 'done') {
    label = `Concluida: ${c.sent}/${c.total}`;
  } else if (s.status === 'stopped') {
    label = `Parada: ${c.sent}/${c.total}`;
  } else {
    label = `${c.sent}/${c.total} enviadas`;
  }
  if (c.failed) label += `, ${c.failed} falha(s)`;
  text.textContent = label;
  if (stopBtn) stopBtn.style.display = s.status === 'running' ? '' : 'none';
}

// --- Anexos ---
function autoMsgRenderChips() {
  const row = document.getElementById('autoMsgFiles');
  if (!row) return;
  row.innerHTML = '';
  row.style.display = autoMsgAttachments.length ? 'flex' : 'none';
  autoMsgAttachments.forEach((f, i) => {
    const chip = document.createElement('span');
    chip.className = 'am-chip';
    const name = document.createElement('span');
    name.className = 'am-chip-name';
    name.textContent = f.name;
    name.title = f.name;
    const btn = document.createElement('button');
    btn.className = 'am-chip-remove';
    btn.textContent = '×';
    btn.title = 'Remover anexo';
    btn.addEventListener('click', () => {
      autoMsgAttachments.splice(i, 1);
      autoMsgRenderChips();
    });
    chip.appendChild(name);
    chip.appendChild(btn);
    row.appendChild(chip);
  });
}

function autoMsgOnFiles(fileList) {
  const MAX = 15 * 1024 * 1024;
  const files = Array.from(fileList || []);
  for (const f of files) {
    if (f.size > MAX) {
      alert(`Arquivo grande demais (maximo 15MB): ${f.name}`);
      continue;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const raw = String(reader.result || '');
      const data = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
      autoMsgAttachments.push({
        name: f.name,
        mimeType: f.type || 'application/octet-stream',
        data
      });
      autoMsgRenderChips();
    };
    reader.onerror = () => alert(`Nao foi possivel ler o arquivo: ${f.name}`);
    reader.readAsDataURL(f);
  }
}

// --- Ditado por voz ---
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || '').split(',').pop());
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

async function autoMsgToggleMic() {
  const btn = document.getElementById('autoMsgMicBtn');
  if (!btn) return;
  if (autoMsgRecorder) {
    try { autoMsgRecorder.stop(); } catch (_) {}
    return;
  }
  if (!navigator.mediaDevices || typeof MediaRecorder === 'undefined') {
    alert('Ditado indisponivel nesta versao do sistema.');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const rec = new MediaRecorder(stream);
    autoMsgRecChunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) autoMsgRecChunks.push(e.data); };
    rec.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      btn.classList.remove('recording');
      btn.textContent = 'Ditar';
      btn.title = 'Ditar mensagem (voz)';
      autoMsgRecorder = null;
      const blob = new Blob(autoMsgRecChunks, { type: (autoMsgRecChunks[0] && autoMsgRecChunks[0].type) || 'audio/webm' });
      if (blob.size < 400) return;
      btn.textContent = 'Transcrevendo...';
      btn.title = 'Transcrevendo...';
      try {
        const b64 = await blobToBase64(blob);
        const text = await window.electronAPI.autoMsgTranscribe({
          data: b64, mimetype: blob.type, size: blob.size
        }, autoMsgViewZap);
        const input = document.getElementById('autoMsgInput');
        if (text && String(text).trim() && input) {
          input.value = (input.value ? input.value.replace(/\s+$/, '') + ' ' : '') + String(text).trim();
          input.focus();
        } else {
          alert('Nao consegui transcrever o audio. Tente falar mais perto do microfone.');
        }
      } catch (e) {
        alert('Erro ao transcrever: ' + (e && e.message ? e.message : e));
      } finally {
        btn.textContent = 'Ditar';
        btn.title = 'Ditar mensagem (voz)';
      }
    };
    rec.start();
    autoMsgRecorder = rec;
    btn.classList.add('recording');
    btn.textContent = 'Gravando...';
    btn.title = 'Clique para parar a gravacao';
  } catch (e) {
    alert('Microfone indisponivel: ' + (e && e.message ? e.message : e));
  }
}

// --- Envio do pedido para a IA ---
async function autoMsgSend() {
  if (autoMsgBusy) return;
  const input = document.getElementById('autoMsgInput');
  const sendBtn = document.getElementById('autoMsgSendBtn');
  const zap = getAutoMsgSelectedZap();

  const text = input ? input.value.trim() : '';
  const attachments = autoMsgAttachments.slice();

  if (!zap) {
    alert('Escolha a conta no botao > (canto inferior esquerdo) antes de enviar.');
    return;
  }
  if (!text && !attachments.length) return;

  autoMsgBusy = true;
  if (sendBtn) sendBtn.disabled = true;

  const names = attachments.map(a => a.name).join(', ');
  autoMsgAppendMsg('user', text || `(anexos: ${names})`, Date.now());
  if (input) input.value = '';
  autoMsgAttachments = [];
  autoMsgRenderChips();

  try {
    const res = await window.electronAPI.autoMsgChat({
      zapId: String(zap.id),
      text,
      attachments
    });
    const s = await window.electronAPI.autoMsgState();
    if (s) renderAutoMsgState(s);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    autoMsgAppendMsg('agent', 'Erro: ' + msg, Date.now());
  } finally {
    autoMsgBusy = false;
    if (sendBtn) sendBtn.disabled = false;
    if (input) input.focus();
  }
}

async function autoMsgStop() {
  const s = autoMsgState;
  if (!s || s.status !== 'running') {
    alert('Nenhuma campanha em andamento.');
    return;
  }
  if (!confirm('Parar a campanha? A fila sera mantida e pode continuar depois.')) return;
  try {
    const next = await window.electronAPI.autoMsgStop();
    if (next) renderAutoMsgState(next);
  } catch (e) {
    alert('Erro ao parar: ' + (e && e.message ? e.message : e));
  }
}

// Respostas recebidas entram no historico da conta selecionada
function autoMsgOnIncoming(data) {
  if (!data || !autoMsgViewZap) return;
  if (String(data.zapId) !== String(autoMsgViewZap)) return;
  if (data.fromMe) return;

  const raw = String(data.from || (data.chat && data.chat.id) || '').split('@')[0].replace(/\D/g, '');
  if (!raw) return;
  const phone = (raw.startsWith('55') && (raw.length === 12 || raw.length === 13))
    ? raw
    : (raw.length >= 10 && raw.length <= 11 ? '55' + raw : raw);

  const st = getAutoMsgStateSafe();
  const known = (st.recipients || []).some(r => String(r.phone) === phone);
  if (!known) return;

  const body = String(data.body || '').trim() || '[midia/audio]';
  const previewMsg = body.length > 120 ? body.substring(0, 120) + '...' : body;
  if (window.electronAPI && window.electronAPI.autoMsgNote) {
    window.electronAPI.autoMsgNote(String(autoMsgViewZap), `Resposta de +${phone}: "${previewMsg}"`)
      .then(s => { if (s) renderAutoMsgState(s); })
      .catch(() => {});
  }
}
// ============================================
// Dashboard - Agente IA (ChatBox funcional)
// ============================================
let agentHistory = [];
let agentBusy = false;
let agentContactsCache = null;
let agentMentions = {};
let agentDictating = false;
let agentRecorder = null;
let agentRecChunks = [];

function initDashboardChat() {
  const input = document.getElementById('dashChatInput');
  if (!input) return;
  const sendBtn = document.getElementById('dashChatSend');
  const micBtn = document.getElementById('dashChatMic');
  const filesBtn = document.getElementById('dashChatFiles');

  if (sendBtn) sendBtn.addEventListener('click', sendAgentMessage);

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendAgentMessage();
    }
  });

  input.addEventListener('input', () => {
    autosizeDashInput(input);
    handleDashMention(input);
  });

  input.addEventListener('blur', () => {
    setTimeout(hideDashMentionDropdown, 150);
  });

  if (micBtn) micBtn.addEventListener('click', toggleDashDictation);
  if (filesBtn) filesBtn.addEventListener('click', attachDashFile);
}

function autosizeDashInput(input) {
  input.style.height = 'auto';
  input.style.height = Math.min(132, input.scrollHeight) + 'px';
}

function setDashBusy(busy) {
  agentBusy = busy;
  const sendBtn = document.getElementById('dashChatSend');
  const input = document.getElementById('dashChatInput');
  if (sendBtn) sendBtn.disabled = busy;
  if (input) input.disabled = busy;
}

function appendDashBubble(role, text) {
  const box = document.getElementById('dashChatMessages');
  if (!box) return null;
  const div = document.createElement('div');
  div.className = 'dash-msg ' + (role === 'user' ? 'dash-msg-user' : 'dash-msg-agent');
  div.textContent = String(text || '');
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

function appendDashToolLine(step) {
  const box = document.getElementById('dashChatMessages');
  if (!box || !step) return;
  const div = document.createElement('div');
  div.className = 'dash-msg-tool';
  const mark = step.ok ? '✓' : '✕';
  div.textContent = `${mark} ${step.tool}${step.info ? ' — ' + step.info : ''}`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function showDashTyping() {
  const box = document.getElementById('dashChatMessages');
  if (!box) return null;
  const div = document.createElement('div');
  div.className = 'dash-msg dash-msg-agent dash-typing';
  div.innerHTML = '<span class="dash-dot"></span><span class="dash-dot"></span><span class="dash-dot"></span>';
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

async function sendAgentMessage() {
  const input = document.getElementById('dashChatInput');
  if (!input || agentBusy) return;
  const text = input.value.trim();
  if (!text) return;

  const mentions = collectDashMentions(text);
  input.value = '';
  autosizeDashInput(input);
  hideDashMentionDropdown();
  agentMentions = {};

  appendDashBubble('user', text);
  setDashBusy(true);
  const typing = showDashTyping();

  try {
    const res = await window.electronAPI.agentChat({
      message: text,
      history: agentHistory.slice(-16),
      mentions
    });
    if (typing && typing.parentNode) typing.parentNode.removeChild(typing);
    agentHistory.push({ role: 'user', content: text });
    const steps = (res && res.steps) || [];
    steps.forEach(appendDashToolLine);
    const reply = (res && res.reply) || 'Sem resposta.';
    appendDashBubble('agent', reply);
    agentHistory.push({ role: 'assistant', content: reply });
    if (steps.some(s => s.ok)) await syncDataAfterAgent();
  } catch (e) {
    if (typing && typing.parentNode) typing.parentNode.removeChild(typing);
    appendDashBubble('agent', 'Erro ao conversar com o agente: ' + (e && e.message ? e.message : e));
  } finally {
    setDashBusy(false);
    input.focus();
  }
}

// Recarrega dados locais apos o agente mexer no app (zaps/treinamentos)
async function syncDataAfterAgent() {
  try {
    const zaps = await window.electronAPI.loadZaps();
    if (Array.isArray(zaps)) {
      zapsData = zaps;
      localStorage.setItem('linknozap_zaps', JSON.stringify(zapsData));
      zapsData.forEach(z => {
        if (z.enabled === undefined) z.enabled = true;
        try { applyRuntimeStatus(z, z.runtimeStatus || 'disconnected'); } catch (_) {}
      });
      renderZaps(zapsData);
      updateZapSelector();
      if (currentPanelZapId != null) {
        const open = zapsData.find(x => String(x.id) === String(currentPanelZapId));
        if (open) {
          const nameEl = document.getElementById('zapPanelName');
          if (nameEl) nameEl.textContent = open.name;
          try { refreshPanelStatusUI(currentPanelZapId); } catch (_) {}
        } else {
          const panel = document.getElementById('zapPanelView');
          const list = document.getElementById('zapsListView');
          if (panel && list) { panel.style.display = 'none'; list.style.display = 'block'; currentPanelZapId = null; }
        }
      }
      try { renderAutoMsgAccounts(); } catch (_) {}
      try { updateAutoMsgConnectBtn(); } catch (_) {}
    }
    const tr = await window.electronAPI.loadTrainings();
    trainingsData = tr || {};
    renderTrainingZapsList();
    if (currentTrainingZapId != null) renderTrainingsList();
    agentContactsCache = null;
  } catch (e) {
    console.error('syncDataAfterAgent:', e);
  }
}

// --------------------------- Contatos @ ---------------------------
async function loadDashContacts() {
  if (agentContactsCache) return agentContactsCache;
  const list = [];
  try {
    for (const z of zapsData) {
      const convs = await window.electronAPI.whatsappConversations(String(z.id));
      (convs || []).forEach(c => {
        const contact = c.contact || {};
        const number = String(contact.number || contact.id || '').replace(/@.*/, '').replace(/\D/g, '');
        const name = String(contact.name || contact.pushname || contact.shortName || number || 'Sem nome');
        if (number && !list.some(x => x.number === number)) {
          list.push({ name, number, zapId: z.id, zapName: z.name });
        }
      });
    }
  } catch (e) {}
  agentContactsCache = list;
  return list;
}

function ensureDashMentionDropdown() {
  let dd = document.getElementById('dashMentionDd');
  if (dd) return dd;
  const host = document.querySelector('.dash-chat');
  if (!host) return null;
  dd = document.createElement('div');
  dd.id = 'dashMentionDd';
  dd.className = 'dash-mention-dd';
  host.appendChild(dd);
  return dd;
}

function hideDashMentionDropdown() {
  const dd = document.getElementById('dashMentionDd');
  if (dd) dd.style.display = 'none';
}

function handleDashMention(input) {
  const pos = input.selectionStart != null ? input.selectionStart : input.value.length;
  const upto = input.value.slice(0, pos);
  const m = upto.match(/@([^\s@]{0,25})$/);
  if (!m || !m[1]) {
    hideDashMentionDropdown();
    return;
  }
  const query = m[1].toLowerCase();
  const dd = ensureDashMentionDropdown();
  if (!dd) return;

  loadDashContacts().then(list => {
    const hits = list.filter(c =>
      c.name.toLowerCase().includes(query) || c.number.includes(query)
    ).slice(0, 8);
    if (!hits.length) {
      dd.style.display = 'none';
      return;
    }
    dd.innerHTML = '';
    hits.forEach(c => {
      const item = document.createElement('div');
      item.className = 'dash-mention-item';
      const nm = document.createElement('span');
      nm.className = 'dash-mention-name';
      nm.textContent = c.name;
      const nu = document.createElement('span');
      nu.className = 'dash-mention-num';
      nu.textContent = '+' + c.number;
      item.appendChild(nm);
      item.appendChild(nu);
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        pickDashMention(input, c);
      });
      dd.appendChild(item);
    });
    dd.style.display = 'block';
  });
}

function pickDashMention(input, contact) {
  const pos = input.selectionStart != null ? input.selectionStart : input.value.length;
  const before = input.value.slice(0, pos);
  const after = input.value.slice(pos);
  const firstName = String(contact.name || contact.number).split(/\s+/)[0].replace(/[^\wÀ-ÿ]/g, '') || contact.number;
  const token = '@' + firstName;
  agentMentions[token.toLowerCase()] = contact.number;
  agentMentions[token.toLowerCase() + '_name'] = contact.name;
  const replaced = before.replace(/@[^\s@]{0,25}$/, token + ' ');
  input.value = replaced + after;
  input.focus();
  input.selectionStart = input.selectionEnd = replaced.length;
  hideDashMentionDropdown();
}

function collectDashMentions(text) {
  const out = [];
  const seen = {};
  const tokens = String(text).match(/@[^\s@,.;:!?()]{1,30}/g) || [];
  for (const tok of tokens) {
    const key = tok.toLowerCase();
    if (seen[key]) continue;
    seen[key] = true;
    let number = agentMentions[key] || null;
    let name = agentMentions[key + '_name'] || tok.slice(1);
    if (!number && agentContactsCache) {
      const q = tok.slice(1).toLowerCase();
      const hit = agentContactsCache.find(c =>
        c.name.toLowerCase().startsWith(q) || c.number.includes(q.replace(/\D/g, ''))
      );
      if (hit) { number = hit.number; name = hit.name; }
    }
    out.push({ token: tok, name, number });
  }
  return out;
}

// --------------------------- Dictado (voz) ---------------------------
function toggleDashDictation() {
  const btn = document.getElementById('dashChatMic');
  if (!btn) return;
  if (agentDictating && agentRecorder) {
    try { agentRecorder.stop(); } catch (_) {}
    return;
  }
  if (!navigator.mediaDevices || typeof MediaRecorder === 'undefined') {
    alert('Ditado indisponivel nesta versao do sistema.');
    return;
  }
  navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
    const rec = new MediaRecorder(stream);
    agentRecChunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) agentRecChunks.push(e.data); };
    rec.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      agentDictating = false;
      agentRecorder = null;
      btn.classList.remove('recording');
      btn.title = 'Ditar mensagem (voz)';
      const blob = new Blob(agentRecChunks, { type: (agentRecChunks[0] && agentRecChunks[0].type) || 'audio/webm' });
      if (blob.size < 400) return;
      btn.title = 'Transcrevendo...';
      try {
        const b64 = await blobToBase64(blob);
        const voiceZap = (zapsData.find(z => String(z.id) === String(autoMsgViewZap)) || zapsData[0] || {});
        const text = await window.electronAPI.autoMsgTranscribe(
          { data: b64, mimetype: blob.type, size: blob.size },
          voiceZap.id
        );
        const input = document.getElementById('dashChatInput');
        if (text && String(text).trim() && input) {
          input.value = (input.value ? input.value.replace(/\s+$/, '') + ' ' : '') + String(text).trim();
          autosizeDashInput(input);
          input.focus();
        } else {
          alert('Nao consegui transcrever o audio. Tente falar mais perto do microfone.');
        }
      } catch (e) {
        alert('Erro ao transcrever: ' + (e && e.message ? e.message : e));
      } finally {
        btn.title = 'Ditar mensagem (voz)';
      }
    };
    rec.start();
    agentRecorder = rec;
    agentDictating = true;
    btn.classList.add('recording');
    btn.title = 'Parar gravacao';
  }).catch(() => {
    alert('Nao consegui acessar o microfone.');
  });
}

// --------------------------- Arquivos ---------------------------
function attachDashFile() {
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.onchange = async () => {
    const f = picker.files && picker.files[0];
    if (!f) return;
    const input = document.getElementById('dashChatInput');
    if (!input) return;
    const isText = (f.type && f.type.startsWith('text/')) ||
      /\.(txt|md|csv|json|log|xml|html|css|js|ts|jsx|tsx|py|java|c|cpp|cs|php|yml|yaml|ini|cfg|sql)$/i.test(f.name);
    let note;
    if (isText && f.size <= 200 * 1024) {
      try {
        const content = await f.text();
        input.value = (input.value ? input.value.trim() + '\n\n' : '') +
          `[Arquivo: ${f.name}]\n` + content.slice(0, 15000);
        note = f.name + ' (conteudo anexado)';
      } catch (_) {
        input.value = (input.value ? input.value.trim() + '\n\n' : '') + `[Arquivo anexado: ${f.name}]`;
        note = f.name;
      }
    } else {
      input.value = (input.value ? input.value.trim() + '\n\n' : '') +
        `[Arquivo anexado: ${f.name} (${Math.max(1, Math.round(f.size / 1024))} KB) - conteudo nao lido]`;
      note = f.name;
    }
    autosizeDashInput(input);
    appendDashToolLine({ ok: true, tool: 'anexo', info: note });
    input.focus();
  };
  picker.click();
}

// ============================================
// Start App
// ============================================
document.addEventListener('DOMContentLoaded', () => {
  try { init(); } catch (e) { console.error('Erro no init:', e); }
  try { initWhatsApp(); } catch (e) { console.error('Erro no initWhatsApp:', e); }
  try { setupTrainingListeners(); } catch (e) { console.error('Erro em setupTrainingListeners:', e); }
});
