// Tela "Conectar ao servidor" e bootstrap do painel.
// - Modo local: carrega app.js direto (nada muda).
// - Modo cliente remoto (LINK_API_URL): exige login na VPS antes de carregar
//   o app. Sem token valido, o painel nem inicializa (evita enxurrada de 401).
(function () {
  const api = window.electronAPI;
  const appScript = 'js/app.js';
  let started = false;
  let appLoaded = false;
  let pendingReload = false;

  function loadApp() {
    if (started) return;
    started = true;
    const script = document.createElement('script');
    script.src = appScript;
    document.body.appendChild(script);
  }

  function injectStyles() {
    if (document.getElementById('remoteGateStyles')) return;
    const style = document.createElement('style');
    style.id = 'remoteGateStyles';
    style.textContent = `
      #remoteGate {
        position: fixed; inset: 0; z-index: 99999;
        background: #ffffff; color: #111111;
        display: flex; align-items: center; justify-content: center;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }
      #remoteGate .gate-card {
        width: 100%; max-width: 420px; padding: 36px 32px;
        border: 1px solid #e4e4e4; border-radius: 16px;
        box-shadow: 0 18px 50px rgba(0,0,0,.08);
      }
      #remoteGate .gate-icon {
        width: 48px; height: 48px; border-radius: 12px;
        background: #111111; display: flex; align-items: center; justify-content: center;
        margin-bottom: 18px;
      }
      #remoteGate h1 { font-size: 20px; margin: 0 0 6px; }
      #remoteGate p.lead { font-size: 13px; color: #555555; margin: 0 0 22px; line-height: 1.5; }
      #remoteGate label { display: block; font-size: 12px; font-weight: 600; margin: 14px 0 6px; color: #555555; }
      #remoteGate input {
        width: 100%; box-sizing: border-box; height: 42px;
        border: 1.5px solid #e4e4e4; border-radius: 10px;
        padding: 0 12px; font-size: 14px; font-family: inherit; outline: none;
        background: #fff; color: #111;
      }
      #remoteGate input:focus { border-color: #111111; }
      #remoteGate button.gate-submit {
        width: 100%; height: 44px; margin-top: 22px; border: none; border-radius: 10px;
        background: #111111; color: #ffffff; font-size: 14px; font-weight: 600;
        font-family: inherit; cursor: pointer;
      }
      #remoteGate button.gate-submit:disabled { opacity: .55; cursor: wait; }
      #remoteGate .gate-status {
        margin-top: 14px; font-size: 12px; line-height: 1.45; min-height: 18px;
        color: #555555; word-break: break-word;
      }
      #remoteGate .gate-status.error { color: #b3261e; }
      #remoteGate .gate-status.success { color: #1a7f37; }
      #remoteGate .gate-hint { margin-top: 18px; font-size: 11px; color: #8a8a8a; line-height: 1.5; }
      #remoteGate .gate-server {
        display: flex; align-items: center; gap: 8px;
        margin: 0 0 6px; padding: 9px 12px;
        border: 1px solid #e9e9ea; border-radius: 10px;
        background: #fafafa; color: #111111;
        font-size: 12px; font-weight: 600;
      }
    `;
    document.head.appendChild(style);
  }

  function showGate(reason) {
    const existing = document.getElementById('remoteGate');
    if (existing) existing.remove();
    injectStyles();
    const gate = document.createElement('div');
    gate.id = 'remoteGate';
    gate.innerHTML = `
      <form class="gate-card" id="remoteGateForm" autocomplete="off">
        <div class="gate-icon">
          <svg viewBox="0 0 24 24" width="26" height="26" fill="#ffffff">
            <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347"/>
          </svg>
        </div>
        <h1>Conectar ao servidor</h1>
        <p class="lead">O bot roda na VPS. Entre com o endereco do servidor e a senha administrativa para gerenciar seus Zaps.</p>
        <div class="gate-server" id="gateServerLine" style="display:none"></div>
        <label for="gateUrl" id="gateUrlLabel">Endereco do servidor</label>
        <input id="gateUrl" name="url" type="text" spellcheck="false" placeholder="http://203.0.113.10:3000" />
        <label for="gatePassword">Senha administrativa</label>
        <input id="gatePassword" name="password" type="password" placeholder="Sua senha" />
        <button class="gate-submit" id="gateSubmit" type="submit">Entrar</button>
        <div class="gate-status" id="gateStatus"></div>
        <div class="gate-hint">A senha fica apenas nesta maquina. O trafego vai direto para o seu servidor.</div>
      </form>
    `;
    document.body.appendChild(gate);

    const form = gate.querySelector('#remoteGateForm');
    const urlInput = gate.querySelector('#gateUrl');
    const passInput = gate.querySelector('#gatePassword');
    const submit = gate.querySelector('#gateSubmit');
    const status = gate.querySelector('#gateStatus');

    urlInput.value = api.remoteAuth.getServerUrl() || '';

    // Servidor ja vem configurado no instalador: esconde o campo de endereco
    // e pede somente a senha. A URL continua no input (hidden) para o envio.
    const fixedUrl = String(api.remoteAuth.getServerUrl() || '').trim();
    if (fixedUrl) {
      const urlLabel = gate.querySelector('#gateUrlLabel');
      const serverLine = gate.querySelector('#gateServerLine');
      const lead = gate.querySelector('p.lead');
      if (urlLabel) urlLabel.style.display = 'none';
      urlInput.style.display = 'none';
      if (lead) lead.textContent = 'O bot roda na VPS. Entre com a senha administrativa para gerenciar seus Zaps.';
      if (serverLine) {
        serverLine.textContent = `Servidor: ${fixedUrl.replace(/^https?:\/\//, '')}`;
        serverLine.style.display = 'flex';
      }
    }

    if (reason) {
      status.textContent = reason;
      status.className = 'gate-status error';
    }
    setTimeout(() => (urlInput.value ? passInput : urlInput).focus(), 30);

    function setStatus(text, kind) {
      status.textContent = text || '';
      status.className = 'gate-status' + (kind ? ' ' + kind : '');
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const url = urlInput.value.trim();
      const password = passInput.value;
      if (!url) return setStatus('Informe o endereco do servidor.', 'error');
      if (!password) return setStatus('Informe a senha administrativa.', 'error');
      submit.disabled = true;
      try {
        if (url.replace(/\/+$/, '') !== api.remoteAuth.getServerUrl()) {
          api.remoteAuth.setServerUrl(url);
        }
        setStatus('Testando conexao...');
        await api.remoteAuth.health();
        setStatus('Entrando...');
        await api.remoteAuth.login(password);
        setStatus('Conectado. Abrindo o painel...', 'success');
        api.remoteAuth.connectEvents();
        gate.remove();
        if (pendingReload) {
          // O painel ja estava carregado com dados de uma sessao expirada.
          window.location.reload();
          return;
        }
        appLoaded = true;
        loadApp();
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        if (/401|senha/i.test(message)) setStatus('Senha incorreta.', 'error');
        else if (/ECONNREFUSED|ENOTFOUND|tempo esgotado|fetch failed/i.test(message)) {
          setStatus('Nao foi possivel falar com o servidor. Confira o IP, a porta e o firewall.', 'error');
        } else {
          setStatus(message, 'error');
        }
      } finally {
        submit.disabled = false;
      }
    });
  }

  if (!api || !api.isRemoteMode) {
    loadApp();
    return;
  }

  // Sessao expirada no meio do uso: volta ao gate em vez de deixar o painel
  // numa enxurrada de 401. O login seguinte recarrega a pagina para limpar o
  // estado antigo do app.
  if (typeof api.onAuthExpired === 'function') {
    try {
      api.onAuthExpired(() => {
        if (document.getElementById('remoteGate')) return;
        pendingReload = appLoaded;
        showGate('Sua sessao expirou. Entre novamente.');
      });
    } catch (_) {}
  }

  (async () => {
    // Modo remoto: valida o token salvo antes de abrir o painel. Assim uma
    // VPS recriada ou um JWT_SECRET trocado nao gera um app quebrado.
    if (api.remoteAuth && api.remoteAuth.hasToken()) {
      try {
        await api.remoteAuth.me();
        try { api.remoteAuth.connectEvents(); } catch (_) {}
        appLoaded = true;
        loadApp();
        return;
      } catch (err) {
        const status = err && err.status;
        if (status === 401 || status === 403) {
          api.remoteAuth.logout();
          showGate('Sua sessao expirou. Entre novamente.');
          return;
        }
        showGate('Nao foi possivel falar com o servidor. Confira o IP e se o servico esta no ar.');
        return;
      }
    }

    showGate();
  })();
})();
