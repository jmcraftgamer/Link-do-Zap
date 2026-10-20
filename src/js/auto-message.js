// ============================================
// Mensagem Automatica - gerenciador de campanhas (processo principal)
// Fila de disparos por conta WhatsApp com intervalo de 5 minutos entre
// contatos, log detalhado, persistencia em disco e retomada automatica.
// ============================================
const fs = require('fs');
const { verifyMessage } = require('./message-guard');

const CONTACT_DELAY_MS = 5 * 60 * 1000;   // intervalo minimo entre contatos
const RETRY_DELAY_MS = 60 * 1000;         // espera antes de tentar de novo
const READY_POLL_MS = 30 * 1000;          // espera o zap reconectar
const MAX_ATTEMPTS = 3;
const MAX_LOG = 500;
const MAX_CHAT = 200;
const MAX_SENT = 500;
const MAX_QUEUE = 2000;

function blankState() {
  return {
    zapId: null,
    status: 'idle', // idle | running | stopped | done
    recipients: {}, // "+5532..." -> { addedAt, status: pending|sent|failed }
    queue: [],      // { id, phone, text, files, status, attempts, error, sentAt }
    sent: [],       // { phone, msgId, text, t } - texto enviado (permite apagar)
    log: [],        // { t, type, msg } - log interno (debug/busca)
    chats: {},      // zapId -> [ { role: user|agent|system, content, t } ] historico por conta
    nextAt: 0
  };
}

function prettyPhone(phone) {
  return '+' + String(phone || '').replace(/\D/g, '');
}

function preview(text, n) {
  const t = String(text || '');
  return t.length > n ? t.substring(0, n) + '...' : t;
}

class AutoMessageManager {
  constructor() {
    this.state = blankState();
    this._filePath = null;
    this._deps = {
      getStatus: null,
      sendMessage: null,
      sendMedia: null,
      deleteMessage: null,
      getContactName: null,
      onLog: null,
      onUpdate: null,
      logger: null
    };
    this._running = false;
    this._timer = null;
    this._wake = null;
    this._seq = 0;
    this._delays = {
      contact: CONTACT_DELAY_MS,
      retry: RETRY_DELAY_MS,
      ready: READY_POLL_MS
    };
  }

  configure(opts) {
    opts = opts || {};
    if (opts.filePath) this._filePath = opts.filePath;
    if (opts.delays && typeof opts.delays === 'object') Object.assign(this._delays, opts.delays);
    ['getStatus', 'sendMessage', 'sendMedia', 'deleteMessage', 'getContactName', 'onLog', 'onUpdate', 'logger'].forEach(k => {
      if (typeof opts[k] === 'function') this._deps[k] = opts[k];
    });
    return this;
  }

  _log(...args) {
    if (this._deps.logger) { try { this._deps.logger.apply(null, args); } catch (_) {} }
  }

  // ------------------------------------------------------------
  // Persistencia (.tmp + rename, nunca lanca erro)
  // ------------------------------------------------------------
  load() {
    if (!this._filePath) return false;
    try {
      if (!fs.existsSync(this._filePath)) return false;
      const raw = JSON.parse(fs.readFileSync(this._filePath, 'utf8'));
      const base = blankState();
      this.state = Object.assign(base, raw || {});
      this.state.nextAt = this.state.nextAt || 0;
      if (!Array.isArray(this.state.queue)) this.state.queue = [];
      if (!Array.isArray(this.state.log)) this.state.log = [];
      if (!Array.isArray(this.state.sent)) this.state.sent = [];
      if (!this.state.recipients || typeof this.state.recipients !== 'object') this.state.recipients = {};
      if (!this.state.chats || typeof this.state.chats !== 'object') this.state.chats = {};
      // migracao: versao antiga guardava um chat unico
      if (Array.isArray(this.state.chat)) {
        const oldZap = String(this.state.zapId || 'default');
        if (!Array.isArray(this.state.chats[oldZap])) this.state.chats[oldZap] = this.state.chat;
        delete this.state.chat;
      }
      // envio interrompido por crash/reinicio volta para a fila
      const stuck = this.state.queue.filter(q => q.status === 'sending');
      stuck.forEach(q => { q.status = 'pending'; });
      if (stuck.length) this._log('[AUTOMSG]', stuck.length, 'envio(s) interrompido(s) recolocado(s) na fila');
      this._log('[AUTOMSG] Estado da campanha carregado:', this.state.status, this.state.queue.length, 'na fila');
      return true;
    } catch (e) {
      this._log('[AUTOMSG] Falha ao carregar estado da campanha:', e.message);
      this.state = blankState();
      return false;
    }
  }

