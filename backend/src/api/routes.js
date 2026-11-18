// Rotas da API v1. Cada rota delega para o mesmo handler que o IPC do Setup
// usa (runtime.invoke), mantendo uma unica implementacao da regra de negocio.
const path = require('path');
const os = require('os');
const fs = require('fs');
const billingCore = require('../../../src/core/billing');

// RAM/swap reais do servidor. Em Linux usa MemAvailable (o MemFree puro
// ignora cache e mostra a maquina "cheia" sem motivo). Fallback para os.*
// em Windows/macOS, onde o teste roda.
function readMemory() {
  try {
    const txt = fs.readFileSync('/proc/meminfo', 'utf8');
    const read = (key) => {
      const m = txt.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'));
      return m ? Number(m[1]) * 1024 : null;
    };
    const total = read('MemTotal');
    const available = read('MemAvailable');
    const swapTotal = read('SwapTotal') || 0;
    const swapFree = read('SwapFree');
    if (total && available != null) {
      return { total, available, swapTotal, swapUsed: swapFree == null ? 0 : Math.max(0, swapTotal - swapFree) };
    }
  } catch (_) { /* nao e Linux */ }
  const total = os.totalmem();
  const available = os.freemem();
  return { total, available, swapTotal: 0, swapUsed: 0 };
}

// Bloco de recursos exposto em /health e /server/status. O app mobile futuro
// consome o mesmo endpoint para avisar quando a VPS estiver no limite.
function resourcesSnapshot() {
  const mem = readMemory();
  const mb = (bytes) => Math.round(Number(bytes) / 1048576);
  const usedPct = mem.total ? Math.round(((mem.total - mem.available) / mem.total) * 100) : 0;
  return {
    ram: { totalMB: mb(mem.total), availableMB: mb(mem.available), usedPct },
    swap: { totalMB: mb(mem.swapTotal), usedMB: mb(mem.swapUsed) },
    processMB: mb(process.memoryUsage().rss),
    loadavg: os.loadavg().map((n) => Math.round(n * 100) / 100),
    cpus: (os.cpus() || []).length
  };
}

function asArray(value, fallback = []) {
  return Array.isArray(value) ? value : fallback;
}

function normalizeContactId(value) {
  return String(value == null ? '' : value).trim();
}

