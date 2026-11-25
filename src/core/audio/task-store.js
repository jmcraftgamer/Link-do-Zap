'use strict';

// Fila persistente de tarefas de audio.
//
// Cada audio recebido vira uma tarefa com estado, tentativas e resultado.
// O arquivo fica em data/audio-tasks.json e e reescrito de forma atomica.
// Uma reinicializacao do servidor nao apaga os audios pendentes: o proximo
// boot encontra as tarefas em andamento e decide entre retomar ou enviar para
// a fila de falhas definitivas (sem responder duas vezes ao cliente).

const fs = require('fs');
const path = require('path');

const TERMINAL = new Set(['COMPLETED', 'DEAD_LETTER']);
const ACTIVE = new Set([
  'RECEIVED', 'QUEUED', 'DOWNLOADING', 'VALIDATING',
  'TRANSCRIBING', 'TRANSCRIBED', 'AI_PROCESSING', 'RESPONDING', 'RETRYING'
]);
const STATES = [
  'RECEIVED', 'QUEUED', 'DOWNLOADING', 'VALIDATING', 'TRANSCRIBING',
  'TRANSCRIBED', 'AI_PROCESSING', 'RESPONDING', 'COMPLETED', 'RETRYING',
  'DEAD_LETTER'
];

function safeKey(zapId, msgId) {
  return `${String(zapId)}:${String(msgId)}`;
}

function safeErrorText(value) {
  return String(value == null ? '' : value)
    .replace(/https?:\/\/[^\s|]+/gi, '[url]')
    .slice(0, 500);
}