  save() {
    if (!this._filePath) return;
    try {
      const tmp = this._filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.state));
      fs.renameSync(tmp, this._filePath);
    } catch (e) {
      this._log('[AUTOMSG] Falha ao salvar estado da campanha:', e.message);
    }
  }

  // ------------------------------------------------------------
  // Snapshot para o renderer (sem base64 dos anexos)
  // ------------------------------------------------------------
  getState() {
    const queue = this.state.queue.map(q => ({
      id: q.id,
      phone: q.phone,
      text: preview(q.text, 120),
      files: (q.files || []).map(f => f.name),
      status: q.status,
      attempts: q.attempts || 0,
      error: q.error || '',
      sentAt: q.sentAt || 0
    }));
    const counts = {
      total: this.state.queue.length,
      pending: this.state.queue.filter(q => q.status === 'pending' || q.status === 'sending').length,
      sent: this.state.queue.filter(q => q.status === 'sent').length,
      failed: this.state.queue.filter(q => q.status === 'failed').length,
      recipients: Object.keys(this.state.recipients).length
    };
    return {
      zapId: this.state.zapId,
      status: this.state.status,
      nextAt: this.state.nextAt || 0,
      running: this._running,
      counts,
      recipients: Object.keys(this.state.recipients).map(p => ({
        phone: p,
        status: this.state.recipients[p] ? this.state.recipients[p].status : 'pending'
      })),
      queue,
      log: this.state.log.slice(-MAX_LOG),
      chats: Object.keys(this.state.chats).reduce((acc, k) => {
        acc[k] = (this.state.chats[k] || []).slice(-MAX_CHAT);
        return acc;
      }, {})
    };
  }

  emitUpdate() {
    if (this._deps.onUpdate) { try { this._deps.onUpdate(this.getState()); } catch (e) { this._log('[AUTOMSG] onUpdate falhou:', e.message); } }
  }

  addLog(type, msg) {
    const entry = { t: Date.now(), type: type || 'info', msg: String(msg || '') };
    this.state.log.push(entry);
    if (this.state.log.length > MAX_LOG) this.state.log.splice(0, this.state.log.length - MAX_LOG);
    if (this._deps.onLog) { try { this._deps.onLog(entry); } catch (_) {} }
    this._log(`[AUTOMSG][${entry.type}] ${entry.msg}`);
    return entry;
  }

  // ------------------------------------------------------------
  // Historico por conta (a IA usa para lembrar do que ja foi feito)
  // ------------------------------------------------------------
  chatFor(zapId) {
    const key = String(zapId || this.state.zapId || 'default');
    if (!Array.isArray(this.state.chats[key])) this.state.chats[key] = [];
    return this.state.chats[key];
  }

  pushChat(role, content, zapId) {
    const list = this.chatFor(zapId);
    list.push({ role, content: String(content || ''), t: Date.now() });
    if (list.length > MAX_CHAT) list.splice(0, list.length - MAX_CHAT);
  }

  pushSystem(content, zapId) {
    this.pushChat('system', content, zapId);
  }

  historyTurns(zapId) {
    return this.chatFor(zapId).map(c => ({
      role: c.role === 'user' ? 'user' : 'assistant',
      content: c.content
    }));
  }

  displayContact(phone) {
    let name = '';
    try {
      if (this._deps.getContactName) name = this._deps.getContactName(this.state.zapId, phone) || '';
    } catch (_) {}
    return name ? `${name} (${prettyPhone(phone)})` : prettyPhone(phone);
  }

  // ------------------------------------------------------------
  // Conta (Zap) da campanha
  // ------------------------------------------------------------
  setZap(zapId) {
    const id = String(zapId || '');
    if (!id) return false;
    const hasPending = this.state.queue.some(q => q.status === 'pending' || q.status === 'sending');
    if (this.state.zapId && this.state.zapId !== id && hasPending && this.state.status === 'running') return false;
    if (this.state.zapId !== id) {
      if (this.state.zapId) {
        const lost = this.pendingCount();
        const chats = this.state.chats || {};
        this.state = blankState();
        this.state.chats = chats; // o historico de cada conta e preservado
        this.state.zapId = id;
        this.addLog('info', `Conta alterada - nova campanha iniciada com o zap ${id}${lost ? ` (${lost} mensagem(ns) da fila anterior descartada(s))` : ''}`);
      } else {
        this.state.zapId = id;
      }
      this.save();
      this.emitUpdate();
    }
    return true;
  }

  // ------------------------------------------------------------
  // Numeros
  // ------------------------------------------------------------
  normalizeNumber(raw) {
    let d = String(raw == null ? '' : raw).replace(/\D/g, '');
    if (!d) return null;
    if (d.startsWith('00')) d = d.slice(2);
    if (d.startsWith('55') && (d.length === 12 || d.length === 13)) return d;
    if (d.startsWith('0') && (d.length === 11 || d.length === 12)) d = d.slice(1);
    if (d.length === 10 || d.length === 11) return '55' + d;
    if (d.length >= 8 && d.length <= 15) return d;
    return null;
  }

  extractNumbers(text) {
    const out = [];
    const seen = new Set();
    const re = /\+?\d[\d\s().\-]{6,}\d/g;
    const matches = String(text || '').match(re) || [];
    for (const raw of matches) {
      if (raw.includes('/')) continue;
      const digits = raw.replace(/\D/g, '');
      if (digits.length < 8 || digits.length > 15) continue;
      const n = this.normalizeNumber(raw);
      if (n && !seen.has(n)) { seen.add(n); out.push(n); }
    }
    return out;
  }

  addRecipient(phone) {
    const n = this.normalizeNumber(phone);
    if (!n) return false;
    if (this.state.recipients[n]) return false;
    this.state.recipients[n] = { addedAt: Date.now(), status: 'pending' };
    return true;
  }

  resolveNumbers(spec) {
    if (spec === 'all' || spec === true) return Object.keys(this.state.recipients);
    const list = Array.isArray(spec) ? spec : (spec ? [spec] : []);
    const out = [];
    const seen = new Set();
    for (const raw of list) {
      const n = this.normalizeNumber(raw);
      if (n && !seen.has(n)) { seen.add(n); out.push(n); }
    }
    return out;
  }

  resolveFiles(spec, attachments) {
    const files = Array.isArray(attachments) ? attachments : [];
    if (spec === 'all' || spec === true) return files.slice();
    if (!Array.isArray(spec) || !spec.length) return [];
    const wanted = spec.map(s => String(s).toLowerCase());
    return files.filter(f => wanted.includes(String(f.name || '').toLowerCase()));
  }

  // ------------------------------------------------------------
  // Acoes do agente
  // ------------------------------------------------------------
  async runActions(actions, attachments) {
    let scheduled = 0;
    const notes = [];
    const list = Array.isArray(actions) ? actions : [];

    for (const a of list) {
      if (!a || typeof a !== 'object') continue;
      const type = String(a.type || '').toLowerCase();

      if (type === 'send') {
        const nums = this.resolveNumbers(a.numbers);
        const text = typeof a.text === 'string' ? a.text : '';
        const repeat = Math.min(10, Math.max(1, parseInt(a.repeat, 10) || 1));
        const files = this.resolveFiles(a.files, attachments);
        if (!nums.length) { notes.push('acao send sem numeros validos - ignorada'); continue; }
        if (!text.trim() && !files.length) { notes.push('acao send sem texto nem arquivo - ignorada'); continue; }
        // Verificador: nao deixa codigo/markdown/marcador/texto de sistema entrar na fila.
        if (text.trim()) {
          const v = verifyMessage(text.trim());
          if (!v.ok) { notes.push(`acao send reprovada pelo verificador (${v.reason}) - ignorada`); continue; }
        }
        for (const phone of nums) {
          this.addRecipient(phone);
          for (let i = 0; i < repeat; i++) {
            if (this.state.queue.length >= MAX_QUEUE) break;
            this.state.queue.push({
              id: `q${Date.now()}_${this._seq++}`,
              phone,
              text: text.trim(),
              files: files.map(f => ({ name: f.name, mimeType: f.mimeType || 'application/octet-stream', data: f.data || '' })),
              status: 'pending',
              attempts: 0,
              error: '',
              sentAt: 0
            });
            scheduled++;
          }
        }
        notes.push(`${nums.length} numero(s) x${repeat} agendado(s)`);
      } else if (type === 'delete') {
        const nums = this.resolveNumbers(a.numbers);
        const res = await this.deleteFor(nums);
        notes.push(res);
      } else if (type === 'add') {
        const nums = this.resolveNumbers(a.numbers);
        let added = 0;
        for (const n of nums) if (this.addRecipient(n)) added++;
        notes.push(`${added} numero(s) registrado(s)`);
      } else {
        notes.push(`acao desconhecida "${type}" ignorada`);
      }
    }

    if (scheduled > 0) {
      this.state.status = 'running';
      this.addLog('info', `${scheduled} mensagem(ns) colocada(s) na fila - intervalo de 5 minutos entre contatos`);
      this.startRunner();
    }
    this.save();
    this.emitUpdate();
    return { scheduled, notes };
  }

  async deleteFor(numbers) {
    let ok = 0;
    let fail = 0;
    for (const phone of numbers) {
      const entries = this.state.sent.filter(s => s.phone === phone);
      if (!entries.length) {
        this.addLog('warning', `Nenhuma mensagem registrada para ${prettyPhone(phone)} - nada a apagar`);
        fail++;
        continue;
      }
      for (const e of entries.slice().reverse()) {
        try {
          const how = await this._deps.deleteMessage(this.state.zapId, e.msgId);
          ok++;
          this.state.sent = this.state.sent.filter(s => s !== e);
          this.addLog('success', `Mensagem apagada de ${prettyPhone(phone)} (${how === 'mine' ? 'apagada so para voce' : 'apagada para todos'})`);
          this.pushSystem(`Mensagem apagada de ${this.displayContact(phone)} (${how === 'mine' ? 'apagada so para voce' : 'apagada para todos'})`);
        } catch (err) {
          fail++;
          this.addLog('error', `Falha ao apagar mensagem de ${prettyPhone(phone)}: ${err.message}`);
        }
      }
    }
    return `${ok} apagada(s), ${fail} sem exclusao`;
  }

  // ------------------------------------------------------------
  // Runner: envia a fila com 5 min de intervalo
  // ------------------------------------------------------------
  pendingCount() {
    return this.state.queue.filter(q => q.status === 'pending' || q.status === 'sending').length;
  }

  startRunner() {
    if (this._running) return;
    if (this.pendingCount() === 0) return;
    this.state.status = 'running';
    this._running = true;
    this._loop().catch(e => {
      this._log('[AUTOMSG] Loop de envio derrubado:', e && e.message ? e.message : e);
    }).then(() => {
      this._running = false;
      this.emitUpdate();
    });
  }

  async _loop() {
    while (this.state.status === 'running') {
      const item = this.state.queue.find(q => q.status === 'pending');
      if (!item) {
        const sending = this.state.queue.some(q => q.status === 'sending');
        if (sending) {
          await this.sleep(1000);
          continue;
        }
        this.state.status = 'done';
        this.state.nextAt = 0;
        this.addLog('success', 'Fila concluida - nenhum contato pendente');
        this.pushSystem(`Fila concluida - ${this.state.queue.filter(q => q.status === 'sent').length} mensagem(ns) enviada(s)`);
        this.save();
        this.emitUpdate();
        break;
      }

      // Aguarda o zap ficar conectado
      let st = '';
      try {
        const r = this._deps.getStatus ? this._deps.getStatus(this.state.zapId) : null;
        st = String((r && r.status) || r || '');
      } catch (_) {}
      if (st !== 'ready') {
        this.addLog('warning', `Zap ${this.state.zapId || '(sem conta)'} nao conectado (${st || 'desconhecido'}) - aguardando reconexao para enviar a ${prettyPhone(item.phone)}`);
        this.emitUpdate();
        await this.sleep(this._delays.ready);
        continue;
      }

      item.status = 'sending';
      const total = this.state.queue.length;
      const done = this.state.queue.filter(q => q.status === 'sent').length + 1;
      try {
        if (item.text) {
          const r = await this._deps.sendMessage(this.state.zapId, item.phone, item.text);
          const msgId = r && r.msgId ? r.msgId : null;
          if (msgId) {
            this.state.sent.push({ phone: item.phone, msgId, text: item.text, t: Date.now() });
            if (this.state.sent.length > MAX_SENT) this.state.sent.splice(0, this.state.sent.length - MAX_SENT);
          }
        }
        for (const f of (item.files || [])) {
          await this._deps.sendMedia(this.state.zapId, item.phone, {
            data: f.data, mimeType: f.mimeType, name: f.name, returnId: true
          });
        }
        item.status = 'sent';
        item.sentAt = Date.now();
        item.attempts = (item.attempts || 0) + 1;
        item.error = '';
        if (this.state.recipients[item.phone]) this.state.recipients[item.phone].status = 'sent';

        const more = this.pendingCount() > 0;
        this.addLog('success', `Enviado para ${prettyPhone(item.phone)} (${done}/${total})${more ? ' - proxima em 5:00' : ' - fila sem proximos'}`);
        this.pushSystem(`Mensagem enviada para ${this.displayContact(item.phone)}`);
        if (item.text) this.pushSystem(item.text);
        this.state.nextAt = more ? Date.now() + this._delays.contact : 0;
        this.save();
        this.emitUpdate();

        if (more) {
          this.addLog('info', 'Proximo envio em 5:00 (intervalo entre contatos)');
          await this.sleep(this._delays.contact);
        }
      } catch (e) {
        item.attempts = (item.attempts || 0) + 1;
        item.error = e && e.message ? e.message : String(e);
        // Numero fora do WhatsApp: falha permanente - nao adianta repetir
        const permanent = /nao esta no whatsapp/i.test(item.error);
        if (permanent || item.attempts >= MAX_ATTEMPTS) {
          item.status = 'failed';
          if (this.state.recipients[item.phone]) this.state.recipients[item.phone].status = 'failed';
          if (permanent) {
            this.addLog('error', `Falha ao enviar para ${prettyPhone(item.phone)}: numero nao esta no WhatsApp (descartado)`);
            this.pushSystem(`Falha ao enviar para ${this.displayContact(item.phone)}: numero nao esta no WhatsApp`);
          } else {
            this.addLog('error', `Falha ao enviar para ${prettyPhone(item.phone)} apos ${MAX_ATTEMPTS} tentativas: ${item.error}`);
            this.pushSystem(`Falha ao enviar para ${this.displayContact(item.phone)}: ${item.error}`);
          }
          this.save();
          this.emitUpdate();
          if (permanent) continue; // sem espera - proximo contato
        } else {
          item.status = 'pending';
          this.addLog('warning', `Falha ao enviar para ${prettyPhone(item.phone)} (tentativa ${item.attempts}/${MAX_ATTEMPTS}): ${item.error} - nova tentativa em 60s`);
          this.save();
          this.emitUpdate();
          await this.sleep(this._delays.retry);
        }
      }
    }
  }

  // Espera o primeiro resultado (envio ou falha) da fila - usado pelo ChatBox
  // para o followup da IA refletir o que realmente aconteceu
  async waitForFirstOutcome(timeoutMs) {
    const t0 = Date.now();
    const count = () => this.state.queue.filter(q => q.status === 'sent' || q.status === 'failed').length;
    const start = count();
    while (Date.now() - t0 < timeoutMs) {
      if (count() !== start) return true;
      if (this.state.status !== 'running') return false;
      await new Promise(r => setTimeout(r, 300));
    }
    return false;
  }

  sleep(ms) {
    return new Promise(resolve => {
      this._timer = setTimeout(() => {
        this._timer = null;
        this._wake = null;
        resolve(true);
      }, ms);
      this._wake = () => {
        if (this._timer) clearTimeout(this._timer);
        this._timer = null;
        this._wake = null;
        resolve(false);
      };
    });
  }

  wake() {
    if (this._wake) this._wake();
  }

  stop() {
    if (this.state.status === 'running') {
      this.state.status = 'stopped';
      this.addLog('warning', 'Campanha parada pelo usuario - fila preservada');
      this.pushSystem('Campanha parada pelo usuario - fila preservada');
    }
    this.state.nextAt = 0;
    this.wake();
    this.save();
    this.emitUpdate();
  }

  // Retomada no boot: se a campanha estava rodando, continua de onde parou
  resumeOnBoot() {
    if (this.state.status !== 'running') return false;
    const pending = this.pendingCount();
    if (!pending) {
      this.state.status = 'done';
      this.save();
      return false;
    }
    this.addLog('info', `Retomada automatica apos reinicio - ${pending} mensagem(ns) pendente(s)`);
    this.pushSystem(`Retomada automatica apos reinicio - ${pending} mensagem(ns) pendente(s)`);
    this.emitUpdate();
    this.startRunner();
    return true;
  }
}

module.exports = AutoMessageManager;
module.exports.CONTACT_DELAY_MS = CONTACT_DELAY_MS;
module.exports.prettyPhone = prettyPhone;
