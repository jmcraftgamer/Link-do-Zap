// ============================================================
// Sincronizacao PC -> servidor (repo de dados do GitHub Actions)
// ------------------------------------------------------------
// O app local e o painel de controle: cada alteracao de configuracao
// (criar/editar/apagar zap, provedores, treinamentos) e copiada para o
// clone local do repo de dados e enviada (commit + push). O servidor
// baixa essas configs no monitor.sh e aplica ao vivo.
//
// Tambem le de volta (fetch) o bot-status.json / pairing-codes.json /
// qr-<id>.png publicados pelo servidor para mostrar o status real no
// painel.
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// Somente configs. Nunca enviamos sessions/, bot-status.json, conversations.json
// nem contacts.json: esses arquivos pertencem ao servidor (ou sao residuo local)
// e criariam conflito/loop no git.
const CONFIG_FILES = ['zaps.json', 'providers.json', 'trainings.json'];
const CONFIG_DIRS = ['trainings'];

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      cwd: opts.cwd,
      timeout: opts.timeout || 60000,
      maxBuffer: opts.maxBuffer || 32 * 1024 * 1024,
      encoding: opts.encoding || 'utf8',
      windowsHide: true,
      env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' }, opts.env || {})
    }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: stdout || '',
        stderr: stderr || (err && err.message ? err.message : '')
      });
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class ServerSync {
  constructor(opts = {}) {
    this.sourceDir = opts.sourceDir || '';
    this.dataDir = opts.dataDir || '';
    this.branch = opts.branch || 'main';
    this.enabled = !!(opts.enabled !== false && this.sourceDir && this.dataDir &&
      fs.existsSync(path.join(this.dataDir, '.git')));

    this._timer = null;
    this._chain = Promise.resolve();
    this._running = false;
    this._refreshing = false;

    this._status = {
      enabled: this.enabled,
      state: this.enabled ? 'idle' : 'disabled',
      lastSyncAt: null,
      lastError: null,
      lastCommit: null
    };

    this.botStatus = null;
    this.pairingCodes = {};
    this._lastCodes = {};
    this._lastQr = {};
    this._lastStatus = {};
    this._lastRemoteSha = null;

    this._onPairingCode = null;
    this._onQr = null;
    this._onStatus = null;
  }

  onPairingCode(fn) { this._onPairingCode = fn; }
  onQr(fn) { this._onQr = fn; }
  onStatus(fn) { this._onStatus = fn; }

  getStatus() {
    return Object.assign({ dataDir: this.dataDir }, this._status);
  }

  getBotStatus() {
    return this.botStatus;
  }

  getPairingCodes() {
    return this.pairingCodes;
  }

  // Status do zap segundo o servidor (bot-status.json)
  getZapStatus(zapId) {
    const id = String(zapId);
    const z = this.botStatus && Array.isArray(this.botStatus.zaps)
      ? this.botStatus.zaps.find((x) => String(x.id) === id)
      : null;
    if (!z) return null;
    return {
      status: z.status || 'disconnected',
      pairingCode: z.pairingCode || null,
      qrPending: !!z.qrPending,
      serverManaged: true
    };
  }

  _emitStatus() {
    try { if (this._onStatus) this._onStatus(this.getStatus()); } catch (_) {}
  }

  // Agenda um sync (coalesce alteracoes seguidas, ex.: toggle + save)
  scheduleSync(delay = 1500) {
    if (!this.enabled) return;
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      this.syncNow().catch(() => {});
    }, delay);
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
  }

  // Envia agora (serializado)
  syncNow() {
    if (!this.enabled) return Promise.resolve({ ok: false, disabled: true, error: 'sincronizacao desativada' });
    const runPromise = this._chain.then(() => this._doSync());
    this._chain = runPromise.catch(() => {});
    return runPromise;
  }

  async _doSync() {
    if (this._running) return { ok: true, busy: true };
    this._running = true;
    this._status.state = 'syncing';
    this._emitStatus();
    try {
      const copied = this._copyConfigs();
      const targets = this._existingTargets();
      if (targets.length) {
        await run('git', ['add', '-A', '--'].concat(targets), { cwd: this.dataDir });
      }
      const diff = await run('git', ['diff', '--cached', '--quiet'], { cwd: this.dataDir });
      const dirty = diff.code !== 0;
      if (!dirty && !copied.changed) {
        this._status.state = 'ok';
        this._status.lastSyncAt = Date.now();
        this._status.lastError = null;
        this._emitStatus();
        return { ok: true, unchanged: true, copied: 0 };
      }
      if (dirty) {
        const zaps = this._safeJson(path.join(this.dataDir, 'zaps.json'));
        const count = Array.isArray(zaps) ? zaps.length : '?';
        const msg = `app: configs ${new Date().toISOString()} | zaps=${count}`;
        const commit = await run('git', ['commit', '-m', msg], { cwd: this.dataDir });
        if (commit.code !== 0) {
          // Nada para commitar (corrida) - segue para o push
          console.warn('[SYNC] commit sem mudancas:', (commit.stderr || '').trim());
        } else {
          const sha = await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: this.dataDir });
          this._status.lastCommit = (sha.stdout || '').trim() || null;
        }
      }
      const pushed = await this._push();
      if (!pushed.ok) {
        this._status.state = 'error';
        this._status.lastError = pushed.error || 'push falhou';
        this._emitStatus();
        return { ok: false, error: this._status.lastError, copied: copied.changed };
      }
      this._status.state = 'ok';
      this._status.lastSyncAt = Date.now();
      this._status.lastError = null;
      this._emitStatus();
      return { ok: true, unchanged: false, copied: copied.changed, attempts: pushed.attempts, commit: this._status.lastCommit };
    } catch (e) {
      this._status.state = 'error';
      this._status.lastError = e && e.message ? e.message : String(e);
      this._emitStatus();
      return { ok: false, error: this._status.lastError };
    } finally {
      this._running = false;
    }
  }

  _safeJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
  }

  _existingTargets() {
    const out = [];
    for (const f of CONFIG_FILES) {
      if (fs.existsSync(path.join(this.dataDir, f))) out.push(f);
    }
    for (const d of CONFIG_DIRS) {
      if (fs.existsSync(path.join(this.dataDir, d))) out.push(d);
    }
    return out;
  }

  _copyConfigs() {
    let changed = 0;
    for (const f of CONFIG_FILES) {
      const src = path.join(this.sourceDir, f);
      if (!fs.existsSync(src)) continue;
      const dst = path.join(this.dataDir, f);
      try {
        const buf = fs.readFileSync(src);
        const same = fs.existsSync(dst) && buf.equals(fs.readFileSync(dst));
        if (!same) {
          fs.writeFileSync(dst, buf);
          changed++;
        }
      } catch (e) {
        console.warn(`[SYNC] falha ao copiar ${f}: ${e.message}`);
      }
    }
    for (const d of CONFIG_DIRS) {
      const src = path.join(this.sourceDir, d);
      if (fs.existsSync(src)) changed += this._mirrorDir(src, path.join(this.dataDir, d));
    }
    return { changed };
  }

  _mirrorDir(src, dst) {
    let changed = 0;
    try {
      fs.mkdirSync(dst, { recursive: true });
      const srcFiles = new Set();
      const walk = (dir, rel) => {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          const r = path.join(rel, ent.name);
          if (ent.isDirectory()) walk(path.join(dir, ent.name), r);
          else srcFiles.add(r);
        }
      };
      walk(src, '');
      for (const rel of srcFiles) {
        const from = path.join(src, rel);
        const to = path.join(dst, rel);
        try {
          const buf = fs.readFileSync(from);
          const same = fs.existsSync(to) && buf.equals(fs.readFileSync(to));
          if (!same) {
            fs.mkdirSync(path.dirname(to), { recursive: true });
            fs.writeFileSync(to, buf);
            changed++;
          }
        } catch (_) {}
      }
      // Remove arquivos que nao existem mais na origem
      const walkDel = (dir, rel) => {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          const r = path.join(rel, ent.name);
          const abs = path.join(dir, ent.name);
          if (ent.isDirectory()) walkDel(abs, r);
          else if (!srcFiles.has(r)) {
            try { fs.unlinkSync(abs); changed++; } catch (_) {}
          }
        }
      };
      walkDel(dst, '');
    } catch (_) {}
    return changed;
  }

  async _push() {
    let lastErr = '';
    for (let i = 1; i <= 5; i++) {
      const r = await run('git', ['push', 'origin', `HEAD:${this.branch}`], { cwd: this.dataDir, timeout: 90000 });
      if (r.code === 0) return { ok: true, attempts: i };
      lastErr = (r.stderr || '').trim() || 'push rejeitado';
      const authErr = /authentication|could not read username|permission|denied/i.test(lastErr);
      if (authErr) return { ok: false, error: lastErr };
      await run('git', ['pull', '--rebase', '--autostash', 'origin', this.branch], { cwd: this.dataDir, timeout: 90000 });
      await sleep(1500);
    }
    return { ok: false, error: lastErr };
  }

  // Remove a sessao de um zap apagado (no repo de dados e no PC)
  async deleteZapSession(zapId) {
    if (!this.enabled) return { ok: false, disabled: true };
    const id = String(zapId);
    let removed = 0;
    const targets = [
      path.join(this.dataDir, 'sessions', id),
      path.join(this.dataDir, 'sessions', `${id}.cache-keep`),
      path.join(this.dataDir, 'trainings', id),
      path.join(this.sourceDir, 'sessions', id),
      path.join(this.sourceDir, 'sessions', `${id}.cache-keep`),
      path.join(this.sourceDir, 'trainings', id)
    ];
    for (const t of targets) {
      if (!fs.existsSync(t)) continue;
      try {
        fs.rmSync(t, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        if (t.indexOf(this.dataDir) === 0) removed++;
      } catch (e) {
        console.warn(`[SYNC] falha ao remover ${t}: ${e.message}`);
      }
    }
    const doCommit = async () => {
      const dirs = ['sessions', 'trainings'].filter((d) => fs.existsSync(path.join(this.dataDir, d)));
      if (dirs.length) await run('git', ['add', '-A', '--'].concat(dirs), { cwd: this.dataDir });
      const diff = await run('git', ['diff', '--cached', '--quiet'], { cwd: this.dataDir });
      if (diff.code === 0) return { ok: true, unchanged: true };
      await run('git', ['commit', '-m', `app: remove zap ${id}`], { cwd: this.dataDir });
      const pushed = await this._push();
      return { ok: pushed.ok, error: pushed.error };
    };
    const p = this._chain.then(doCommit);
    this._chain = p.catch(() => {});
    const res = await p;
    return Object.assign({ removed, zapId: id }, res);
  }

  // Le do servidor: bot-status.json, pairing-codes.json e QR
  async refreshStatus() {
    // Nao roda junto com um sync (evita git concorrente) nem empilha refreshes.
    if (!this.enabled || this._refreshing || this._running) return this.botStatus;
    this._refreshing = true;
    try {
      await run('git', ['fetch', '--quiet', 'origin', this.branch], { cwd: this.dataDir, timeout: 30000 });
      // Se o servidor nao publicou nada novo, nao gasta mais dois `git show`.
      const head = await run('git', ['rev-parse', `origin/${this.branch}`], { cwd: this.dataDir, timeout: 15000 });
      const remoteSha = (head.stdout || '').trim();
      if (remoteSha && remoteSha === this._lastRemoteSha && this.botStatus) {
        return this.botStatus;
      }
      const bs = await this._showJson('bot-status.json');
      if (bs) this.botStatus = bs;
      const pc = await this._showJson('pairing-codes.json');
      if (pc) this.pairingCodes = pc;
      this._lastRemoteSha = remoteSha || null;
      await this._emitChanges();
    } catch (e) {
      if (process.env.LINK_SYNC_DEBUG === '1') console.warn('[SYNC] refreshStatus:', e.message);
    } finally {
      this._refreshing = false;
    }
    return this.botStatus;
  }

  async _showJson(file) {
    const r = await run('git', ['show', `origin/${this.branch}:${file}`], { cwd: this.dataDir, timeout: 20000 });
    if (r.code !== 0 || !r.stdout) return null;
    try { return JSON.parse(r.stdout); } catch (_) { return null; }
  }

  async _showPngDataUrl(file) {
    const r = await run('git', ['show', `origin/${this.branch}:${file}`], {
      cwd: this.dataDir,
      timeout: 20000,
      encoding: 'buffer',
      maxBuffer: 8 * 1024 * 1024
    });
    if (r.code !== 0 || !r.stdout || !r.stdout.length) return null;
    try {
      return 'data:image/png;base64,' + Buffer.from(r.stdout).toString('base64');
    } catch (_) { return null; }
  }

  async _emitChanges() {
    // Codigos de pareamento novos/alterados
    try {
      const codes = this.pairingCodes || {};
      for (const id of Object.keys(codes)) {
        const code = codes[id] && codes[id].code ? String(codes[id].code) : '';
        if (!code) continue;
        if (this._lastCodes[id] !== code) {
          this._lastCodes[id] = code;
          if (this._onPairingCode) this._onPairingCode({ zapId: id, code });
        }
      }
    } catch (_) {}

    // QR do servidor (somente enquanto pendente)
    try {
      const zaps = this.botStatus && Array.isArray(this.botStatus.zaps) ? this.botStatus.zaps : [];
      for (const z of zaps) {
        const id = String(z.id);
        if (!z.qrPending) continue;
        const dataUrl = await this._showPngDataUrl(`qr-${id}.png`);
        if (!dataUrl) continue;
        if (this._lastQr[id] !== dataUrl) {
          this._lastQr[id] = dataUrl;
          if (this._onQr) this._onQr({ zapId: id, dataUrl });
        }
      }
    } catch (_) {}

    // Mudancas de status
    try {
      const zaps = this.botStatus && Array.isArray(this.botStatus.zaps) ? this.botStatus.zaps : [];
      for (const z of zaps) {
        const id = String(z.id);
        const status = z.status || 'disconnected';
        if (this._lastStatus[id] !== status) {
          this._lastStatus[id] = status;
          if (this._onStatus) this._onStatus({ zapId: id, status });
        }
      }
    } catch (_) {}
  }
}

module.exports = ServerSync;