function sameContact(a, b) {
  const x = normalizeContactId(a);
  const y = normalizeContactId(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return x.split('@')[0] === y.split('@')[0];
}

function isBlocked(zap, contactId) {
  const list = asArray(zap && zap.blockedContacts);
  return list.some((b) => sameContact(b, contactId));
}

function conversationKey(conv) {
  return normalizeContactId(conv.chatId || (conv.contact && conv.contact.id));
}

function toContactRecord(conv, zap, index) {
  const chatId = conversationKey(conv);
  const contact = conv.contact || {};
  const last = conv.lastMessage || null;
  const replied = !!(last && last.fromMe);
  const blocked = isBlocked(zap, chatId) || isBlocked(zap, contact.id) || isBlocked(zap, contact.number);
  return {
    id: contact.id || chatId,
    chatId,
    name: contact.name || contact.pushname || contact.shortName || contact.number || chatId,
    number: contact.number || (chatId ? chatId.split('@')[0] : ''),
    status: blocked ? 'blocked' : 'authorized',
    blocked,
    responded: replied,
    lastMessageAt: last && last.timestamp ? new Date(last.timestamp * 1000).toISOString() : null,
    lastMessagePreview: last && last.body ? String(last.body).slice(0, 140) : '',
    messageCount: Number(conv.messageCount) || 0,
    index
  };
}

function createRoutes({ runtime, config }) {
  const invoke = runtime.invoke;

  async function loadZaps() {
    const list = await invoke('load-zaps');
    return asArray(list);
  }

  async function saveZaps(list, opts) {
    const ok = await invoke('save-zaps', list, opts || {});
    if (ok !== true) throw Object.assign(new Error('falha ao salvar zaps'), { status: 409 });
    return { ok: true, count: list.length };
  }

  async function getZap(zapId) {
    const list = await loadZaps();
    return list.find((z) => String(z.id) === String(zapId)) || null;
  }

  async function getConversations(zapId) {
    try {
      return asArray(await invoke('whatsapp-conversations', String(zapId)));
    } catch (_) {
      return [];
    }
  }

  async function contactsOf(zapId) {
    const zap = await getZap(zapId);
    if (!zap) throw Object.assign(new Error('zap nao encontrado'), { status: 404 });
    const convs = await getConversations(zapId);
    const records = convs.map((c, i) => toContactRecord(c, zap, i));
    return { zap, records };
  }

  return [
    // ------------------------------------------------------------ raiz/health
    {
      method: 'GET', path: '/', public: true,
      handler: () => ({
        ok: true,
        service: 'assistente-zap-backend',
        name: 'Assistente do Zap',
        version: config.version || '1.0.0',
        api: `${config.apiPrefix || '/api/v1'}/health`,
        time: new Date().toISOString()
      })
    },
    {
      method: 'GET', path: '/health', public: true,
      handler: () => ({
        ok: true,
        service: 'assistente-zap-backend',
        version: config.version || '1.0.0',
        uptime: Math.floor(process.uptime()),
        dataDir: config.dataDir,
        time: new Date().toISOString(),
        resources: resourcesSnapshot()
      })
    },
    {
      method: 'POST', path: '/auth/login', public: true,
      handler: (ctx) => {
        const password = ctx.body && (ctx.body.password || ctx.body.senha);
        const result = ctx.auth.login(password);
        if (!result) return { __status: 401, ok: false, error: 'senha invalida' };
        return { ok: true, ...result };
      }
    },
    {
      method: 'GET', path: '/me',
      handler: () => ({ ok: true, user: { id: 'admin', role: 'owner' } })
    },

    // ------------------------------------------------------------ status
    {
      method: 'GET', path: '/status',
      handler: () => {
        const state = runtime.buildStatusState ? runtime.buildStatusState() : {};
        return { ok: true, ...state };
      }
    },
    {
      method: 'GET', path: '/server/overview',
      handler: () => invoke('server-overview')
    },
    {
      method: 'GET', path: '/server/status',
      handler: async () => {
        // O painel usa este endpoint para saber o status de cada zap (mesmo
        // contrato do IPC local). Em modo API nao existe serverSync, entao o
        // estado vem do runtime (buildStatusState) + erros do monitor.
        let extra = {};
        try { extra = (await invoke('server-status')) || {}; } catch (_) {}
        const state = runtime.buildStatusState ? runtime.buildStatusState() : {};
        return { ...extra, ...state, ok: true, resources: resourcesSnapshot() };
      }
    },
    {
      method: 'POST', path: '/server/power',
      handler: (ctx) => invoke('server-power', !!(ctx.body && ctx.body.running))
    },
    {
      method: 'POST', path: '/server/sync-now',
      handler: () => ({ ok: true, mode: 'api', unchanged: true, message: 'API sempre atualizada em tempo real' })
    },
    {
      method: 'GET', path: '/server/sync-status',
      handler: () => ({ enabled: false, state: 'api', mode: 'api' })
    },
    {
      method: 'POST', path: '/commands',
      handler: (ctx) => invoke('server-command', String((ctx.body && ctx.body.command) || ''))
    },

    // ------------------------------------------------------------ zaps
    {
      method: 'GET', path: '/zaps',
      handler: async () => {
        const list = await invoke('load-zaps');
        return list == null ? [] : list;
      }
    },
    {
      method: 'PUT', path: '/zaps',
      handler: async (ctx) => {
        const body = ctx.body || {};
        const list = Array.isArray(body) ? body : body.zaps;
        return saveZaps(asArray(list), { allowEmpty: !!(body && body.allowEmpty) });
      }
    },
    {
      method: 'POST', path: '/zaps',
      handler: async (ctx) => {
        const zap = ctx.body && (ctx.body.zap || ctx.body);
        if (!zap || typeof zap !== 'object' || Array.isArray(zap) || !zap.id) {
          throw Object.assign(new Error('informe o zap com id'), { status: 400 });
        }
        const list = await loadZaps();
        if (list.some((z) => String(z.id) === String(zap.id))) {
          throw Object.assign(new Error('ja existe zap com este id'), { status: 409 });
        }
        list.push(zap);
        return saveZaps(list);
      }
    },
    {
      method: 'GET', path: '/zaps/:id',
      handler: async (ctx) => {
        const zap = await getZap(ctx.params.id);
        if (!zap) throw Object.assign(new Error('zap nao encontrado'), { status: 404 });
        return zap;
      }
    },
    {
      method: 'PATCH', path: '/zaps/:id',
      handler: async (ctx) => {
        const patch = ctx.body || {};
        const list = await loadZaps();
        const zap = list.find((z) => String(z.id) === String(ctx.params.id));
        if (!zap) throw Object.assign(new Error('zap nao encontrado'), { status: 404 });
        Object.assign(zap, patch, { id: zap.id });
        await saveZaps(list);
        return zap;
      }
    },
    {
      method: 'DELETE', path: '/zaps/:id',
      handler: async (ctx) => {
        const list = await loadZaps();
        const next = list.filter((z) => String(z.id) !== String(ctx.params.id));
        if (next.length === list.length) throw Object.assign(new Error('zap nao encontrado'), { status: 404 });
        await saveZaps(next, { allowEmpty: true });
        try { await invoke('server-delete-zap-session', String(ctx.params.id)); } catch (_) {}
        return { ok: true, remaining: next.length };
      }
    },
    {
      method: 'POST', path: '/zaps/:id/connect',
      handler: (ctx) => {
        const body = ctx.body || {};
        return invoke('whatsapp-connect', String(ctx.params.id), String(body.phone || ''), body.method || 'pairing');
      }
    },
    {
      method: 'POST', path: '/zaps/:id/disconnect',
      handler: (ctx) => invoke('whatsapp-disconnect', String(ctx.params.id))
    },
    {
      method: 'GET', path: '/zaps/:id/status',
      handler: (ctx) => invoke('whatsapp-status', String(ctx.params.id))
    },
    {
      method: 'GET', path: '/zaps/:id/qr',
      handler: async (ctx) => {
        const st = await invoke('whatsapp-status', String(ctx.params.id));
        return {
          ok: true,
          zapId: String(ctx.params.id),
          status: st && st.status,
          qr: st && st.qr ? st.qr : null,
          pairingCode: st && st.pairingCode ? st.pairingCode : null
        };
      }
    },
    {
      method: 'DELETE', path: '/zaps/:id/session',
      handler: (ctx) => invoke('server-delete-zap-session', String(ctx.params.id))
    },

    // ------------------------------------------------------------ mensagens
    {
      method: 'POST', path: '/zaps/:id/send',
      handler: (ctx) => {
        const b = ctx.body || {};
        return invoke('whatsapp-send', String(ctx.params.id), b.phone || b.chatId, b.text || '', b.chatId || b.phone);
      }
    },
    {
      method: 'POST', path: '/zaps/:id/send-media',
      handler: (ctx) => {
        const b = ctx.body || {};
        return invoke('whatsapp-send-media', String(ctx.params.id), b.phone || b.chatId, b.media || {
          data: b.data, mimeType: b.mimeType, name: b.name || b.filename
        });
      }
    },
    {
      method: 'GET', path: '/zaps/:id/conversations',
      handler: async (ctx) => getConversations(ctx.params.id)
    },
    {
      method: 'GET', path: '/zaps/:id/conversations/:chatId/messages',
      handler: (ctx) => invoke('whatsapp-messages', String(ctx.params.id), ctx.params.chatId)
    },
    {
      method: 'GET', path: '/zaps/:id/conversations/:chatId/history',
      handler: (ctx) => invoke('whatsapp-chat-history', String(ctx.params.id), ctx.params.chatId, Number(ctx.query.limit) || 50)
    },
    {
      method: 'GET', path: '/zaps/:id/conversations/:chatId/media/:msgId',
      handler: (ctx) => invoke('whatsapp-chat-media', String(ctx.params.id), ctx.params.chatId, ctx.params.msgId, ctx.query.hint || null)
    },
    {
      method: 'POST', path: '/zaps/:id/conversations/:chatId/active',
      handler: (ctx) => invoke('whatsapp-set-active-chat', String(ctx.params.id), ctx.params.chatId)
    },

    // ------------------------------------------------------------ contatos
    {
      method: 'GET', path: '/zaps/:id/contacts',
      handler: async (ctx) => {
        const { records } = await contactsOf(ctx.params.id);
        let list = records;
        if (ctx.query.status === 'blocked') list = list.filter((c) => c.blocked);
        else if (ctx.query.status === 'authorized') list = list.filter((c) => !c.blocked);
        if (ctx.query.responded === 'true') list = list.filter((c) => c.responded);
        if (ctx.query.responded === 'false') list = list.filter((c) => !c.responded);
        if (ctx.query.q) {
          const q = String(ctx.query.q).toLowerCase();
          list = list.filter((c) => c.name.toLowerCase().includes(q) || String(c.number).includes(q));
        }
        return { ok: true, total: list.length, contacts: list };
      }
    },
    {
      method: 'GET', path: '/zaps/:id/contacts/stats',
      handler: async (ctx) => {
        const { records } = await contactsOf(ctx.params.id);
        const blocked = records.filter((c) => c.blocked).length;
        const responded = records.filter((c) => c.responded && !c.blocked).length;
        const authorized = records.length - blocked;
        return {
          ok: true,
          total: records.length,
          authorized,
          blocked,
          responded,
          notResponded: Math.max(0, authorized - responded),
          responseRate: authorized ? Number((responded / authorized).toFixed(4)) : 0
        };
      }
    },
    {
      method: 'POST', path: '/zaps/:id/contacts/block',
      handler: async (ctx) => {
        const contactId = normalizeContactId(ctx.body && (ctx.body.contactId || ctx.body.id || ctx.body.chatId));
        if (!contactId) throw Object.assign(new Error('informe contactId'), { status: 400 });
        const list = await loadZaps();
        const zap = list.find((z) => String(z.id) === String(ctx.params.id));
        if (!zap) throw Object.assign(new Error('zap nao encontrado'), { status: 404 });
        if (!Array.isArray(zap.blockedContacts)) zap.blockedContacts = [];
        if (!zap.blockedContacts.some((b) => sameContact(b, contactId))) zap.blockedContacts.push(contactId);
        await saveZaps(list);
        return { ok: true, blocked: zap.blockedContacts.length };
      }
    },
    {
      method: 'DELETE', path: '/zaps/:id/contacts/block/:contactId',
      handler: async (ctx) => {
        const contactId = ctx.params.contactId;
        const list = await loadZaps();
        const zap = list.find((z) => String(z.id) === String(ctx.params.id));
        if (!zap) throw Object.assign(new Error('zap nao encontrado'), { status: 404 });
        const before = asArray(zap.blockedContacts);
        zap.blockedContacts = before.filter((b) => !sameContact(b, contactId));
        await saveZaps(list);
        return { ok: true, removed: before.length - zap.blockedContacts.length, blocked: zap.blockedContacts.length };
      }
    },
    {
      method: 'POST', path: '/zaps/:id/contacts/:contactId/authorize',
      handler: async (ctx) => {
        const list = await loadZaps();
        const zap = list.find((z) => String(z.id) === String(ctx.params.id));
        if (!zap) throw Object.assign(new Error('zap nao encontrado'), { status: 404 });
        const before = asArray(zap.blockedContacts);
        zap.blockedContacts = before.filter((b) => !sameContact(b, ctx.params.contactId));
        await saveZaps(list);
        return { ok: true, removed: before.length - zap.blockedContacts.length };
      }
    },
    {
      method: 'POST', path: '/zaps/:id/contacts/block-all-existing',
      handler: async (ctx) => {
        const { zap, records } = await contactsOf(ctx.params.id);
        const list = await loadZaps();
        const target = list.find((z) => String(z.id) === String(zap.id));
        if (!target) throw Object.assign(new Error('zap nao encontrado'), { status: 404 });
        if (!Array.isArray(target.blockedContacts)) target.blockedContacts = [];
        let added = 0;
        for (const c of records) {
          const id = c.chatId || c.id;
          if (!id) continue;
          if (!target.blockedContacts.some((b) => sameContact(b, id))) {
            target.blockedContacts.push(id);
            added++;
          }
        }
        await saveZaps(list);
        return { ok: true, added, blocked: target.blockedContacts.length };
      }
    },

    // ------------------------------------------------------------ billing
    {
      method: 'GET', path: '/zaps/:id/billing',
      handler: async (ctx) => {
        const zap = await getZap(ctx.params.id);
        if (!zap) throw Object.assign(new Error('zap nao encontrado'), { status: 404 });
        return { ok: true, ...billingCore.describeBilling(zap) };
      }
    },
    {
      method: 'PUT', path: '/zaps/:id/billing',
      handler: (ctx) => invoke('billing-save', String(ctx.params.id), ctx.body || {})
    },
    {
      method: 'POST', path: '/zaps/:id/billing/pay',
      handler: async (ctx) => {
        const month = ctx.body && ctx.body.month;
        if (!month) throw Object.assign(new Error('informe month (ex: 2026-11)'), { status: 400 });
        const list = await loadZaps();
        const zap = list.find((z) => String(z.id) === String(ctx.params.id));
        if (!zap) throw Object.assign(new Error('zap nao encontrado'), { status: 404 });
        zap.billingPlan = billingCore.markMonthPaid(zap.billingPlan || {}, month, true);
        await saveZaps(list);
        return { ok: true, billing: billingCore.describeBilling(zap) };
      }
    },
    {
      method: 'GET', path: '/billing/overview',
      handler: async () => {
        const list = await loadZaps();
        const items = list.map((z) => ({
          zapId: String(z.id),
          name: z.name || '',
          enabled: z.enabled !== false,
          ...billingCore.describeBilling(z)
        }));
        return {
          ok: true,
          total: items.length,
          overdue: items.filter((i) => i.status === 'overdue').length,
          pending: items.filter((i) => i.status === 'pending').length,
          grace: items.filter((i) => i.status === 'grace').length,
          // compat: cliente antigo lia "suspended"
          suspended: items.filter((i) => i.status === 'overdue').length,
          items
        };
      }
    },

    // ------------------------------------------------------------ providers/trainings
    {
      method: 'GET', path: '/providers',
      handler: () => invoke('load-providers')
    },
    {
      method: 'PUT', path: '/providers',
      handler: async (ctx) => {
        const body = ctx.body || {};
        const list = Array.isArray(body) ? body : body.providers;
        const ok = await invoke('save-providers', asArray(list));
        if (ok !== true) throw Object.assign(new Error('falha ao salvar provedores'), { status: 409 });
        return { ok: true };
      }
    },
    {
      method: 'GET', path: '/trainings',
      handler: () => invoke('load-trainings')
    },
    {
      method: 'PUT', path: '/trainings',
      handler: async (ctx) => {
        const body = ctx.body || {};
        const data = Array.isArray(body) ? body : (body.trainings || body);
        const deletedFiles = Array.isArray(body && body.deletedFiles) ? body.deletedFiles : [];
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          throw Object.assign(new Error('trainings invalido'), { status: 400 });
        }
        return invoke('save-trainings', data, deletedFiles);
      }
    },
    {
      method: 'DELETE', path: '/zaps/:id/trainings',
      handler: (ctx) => invoke('delete-trainings-for-zap', String(ctx.params.id))
    },

    // ------------------------------------------------------------ automacao/agente
    {
      method: 'GET', path: '/auto-message/state',
      handler: () => invoke('auto-msg-state')
    },
    {
      method: 'POST', path: '/auto-message/chat',
      handler: (ctx) => invoke('auto-msg-chat', ctx.body || {})
    },
    {
      method: 'POST', path: '/auto-message/stop',
      handler: () => invoke('auto-msg-stop')
    },
    {
      method: 'POST', path: '/auto-message/note',
      handler: (ctx) => invoke('auto-msg-note', ctx.body || {})
    },
    {
      method: 'POST', path: '/auto-message/transcribe',
      handler: (ctx) => {
        const b = ctx.body || {};
        return invoke('auto-msg-transcribe', b.audio, b.zapId);
      }
    },
    {
      method: 'POST', path: '/agent/chat',
      handler: (ctx) => invoke('agent-chat', ctx.body || {})
    },

    // ------------------------------------------------------------ logs
    {
      method: 'GET', path: '/logs',
      handler: async (ctx) => {
        const lines = asArray(await invoke('server-terminal-logs'));
        const limit = Number(ctx.query.limit) || 500;
        return { ok: true, lines: lines.slice(-limit) };
      }
    },
    {
      method: 'DELETE', path: '/logs',
      handler: async () => {
        await invoke('server-terminal-clear');
        return { ok: true };
      }
    },
    {
      method: 'GET', path: '/logs/ring',
      handler: () => ({ ok: true, lines: runtime.events ? [] : [] })
    }
  ];
}

module.exports = { createRoutes, sameContact };
