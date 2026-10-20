const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  maxConversationsPerChat: 40,
  maxMessagesPerConversation: 120,
  maxAgeDays: 30
};

function pad2(n) {
  return String(n).padStart(2, '0');
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function endOfDay(day) {
  const p = String(day).split('-').map(Number);
  if (p.length !== 3 || p.some(isNaN)) return Date.now();
  return new Date(p[0], p[1] - 1, p[2] + 1, 0, 0, 0, 0).getTime();
}

function hourLabel(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

class ConversationStore {
  constructor(filePath, options) {
    this.filePath = filePath || null;
    this.options = Object.assign({}, DEFAULTS, options || {});
    this.conversations = [];
    this._savePending = false;
    this._load();
  }

  _load() {
    if (!this.filePath || !fs.existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const list = Array.isArray(raw) ? raw : (raw && raw.conversations);
      this.conversations = Array.isArray(list) ? list.filter(c => c && c.key && c.zapId && c.chatId) : [];
    } catch (e) {
      console.error('[CONV] arquivo de conversas ilegivel, comecando vazio:', e.message);
      this.conversations = [];
    }
  }

  scheduleSave() {
    if (!this.filePath || this._savePending) return;
    this._savePending = true;
    setImmediate(() => {
      this._savePending = false;
      this.flush();
    });
  }

  flush() {
    if (!this.filePath) return;
    this._savePending = false;
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, conversations: this.conversations }));
      fs.renameSync(tmp, this.filePath);
    } catch (e) {
      console.error('[CONV] erro ao gravar conversas:', e.message);
    }
  }

  keyOf(zapId, chatId) {
    return `${zapId}|${chatId}`;
  }

  findActive(zapId, chatId) {
    const k = this.keyOf(zapId, chatId);
    for (let i = this.conversations.length - 1; i >= 0; i--) {
      const c = this.conversations[i];
      if (c.key === k && !c.endedAt) return c;
    }
    return null;
  }

  ensure(zapId, chatId, now) {
    const ts = now || Date.now();
    const today = dayKey(ts);
    let active = this.findActive(zapId, chatId);
    let closed = false;

    if (active && active.day !== today) {
      active.endedAt = endOfDay(active.day);
      active = null;
      closed = true;
    }

    if (!active) {
      active = {
        id: `conv_${ts}_${Math.random().toString(36).slice(2, 8)}`,
        key: this.keyOf(zapId, chatId),
        zapId: String(zapId),
        chatId: String(chatId),
        day: today,
        startedAt: ts,
        endedAt: null,
        messages: []
      };
      this.conversations.push(active);
      this._prune();
      this.scheduleSave();
      return { conversation: active, created: true, closedPrevious: closed };
    }

    if (closed) this.scheduleSave();
    return { conversation: active, created: false, closedPrevious: closed };
  }

  append(zapId, chatId, role, content, now) {
    if (!content) return null;
    const ts = now || Date.now();
    let active = this.findActive(zapId, chatId);
    if (!active) active = this.ensure(zapId, chatId, ts).conversation;
    active.messages.push({ role: role === 'assistant' ? 'assistant' : 'user', content: String(content), at: ts });
    const max = this.options.maxMessagesPerConversation;
    if (active.messages.length > max) active.messages = active.messages.slice(-max);
    this.scheduleSave();
    return active;
  }

  history(zapId, chatId) {
    const active = this.findActive(zapId, chatId);
    if (!active) return [];
    return active.messages.map(m => ({ role: m.role, content: m.content }));
  }

  updateLastAssistant(zapId, chatId, content) {
    const active = this.findActive(zapId, chatId);
    if (!active || !active.messages.length) return false;
    const last = active.messages[active.messages.length - 1];
    if (last.role !== 'assistant') return false;
    last.content = String(content || '');
    this.scheduleSave();
    return true;
  }

  info(zapId, chatId) {
    const active = this.findActive(zapId, chatId);
    if (!active) return null;
    return {
      id: active.id,
      startedAt: active.startedAt,
      day: active.day,
      label: hourLabel(active.startedAt),
      count: active.messages.length,
      created: false
    };
  }

  // Historico das conversas ANTERIORES (dias passados) dentro da janela de N
  // dias. A conversa do dia atual ja vai como "turns" para a IA, entao nao e
  // repetida aqui - esta memoria e o "o que conversamos nos dias passados".
  recentHistory(zapId, chatId, opts) {
    opts = opts || {};
    const days = Math.max(1, parseInt(opts.days, 10) || 3);
    const now = opts.now || Date.now();
    const cutoff = now - days * 86400000;
    const key = this.keyOf(zapId, chatId);
    const active = this.findActive(zapId, chatId);
    const out = [];
    for (const c of this.conversations) {
      if (c.key !== key) continue;
      if (active && c.id === active.id) continue; // hoje = turns, nao memoria
      if ((c.endedAt || c.startedAt) < cutoff) continue;
      for (const m of (c.messages || [])) {
        if (!m || !m.content) continue;
        const at = m.at || c.startedAt;
        if (at < cutoff) continue;
        out.push({ role: m.role, content: m.content, at });
      }
    }
    out.sort((a, b) => a.at - b.at);
    return out;
  }

  // Texto da memoria (linhas tipo "[18/10 14:32] Cliente: ..."), das mais
  // antigas para as mais recentes, cortado em maxChars mantendo o fim.
  memoryText(zapId, chatId, opts) {
    opts = opts || {};
    const msgs = this.recentHistory(zapId, chatId, opts);
    if (!msgs.length) return '';
    const maxChars = opts.maxChars || 6000;
    const lines = [];
    let total = 0;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      const d = new Date(m.at);
      const stamp = `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
      const who = m.role === 'assistant' ? 'Atendente' : 'Cliente';
      const line = `[${stamp}] ${who}: ${String(m.content).replace(/\s+/g, ' ').trim()}`;
      if (total + line.length > maxChars && lines.length) break;
      total += line.length;
      lines.unshift(line);
    }
    return lines.join('\n');
  }

  rollOver(now) {
    const ts = now || Date.now();
    const today = dayKey(ts);
    let changed = false;
    for (const c of this.conversations) {
      if (!c.endedAt && c.day !== today) {
        c.endedAt = endOfDay(c.day);
        changed = true;
      }
    }
    if (changed) this.scheduleSave();
    return changed;
  }

  clearForChat(zapId, chatId) {
    const k = this.keyOf(zapId, chatId);
    const before = this.conversations.length;
    this.conversations = this.conversations.filter(c => c.key !== k);
    if (this.conversations.length !== before) this.scheduleSave();
    return before - this.conversations.length;
  }

  clearForZap(zapId) {
    const prefix = `${zapId}|`;
    const before = this.conversations.length;
    this.conversations = this.conversations.filter(c => !String(c.key).startsWith(prefix));
    if (this.conversations.length !== before) this.scheduleSave();
    return before - this.conversations.length;
  }

  countFor(zapId, chatId) {
    const k = this.keyOf(zapId, chatId);
    return this.conversations.filter(c => c.key === k).length;
  }

  _prune() {
    const opts = this.options;
    const cutoff = Date.now() - opts.maxAgeDays * 86400000;
    this.conversations = this.conversations.filter(c => (c.endedAt || c.startedAt) >= cutoff);

    const byKey = new Map();
    for (let i = this.conversations.length - 1; i >= 0; i--) {
      const c = this.conversations[i];
      const arr = byKey.get(c.key) || [];
      arr.push(c);
      byKey.set(c.key, arr);
    }

    const drop = new Set();
    for (const arr of byKey.values()) {
      for (let i = 0; i < arr.length; i++) {
        if (i >= opts.maxConversationsPerChat) {
          drop.add(arr[i].id);
        } else if (arr[i].messages && arr[i].messages.length > opts.maxMessagesPerConversation) {
          arr[i].messages = arr[i].messages.slice(-opts.maxMessagesPerConversation);
        }
      }
    }
    if (drop.size) this.conversations = this.conversations.filter(c => !drop.has(c.id));
  }
}

ConversationStore.dayKey = dayKey;
ConversationStore.endOfDay = endOfDay;

module.exports = ConversationStore;
