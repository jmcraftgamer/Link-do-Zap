const http = require('http');
const { URL } = require('url');

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let overflow = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > 16384) { overflow = true; return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (overflow) return resolve({ __tooLarge: true });
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (_) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function statusPill(status) {
  const colors = {
    ready: '#16a34a',
    connecting: '#f59e0b',
    authenticated: '#16a34a',
    initializing: '#f59e0b',
    auth_failure: '#dc2626',
    pairing_error: '#dc2626',
    disconnected: '#6b7280'
  };
  const bg = colors[status] || '#6b7280';
  return `<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:${bg};color:#fff;font-size:12px">${escapeHtml(status || 'desconhecido')}</span>`;
}

function renderPage(state, logs, opts) {
  const token = opts.token || '';
  const tokenQs = token ? `&token=${encodeURIComponent(token)}` : '';
  const postQs = token ? `?token=${encodeURIComponent(token)}` : '';
  const actionJs = `async function acao(metodo, zap) {
  const r = await fetch('/' + metodo + ${JSON.stringify(postQs)}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ zap: zap, method: 'qrcode' }) });
  const j = await r.json().catch(function () { return {}; });
  if (!r.ok) { alert(j.error || ('erro ' + r.status)); } else { location.reload(); }
}`;
  const rows = (state.zaps || []).map(z => {
    const qr = z.qrPending
      ? `<img src="/qr?zap=${encodeURIComponent(z.id)}${tokenQs}" alt="QR do zap ${escapeHtml(z.name)}" style="width:180px;height:180px;background:#fff;padding:4px;border:1px solid #e5e7eb;border-radius:8px;margin-top:6px">`
      : '';
    const zapJs = JSON.stringify(String(z.id));
    const actions = z.status === 'ready'
      ? `<button onclick="acao('disconnect',${zapJs})">Desconectar</button>`
      : `<button onclick="acao('connect',${zapJs})">Conectar (QR)</button>`;
    return `<tr>
      <td>${escapeHtml(z.name || z.id)}</td>
      <td>${statusPill(z.status)}</td>
      <td>${z.enabled === false ? 'desligado' : 'ligado'} / auto: ${z.autoReply ? 'sim' : 'nao'}</td>
      <td>${z.qrPending ? 'QR disponivel - escaneie pelo celular' : (z.status === 'ready' ? 'conectado' : 'desconectado')}${qr}</td>
      <td>${actions}</td>
    </tr>`;
  }).join('\n');

  const logText = escapeHtml((logs || []).slice(-80).join('\n') || '(sem logs ainda)');
  const zapsCount = (state.zaps || []).length;

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>Assistente do Zap - Status</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#f3f4f6;color:#111827}
.wrap{max-width:1000px;margin:0 auto;padding:24px}
h1{font-size:22px;margin:0 0 4px}
h2{font-size:16px;margin:24px 0 8px}
.meta{color:#6b7280;font-size:13px;margin:0}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin-top:12px}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:8px;border-bottom:1px solid #f3f4f6;vertical-align:top}
th{color:#6b7280;font-weight:600;font-size:12px;text-transform:uppercase}
button{background:#2563eb;color:#fff;border:0;border-radius:6px;padding:6px 10px;font-size:13px;cursor:pointer}
button:hover{background:#1d4ed8}
pre{background:#0b1220;color:#d1d5db;padding:12px;border-radius:8px;font-size:12px;overflow-x:auto;white-space:pre-wrap;word-break:break-word;max-height:420px;overflow-y:auto}
.empty{color:#6b7280;font-size:14px}
.hint{color:#6b7280;font-size:12px;margin-top:8px}
</style>
</head>
<body>
<div class="wrap">
<h1>Assistente do Zap</h1>
<p class="meta">Atualiza a cada 5s &middot; uptime ${escapeHtml(String(state.uptime || 0))}s &middot; plataforma ${escapeHtml(state.platform || '?')} &middot; modo ${state.headless ? 'headless (servidor)' : 'com janela'}</p>
<p class="meta">Pasta de dados: <code>${escapeHtml(state.dataDir || '?')}</code></p>
<div class="card">
<h2 style="margin-top:0">Zaps (${zapsCount})</h2>
${zapsCount ? `<table><thead><tr><th>Zap</th><th>Status</th><th>Ligado</th><th>Conexao</th><th>Acao</th></tr></thead><tbody>${rows}</tbody></table>
<p class="hint">Ao clicar em Conectar o QR aparece aqui em ate 30s - escaneie com o celular. Depois de logado a sessao fica salva e o app reconecta sozinho ao reiniciar.</p>`
  : '<p class="empty">Nenhum zap configurado ainda. Configure no app do Windows e copie os arquivos zaps.json / providers.json / trainings.json para a pasta de dados do servidor.</p>'}
</div>
<div class="card">
<h2 style="margin-top:0">Logs recentes (ultimas 80 linhas)</h2>
<pre>${logText}</pre>
</div>
</div>
<script>${actionJs}</script>
</body>
</html>`;
}

function createStatusServer(options) {
  const opts = options || {};
  const token = String(opts.token || '');
  const getState = opts.getState || (() => ({ ok: true }));
  const getQr = opts.getQr || (() => null);
  const getLogs = opts.getLogs || (() => []);

  return http.createServer((req, res) => {
    (async () => {
      const url = new URL(req.url || '/', 'http://local');
      const path = url.pathname;
      const isAction = path === '/connect' || path === '/disconnect';

      if (isAction) {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('405 - use POST');
        }
      } else if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('405');
      }

      if (token) {
        const q = url.searchParams.get('token');
        const auth = String(req.headers['authorization'] || '');
        const hdr = String(req.headers['x-token'] || '');
        if (q !== token && hdr !== token && auth !== `Bearer ${token}`) {
          res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('401 - token invalido (use ?token=SEU_TOKEN)');
        }
      }

      if (isAction) {
        const body = await readJsonBody(req);
        if (body.__tooLarge) {
          res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ ok: false, error: 'corpo muito grande' }));
        }
        const zapId = String(body.zap || '');
        if (!zapId) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ ok: false, error: 'campo "zap" obrigatorio' }));
        }
        const handler = path === '/connect' ? opts.onConnect : opts.onDisconnect;
        if (typeof handler !== 'function') {
          res.writeHead(501, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ ok: false, error: 'endpoint nao configurado' }));
        }
        let result;
        try {
          result = await handler(zapId, { method: body.method === 'pairing' ? 'pairing' : 'qrcode', phone: String(body.phone || '') });
        } catch (e) {
          result = { status: 500, ok: false, error: e && e.message ? e.message : 'erro interno' };
        }
        const st = (result && result.status) || 200;
        const payload = result && typeof result === 'object' ? Object.assign({ ok: st < 400 }, result) : { ok: st < 400 };
        res.writeHead(st, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify(payload));
      }

      if (path === '/status') {
        let state = { ok: true };
        try { state = Object.assign({ ok: true }, await getState()); } catch (e) { state = { ok: false, error: e.message }; }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify(state));
      }

      if (path === '/logs') {
        const n = Math.max(1, Math.min(1000, Number(url.searchParams.get('n')) || 200));
        let lines = [];
        try { lines = (await getLogs()) || []; } catch (e) { lines = [`erro ao ler logs: ${e.message}`]; }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify({ count: lines.length, lines: lines.slice(-n) }));
      }

      if (path === '/qr') {
        const zapId = String(url.searchParams.get('zap') || '');
        if (!zapId) {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('400 - informe ?zap=ID');
        }
        const raw = await getQr(zapId);
        if (!raw) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('404 - QR indisponivel para este zap (conecte o zap primeiro)');
        }
        let QRCode = null;
        try { QRCode = require('qrcode'); } catch (_) { QRCode = null; }
        if (!QRCode || typeof QRCode.toBuffer !== 'function') {
          res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('503 - pacote qrcode indisponivel');
        }
        const buf = await QRCode.toBuffer(String(raw), { type: 'png', width: 320, margin: 2, errorCorrectionLevel: 'M' });
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        return res.end(buf);
      }

      if (path === '/') {
        let state = { ok: true };
        try { state = Object.assign({ ok: true }, await getState()); } catch (e) { state = { ok: false, error: e.message }; }
        let logs = [];
        try { logs = (await getLogs()) || []; } catch (_) { logs = []; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(renderPage(state, logs, { token }));
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404');
    })().catch((e) => {
      try {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`500 - ${e && e.message ? e.message : 'erro interno'}`);
      } catch (_) { /* resposta ja enviada */ }
    });
  });
}

module.exports = { createStatusServer, renderPage, escapeHtml };
