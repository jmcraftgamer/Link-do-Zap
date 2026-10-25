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
const os = require('os');
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
    this.remoteStop = false;
    this._lastCodes = {};
    this._lastQr = {};
    this._lastStatus = {};
    this._lastRemoteSha = null;

    this._onPairingCode = null;
    this._onQr = null;
    this._onStatus = null;
    this._onLog = null;
    this._seenLogIds = new Set();
  }

  onPairingCode(fn) { this._onPairingCode = fn; }
  onQr(fn) { this._onQr = fn; }
  onStatus(fn) { this._onStatus = fn; }
  onLog(fn) { this._onLog = fn; }

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

  // Liga/desliga o bot 24h criando/removendo o arquivo STOP no repo de dados.
  // O workflow do GitHub Actions checa esse arquivo e para a execucao.
  //
  // O commit e montado direto sobre origin/<branch> com um index temporario.
  // Assim nao mexemos nas sessoes nem no historico local (que costuma estar
  // atrasado e cheio de binarios) e o botao funciona mesmo se o clone local
  // estiver no meio de um rebase.
  setServerRunning(running) {
    if (!this.enabled) return Promise.resolve({ ok: false, disabled: true, error: 'sincronizacao desativada' });
    const want = !!running;
    const doIt = async () => {
      const result = await this._pushStopState(want);
      if (result.ok) {
        // Nao mexe no working tree se o clone estiver no meio de um rebase:
        // o estado real vem de remoteStop/origin, nao do arquivo local.
        const rebasing = fs.existsSync(path.join(this.dataDir, '.git', 'rebase-merge')) ||
          fs.existsSync(path.join(this.dataDir, '.git', 'rebase-apply'));
        if (!rebasing) {
          const stopPath = path.join(this.dataDir, 'STOP');
          try {
            if (want) {
              if (fs.existsSync(stopPath)) fs.rmSync(stopPath, { force: true });
            } else {
              fs.writeFileSync(stopPath, `desligado pelo painel em ${new Date().toISOString()}\n`);
            }
          } catch (_) {}
        }
        this.remoteStop = !want;
        this._lastRemoteSha = null;
      }
      return result;
    };
    const p = this._chain.then(doIt);
    this._chain = p.catch(() => {});
    return p;
  }

  async _pushStopState(want) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zap-stop-'));
    const indexFile = path.join(tmpDir, 'index');
    const env = { GIT_INDEX_FILE: indexFile };
    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const fetch = await run('git', ['fetch', '--quiet', 'origin', this.branch], { cwd: this.dataDir, timeout: 30000 });
        if (fetch.code !== 0) {
          return { ok: false, error: (fetch.stderr || 'sem conexao com o repositorio de dados').trim() };
        }
        const remoteRef = `origin/${this.branch}`;
        const head = await run('git', ['rev-parse', remoteRef], { cwd: this.dataDir, timeout: 15000 });
        const headSha = (head.stdout || '').trim();
        if (head.code !== 0 || !headSha) {
          return { ok: false, error: (head.stderr || 'nao foi possivel ler o branch remoto').trim() };
        }
        const hasStop = (await run('git', ['cat-file', '-e', `${remoteRef}:STOP`], {
          cwd: this.dataDir, timeout: 15000
        })).code === 0;
        if (hasStop === !want) {
          return { ok: true, unchanged: true, running: want, attempts: attempt };
        }

        let r = await run('git', ['read-tree', remoteRef], { cwd: this.dataDir, timeout: 30000, env });
        if (r.code !== 0) return { ok: false, error: (r.stderr || 'read-tree falhou').trim() };

        if (want) {
          r = await run('git', ['update-index', '--force-remove', 'STOP'], {
            cwd: this.dataDir, timeout: 15000, env
          });
        } else {
          const stopTmp = path.join(tmpDir, 'STOP');
          fs.writeFileSync(stopTmp, `desligado pelo painel em ${new Date().toISOString()}\n`);
          const blob = await run('git', ['hash-object', '-w', stopTmp], { cwd: this.dataDir, timeout: 15000 });
          const blobSha = (blob.stdout || '').trim();
          if (blob.code !== 0 || !blobSha) {
            return { ok: false, error: (blob.stderr || 'nao foi possivel criar o arquivo STOP').trim() };
          }
          r = await run('git', ['update-index', '--add', '--cacheinfo', `100644,${blobSha},STOP`], {
            cwd: this.dataDir, timeout: 15000, env
          });
        }
        if (r.code !== 0) return { ok: false, error: (r.stderr || 'update-index falhou').trim() };

        const tree = await run('git', ['write-tree'], { cwd: this.dataDir, timeout: 30000, env });
        const treeSha = (tree.stdout || '').trim();
        if (tree.code !== 0 || !treeSha) {
          return { ok: false, error: (tree.stderr || 'write-tree falhou').trim() };
        }

        const msg = want ? 'app: liga servidor' : 'app: desliga servidor';
        const commit = await run('git', [
          '-c', 'user.name=Link no WhatsApp',
          '-c', 'user.email=link@localhost',
          'commit-tree', treeSha, '-p', headSha, '-m', msg
        ], { cwd: this.dataDir, timeout: 30000 });
        const commitSha = (commit.stdout || '').trim();
        if (commit.code !== 0 || !commitSha) {
          return { ok: false, error: (commit.stderr || 'commit-tree falhou').trim() };
        }

        const push = await run('git', ['push', 'origin', `${commitSha}:${this.branch}`], {
          cwd: this.dataDir, timeout: 90000
        });
        if (push.code === 0) {
          await run('git', ['fetch', '--quiet', 'origin', this.branch], { cwd: this.dataDir, timeout: 30000 });
          return { ok: true, unchanged: false, running: want, attempts: attempt };
        }
        const err = (push.stderr || '').trim() || 'push rejeitado';
        if (/authentication|could not read username|permission|denied/i.test(err)) {
          return { ok: false, error: err };
        }
      }
      return { ok: false, error: 'push do STOP falhou apos varias tentativas' };
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
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

  // Sincroniza SOMENTE as configuracoes (zaps/providers/trainings), montando
  // um commit diretamente sobre origin/<branch> num index temporario.
  //
  // Por que nao `git add` + `pull --rebase` no working tree: o servidor 24h
  // faz backup a cada 60s (commits de bot-status, sessoes, conversas). O clone
  // local fica sempre atras e o rebase entra em conflito nesses arquivos,
  // travando o repo no meio de um rebase (era o que acontecia em data/).
  // Com o index temporario o working tree local nunca e tocado e o commit de
  // configs sempre tem como pai o estado atual do servidor.
  async _doSync() {
    if (this._running) return { ok: true, busy: true };
    this._running = true;
    this._status.state = 'syncing';
    this._emitStatus();
    try {
      const result = await this._commitConfigsOnOrigin();
      if (!result.ok) {
        this._status.state = 'error';
        this._status.lastError = result.error || 'push falhou';
        this._emitStatus();
        return { ok: false, error: this._status.lastError };
      }
      this._status.state = 'ok';
      this._status.lastSyncAt = Date.now();
      this._status.lastError = null;
      if (result.commit) this._status.lastCommit = result.commit;
      this._lastRemoteSha = null;
      this._emitStatus();
      return {
        ok: true,
        unchanged: !!result.unchanged,
        copied: result.changed,
        attempts: result.attempts,
        commit: result.commit
      };
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

  // Lista de arquivos de configuracao que existem no disco local (caminhos
  // relativos com "/" - formato do git).
  _configFileList() {
    const files = [];
    for (const f of CONFIG_FILES) {
      const src = path.join(this.sourceDir, f);
      if (fs.existsSync(src)) files.push(f);
    }
    for (const d of CONFIG_DIRS) {
      const root = path.join(this.sourceDir, d);
      if (!fs.existsSync(root)) continue;
      const walk = (dir, rel) => {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          const r = rel ? `${rel}/${ent.name}` : ent.name;
          if (ent.isDirectory()) walk(path.join(dir, ent.name), r);
          else files.push(`${d}/${r}`);
        }
      };
      walk(root, '');
    }
    return files;
  }

  async _commitConfigsOnOrigin() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zap-cfg-'));
    const indexFile = path.join(tmpDir, 'index');
    const env = { GIT_INDEX_FILE: indexFile };
    let lastErr = '';
    try {
      for (let attempt = 1; attempt <= 4; attempt++) {
        const fetch = await run('git', ['fetch', '--quiet', 'origin', this.branch], {
          cwd: this.dataDir, timeout: 30000
        });
        if (fetch.code !== 0) {
          return { ok: false, error: (fetch.stderr || 'sem conexao com o repositorio de dados').trim() };
        }
        const remoteRef = `origin/${this.branch}`;
        const head = await run('git', ['rev-parse', remoteRef], { cwd: this.dataDir, timeout: 15000 });
        const headSha = (head.stdout || '').trim();
        if (head.code !== 0 || !headSha) {
          return { ok: false, error: (head.stderr || 'nao foi possivel ler o branch remoto').trim() };
        }

        let r = await run('git', ['read-tree', remoteRef], { cwd: this.dataDir, timeout: 30000, env });
        if (r.code !== 0) return { ok: false, error: (r.stderr || 'read-tree falhou').trim() };

        // Hashes dos arquivos no estado remoto (para pular os inalterados).
        const remoteHashes = new Map();
        for (const rel of this._configFileList()) {
          const shown = await run('git', ['rev-parse', `${remoteRef}:${rel}`], {
            cwd: this.dataDir, timeout: 15000
          });
          remoteHashes.set(rel, shown.code === 0 ? (shown.stdout || '').trim() : '');
        }

        let changed = 0;
        for (const rel of this._configFileList()) {
          const src = path.join(this.sourceDir, rel.split('/').join(path.sep));
          const blob = await run('git', ['hash-object', '-w', src], { cwd: this.dataDir, timeout: 20000 });
          const blobSha = (blob.stdout || '').trim();
          if (blob.code !== 0 || !blobSha) {
            return { ok: false, error: (blob.stderr || `falha ao ler ${rel}`).trim() };
          }
          if (remoteHashes.get(rel) === blobSha) continue;
          r = await run('git', [
            'update-index', '--add', '--cacheinfo', `100644,${blobSha},${rel}`
          ], { cwd: this.dataDir, timeout: 15000, env });
          if (r.code !== 0) return { ok: false, error: (r.stderr || `update-index ${rel} falhou`).trim() };
          changed++;
        }

        // Arquivos de treinamento removidos no painel precisam sair do servidor.
        // So mexe nisso quando a pasta trainings existe no PC: se ela nao
        // existe (instalacao nova), nao pode apagar os treinos do servidor.
        const localSet = new Set(this._configFileList());
        const hasLocalDir = (d) => fs.existsSync(path.join(this.sourceDir, d));
        const dirsToReconcile = CONFIG_DIRS.filter(hasLocalDir);
        if (dirsToReconcile.length) {
          const remoteTrainings = await run('git', [
            'ls-tree', '-r', '--name-only', remoteRef, '--'
          ].concat(dirsToReconcile), { cwd: this.dataDir, timeout: 20000 });
          if (remoteTrainings.code === 0) {
            for (const rel of (remoteTrainings.stdout || '').split(/\r?\n/)) {
              if (!rel || localSet.has(rel)) continue;
              r = await run('git', ['update-index', '--force-remove', rel], {
                cwd: this.dataDir, timeout: 15000, env
              });
              if (r.code === 0) changed++;
            }
          }
        }

        if (!changed) {
          return { ok: true, unchanged: true, changed: 0, attempts: attempt };
        }

        const tree = await run('git', ['write-tree'], { cwd: this.dataDir, timeout: 30000, env });
        const treeSha = (tree.stdout || '').trim();
        if (tree.code !== 0 || !treeSha) {
          return { ok: false, error: (tree.stderr || 'write-tree falhou').trim() };
        }

        const zaps = this._safeJson(path.join(this.dataDir, 'zaps.json')) ||
          this._safeJson(path.join(this.sourceDir, 'zaps.json'));
        const count = Array.isArray(zaps) ? zaps.length : '?';
        const msg = `app: configs ${new Date().toISOString()} | zaps=${count}`;
        const commit = await run('git', [
          '-c', 'user.name=Link no WhatsApp',
          '-c', 'user.email=link@localhost',
          'commit-tree', treeSha, '-p', headSha, '-m', msg
        ], { cwd: this.dataDir, timeout: 30000 });
        const commitSha = (commit.stdout || '').trim();
        if (commit.code !== 0 || !commitSha) {
          return { ok: false, error: (commit.stderr || 'commit-tree falhou').trim() };
        }

        const push = await run('git', ['push', 'origin', `${commitSha}:${this.branch}`], {
          cwd: this.dataDir, timeout: 90000
        });
        if (push.code === 0) {
          await run('git', ['fetch', '--quiet', 'origin', this.branch], {
            cwd: this.dataDir, timeout: 30000
          });
          return {
            ok: true, unchanged: false, changed, attempts: attempt,
            commit: commitSha.slice(0, 7)
          };
        }
        lastErr = (push.stderr || '').trim() || 'push rejeitado';
        if (/authentication|could not read username|permission|denied/i.test(lastErr)) {
          return { ok: false, error: lastErr };
        }
        await sleep(1200);
      }
      return { ok: false, error: lastErr || 'push de configs falhou apos varias tentativas' };
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  // Remove a sessao de um zap apagado do PC. No servidor quem apaga e o
  // reconciler (main.js), assim que o zaps.json sem esse zap chega pelo sync -
  // fazer isso por git aqui exigia mexer no working tree e travava o repo.
  async deleteZapSession(zapId) {
    if (!this.enabled) return { ok: false, disabled: true };
    const id = String(zapId);
    let removed = 0;
    const targets = [
      path.join(this.sourceDir, 'sessions', id),
      path.join(this.sourceDir, 'sessions', `${id}.cache-keep`),
      path.join(this.sourceDir, 'trainings', id)
    ];
    for (const t of targets) {
      if (!fs.existsSync(t)) continue;
      try {
        fs.rmSync(t, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        removed++;
      } catch (e) {
        console.warn(`[SYNC] falha ao remover ${t}: ${e.message}`);
      }
    }
    return { ok: true, removed, zapId: id, serverWillClean: true };
  }

  // Le do servidor: bot-status.json, pairing-codes.json e QR
  async refreshStatus() {
    // Nao roda junto com um sync (evita git concorrente) nem empilha refreshes.
    if (!this.enabled || this._refreshing || this._running) return this.botStatus;
    this._refreshing = true;
    try {
      const fetch = await run('git', ['fetch', '--quiet', 'origin', this.branch], { cwd: this.dataDir, timeout: 30000 });
      if (fetch.code !== 0) {
        this._status.lastError = (fetch.stderr || 'sem conexao com o repositorio de dados').trim();
        if (process.env.LINK_SYNC_DEBUG === '1') console.warn('[SYNC] fetch:', this._status.lastError);
        return this.botStatus;
      }
      this._status.lastError = null;
      const stopCheck = await run('git', ['cat-file', '-e', `origin/${this.branch}:STOP`], { cwd: this.dataDir, timeout: 15000 });
      this.remoteStop = stopCheck.code === 0;
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
      await this._syncRemoteTerminalLog();
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

  // Le o terminal publicado pelo servidor 24h (server-terminal.jsonl) e
  // repassa apenas as linhas novas para o painel local.
  async _syncRemoteTerminalLog() {
    const r = await run('git', ['show', `origin/${this.branch}:server-terminal.jsonl`], {
      cwd: this.dataDir,
      timeout: 30000,
      maxBuffer: 48 * 1024 * 1024
    });
    if (r.code !== 0 || !r.stdout) return;

    let cutoff = 0;
    try {
      const p = this.sourceDir ? path.join(this.sourceDir, 'server-terminal-clear.at') : '';
      if (p && fs.existsSync(p)) {
        const parsed = Date.parse(String(fs.readFileSync(p, 'utf8')).trim());
        if (Number.isFinite(parsed)) cutoff = parsed;
      }
    } catch (_) {}

    const lines = r.stdout.split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      let entry = null;
      try { entry = JSON.parse(line); } catch (_) { continue; }
      if (!entry || !entry.msg) continue;
      const key = `${entry.ts || ''}|${entry.level || ''}|${entry.source || ''}|${entry.msg}`;
      if (this._seenLogIds.has(key)) continue;
      if (cutoff && entry.ts) {
        const ts = Date.parse(entry.ts);
        if (Number.isFinite(ts) && ts <= cutoff) {
          this._seenLogIds.add(key);
          continue;
        }
      }
      this._seenLogIds.add(key);
      if (this._seenLogIds.size > 50000) {
        const first = this._seenLogIds.values().next().value;
        if (first) this._seenLogIds.delete(first);
      }
      if (this._onLog) {
        try { this._onLog(entry); } catch (_) {}
      }
    }
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

  // QR atual publicado pelo servidor (usado ao abrir a tela de conexao)
  async getQrDataUrl(zapId) {
    if (!this.enabled) return null;
    return this._showPngDataUrl(`qr-${String(zapId)}.png`);
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