class AudioTaskStore {
  constructor(options = {}) {
    this.filePath = options.filePath;
    if (!this.filePath) throw new Error('AudioTaskStore: filePath obrigatorio');
    this.logger = options.logger || console;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.retentionMs = Number(options.retentionMs) || 72 * 60 * 60 * 1000;
    this.maxTasks = Number(options.maxTasks) || 3000;
    this.tasks = new Map();
    this.saveTimer = null;
    this.savePending = false;
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.tasks) ? raw.tasks : []);
      for (const t of list) {
        if (!t || !t.key) continue;
        this.tasks.set(String(t.key), this._normalize(t));
      }
      this.prune();
    } catch (e) {
      // Arquivo corrompido nao pode derrubar o bot. Tenta o backup e segue.
      try {
        const bak = this.filePath + '.bak';
        if (fs.existsSync(bak)) {
          const raw = JSON.parse(fs.readFileSync(bak, 'utf8'));
          const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.tasks) ? raw.tasks : []);
          for (const t of list) if (t && t.key) this.tasks.set(String(t.key), this._normalize(t));
          this.logger.error(`[AUDIO] audio-tasks.json corrompido; restaurado do backup (${e.message})`);
        }
      } catch (_) { /* sem backup valido */ }
    }
  }

  _normalize(t) {
    const now = this.now();
    return {
      key: String(t.key),
      zapId: String(t.zapId || ''),
      msgId: String(t.msgId || ''),
      msgKey: String(t.msgKey || ''),
      chatId: String(t.chatId || ''),
      chatName: String(t.chatName || ''),
      contactId: String(t.contactId || ''),
      contactName: String(t.contactName || ''),
      contactNumber: String(t.contactNumber || ''),
      type: String(t.type || ''),
      mimetype: String(t.mimetype || ''),
      ts: Number(t.ts) || 0,
      state: STATES.includes(t.state) ? t.state : 'QUEUED',
      downloadAttempts: Number(t.downloadAttempts) || 0,
      transcribeAttempts: Number(t.transcribeAttempts) || 0,
      method: String(t.method || ''),
      bytes: Number(t.bytes) || 0,
      mime: String(t.mime || ''),
      durationMs: Number(t.durationMs) || 0,
      sttMs: Number(t.sttMs) || 0,
      queueWaitMs: Number(t.queueWaitMs) || 0,
      deferCount: Number(t.deferCount) || 0,
      engine: String(t.engine || ''),
      model: String(t.model || ''),
      lang: String(t.lang || ''),
      sha256: String(t.sha256 || ''),
      errors: Array.isArray(t.errors) ? t.errors.slice(-20).map((e) => ({
        ...e,
        message: safeErrorText(e && e.message)
      })) : [],
      text: String(t.text || '').slice(0, 8000),
      lastError: safeErrorText(t.lastError),
      failureStage: String(t.failureStage || ''),
      responseReason: String(t.responseReason || '').slice(0, 200),
      notified: !!t.notified,
      createdAt: Number(t.createdAt) || now,
      updatedAt: Number(t.updatedAt) || now,
      completedAt: Number(t.completedAt) || 0
    };
  }

  _save() {
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      const payload = JSON.stringify({ version: 1, updatedAt: this.now(), tasks: [...this.tasks.values()] });
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, payload);
      try {
        if (fs.existsSync(this.filePath)) fs.copyFileSync(this.filePath, this.filePath + '.bak');
        fs.renameSync(tmp, this.filePath);
      } catch (_) {
        fs.writeFileSync(this.filePath, payload);
        try { fs.unlinkSync(tmp); } catch (_) {}
      }
    } catch (e) {
      this.logger.error(`[AUDIO] falha ao salvar audio-tasks.json: ${e.message}`);
    }
  }

  get(key) {
    return this.tasks.get(String(key)) || null;
  }

  // Escrita adiada para eventos de baixo valor (log de tentativas). Evita
  // reescrever o JSON inteiro a cada tentativa durante uma rajada de audios.
  _saveSoon(delayMs = 500) {
    this.savePending = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (!this.savePending) return;
      this.savePending = false;
      this._save();
    }, Math.max(50, Number(delayMs) || 500));
    if (typeof this.saveTimer.unref === 'function') this.saveTimer.unref();
  }

  key(zapId, msgId) {
    return safeKey(zapId, msgId);
  }

  // Cria ou recupera a tarefa. `duplicate` indica entrega repetida do mesmo
  // evento do WhatsApp; quem chama deve pular a IA para nao responder 2x.
  begin(meta = {}) {
    const zapId = String(meta.zapId || '');
    const msgId = String(meta.msgId || '');
    if (!zapId || !msgId) throw new Error('AudioTaskStore.begin: zapId/msgId obrigatorios');
    const key = safeKey(zapId, msgId);
    const existing = this.tasks.get(key);
    if (existing) {
      return { task: existing, duplicate: true, terminal: TERMINAL.has(existing.state) };
    }
    const now = this.now();
    const task = this._normalize({
      key, zapId, msgId,
      msgKey: meta.msgKey || '',
      chatId: meta.chatId || '',
      chatName: meta.chatName || '',
      contactId: meta.contactId || '',
      contactName: meta.contactName || '',
      contactNumber: meta.contactNumber || '',
      type: meta.type || '',
      mimetype: meta.mimetype || '',
      ts: meta.ts || 0,
      state: 'QUEUED',
      createdAt: now,
      updatedAt: now
    });
    this.tasks.set(key, task);
    this.prune();
    this._save();
    return { task, duplicate: false, terminal: false };
  }

  update(key, patch = {}, opts = {}) {
    const task = this.tasks.get(String(key));
    if (!task) return null;
    const cleanPatch = { ...patch };
    if (Object.prototype.hasOwnProperty.call(cleanPatch, 'lastError')) {
      cleanPatch.lastError = safeErrorText(cleanPatch.lastError);
    }
    Object.assign(task, cleanPatch, { updatedAt: this.now() });
    if (opts.save !== false) this._save();
    return task;
  }

  transition(key, state, extra = {}, opts = {}) {
    if (!STATES.includes(state)) throw new Error(`estado de audio invalido: ${state}`);
    const patch = { ...extra, state };
    if (TERMINAL.has(state)) patch.completedAt = this.now();
    return this.update(key, patch, opts);
  }

  recordAttempt(key, info = {}) {
    const task = this.tasks.get(String(key));
    if (!task) return null;
    task.errors.push({
      at: this.now(),
      state: String(info.state || task.state || ''),
      kind: String(info.kind || ''),
      method: String(info.method || ''),
      message: safeErrorText(info.message)
    });
    if (task.errors.length > 20) task.errors = task.errors.slice(-20);
    task.updatedAt = this.now();
    this._saveSoon();
    return task;
  }

  // Tarefas que ainda podem ser retomadas depois de um reinicio.
  pending() {
    return [...this.tasks.values()]
      .filter((t) => ACTIVE.has(t.state))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  // Tarefas travadas ha mais de `ms` voltam para RETRYING. Se ja estavam na
  // etapa da IA, nao retomamos: responder de novo seria pior que registrar
  // a falha. Essas vao para DEAD_LETTER e ficam visiveis no diagnostico.
  markStale(ms = 2 * 60 * 1000, excludeKeys = null) {
    const now = this.now();
    const changed = [];
    for (const t of this.tasks.values()) {
      if (!ACTIVE.has(t.state)) continue;
      if (excludeKeys && typeof excludeKeys.has === 'function' && excludeKeys.has(t.key)) continue;
      if (now - t.updatedAt < ms) continue;
      if (t.state === 'AI_PROCESSING' || t.state === 'RESPONDING') {
        const previous = t.state;
        t.state = 'DEAD_LETTER';
        t.completedAt = now;
        t.errors.push({ at: now, state: previous, kind: 'recovery', message: 'reinicio na etapa de resposta; nao reenviado para evitar duplicidade' });
        if (t.errors.length > 20) t.errors = t.errors.slice(-20);
      } else {
        t.state = 'RETRYING';
      }
      t.updatedAt = now;
      changed.push(t);
    }
    if (changed.length) this._save();
    return changed;
  }

  prune() {
    const now = this.now();
    const terminal = [];
    for (const [key, t] of this.tasks) {
      if (!TERMINAL.has(t.state)) continue;
      if (now - (t.completedAt || t.updatedAt) > this.retentionMs) {
        this.tasks.delete(key);
      } else {
        terminal.push(t);
      }
    }
    if (this.tasks.size > this.maxTasks) {
      const removable = [...this.tasks.values()]
        .filter((t) => TERMINAL.has(t.state))
        .sort((a, b) => a.updatedAt - b.updatedAt);
      let excess = this.tasks.size - this.maxTasks;
      for (const t of removable) {
        if (excess <= 0) break;
        this.tasks.delete(t.key);
        excess--;
      }
    }
  }

  stats() {
    const out = { total: this.tasks.size, states: {}, deadLetters: 0 };
    for (const s of STATES) out.states[s] = 0;
    for (const t of this.tasks.values()) {
      out.states[t.state] = (out.states[t.state] || 0) + 1;
      if (t.state === 'DEAD_LETTER') out.deadLetters++;
    }
    return out;
  }
}

module.exports = { AudioTaskStore, TERMINAL, ACTIVE, STATES };
