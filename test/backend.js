// Contrato da API HTTP/WebSocket do backend.
// Sobe o servidor com um runtime FALSO (sem Electron/WhatsApp) e valida:
//  - /health publico, login, token e 401 sem token
//  - zaps: leitura e escrita
//  - contatos: lista, bloqueio e estatisticas
//  - billing: status e pagamento do mes
//  - logs e WebSocket de eventos ao vivo
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const WebSocket = require('ws');

const root = path.join(__dirname, '..');
const { startBackend } = require(path.join(root, 'backend', 'src', 'index'));
const { createEventBus } = require(path.join(root, 'src', 'core', 'events'));
const { createRemoteApi } = require(path.join(root, 'src', 'js', 'api-client'));
const billingCore = require(path.join(root, 'src', 'core', 'billing'));
const { BillingStore } = require(path.join(root, 'src', 'core', 'billing-store'));

const pending = [];
let passed = 0;
const failures = [];
const realLog = console.log;
const out = (...a) => realLog(...a);
function test(name, fn) { pending.push({ name, fn }); }
function testAsync(name, fn) { pending.push({ name, fn, async: true }); }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zap-backend-'));
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const signature = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=';
  const password = 'senha-de-teste';
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  const authPath = path.join(dataDir, 'backend-auth.json');
  fs.writeFileSync(authPath, JSON.stringify({ salt, hash, jwtSecret: 'segredo-de-teste' }, null, 2));

  const config = {
    rootDir: root,
    dataDir,
    host: '127.0.0.1',
    port: 0,
    apiPrefix: '/api/v1',
    corsOrigins: ['*'],
    jwtSecret: 'segredo-de-teste',
    tokenTtlSeconds: 3600,
    maxBodyBytes: 5 * 1024 * 1024,
    authPath,
    version: 'teste'
  };

  // ---------------------------------------------------------------
  // runtime falso: registra chamadas e guarda estado em memoria
  // ---------------------------------------------------------------
  const events = createEventBus();
  const calls = [];
  const state = {
    zaps: [{ id: 'z1', name: 'Zap Teste', enabled: true, autoReply: true, blockedContacts: [] }],
    conversations: {
      z1: [
        {
          chatId: '5511999999999@c.us',
          contact: { id: '5511999999999@c.us', name: 'Maria', number: '5511999999999' },
          lastMessage: { body: 'oi', fromMe: false, timestamp: Math.floor(Date.now() / 1000) },
          messageCount: 3
        },
        {
          chatId: '5511888888888@c.us',
          contact: { id: '5511888888888@c.us', name: 'Joao', number: '5511888888888' },
          lastMessage: { body: 'tudo bem?', fromMe: true, timestamp: Math.floor(Date.now() / 1000) - 60 },
          messageCount: 5
        }
      ]
    },
    logs: [],
    providers: [{ id: 'p1', name: 'Provedor Teste', models: [{ id: 'm1' }] }]
  };

  state.billingStore = new BillingStore({ filePath: path.join(dataDir, 'billing-ledger.json'), logger: { error() {} } });

  function describeZapBilling(zap) {
    return billingCore.describeBilling(zap, new Date(), state.billingStore.snapshot());
  }

  const handlers = {
    'load-zaps': () => state.zaps,
    'save-zaps': (list, opts) => {
      // Mesmo contrato do main.js: lista vazia exige allowEmpty explicito.
      if (!Array.isArray(list) || (list.length === 0 && !(opts && opts.allowEmpty))) return false;
      state.zaps = list;
      return true;
    },
    'whatsapp-conversations': (zapId) => state.conversations[zapId] || [],
    'whatsapp-messages': () => [{ body: 'oi' }],
    'whatsapp-status': (zapId) => ({ status: 'ready', zapId }),
    'whatsapp-connect': (zapId) => ({ ok: true, zapId, method: 'pairing' }),
    'whatsapp-disconnect': (zapId) => ({ ok: true, zapId }),
    'whatsapp-send': () => ({ ok: true }),
    'server-overview': () => ({ ok: true, zaps: state.zaps.length }),
    'server-status': () => ({ ok: true, running: true }),
    'server-power': (running) => ({ ok: true, running }),
    'server-command': (text) => ({ ok: true, output: text }),
    'server-delete-zap-session': () => ({ ok: true }),
    'load-providers': () => state.providers,
    'save-provider': (id, provider) => {
      const saved = { ...provider, id };
      const index = state.providers.findIndex((item) => item.id === id);
      if (index >= 0) state.providers[index] = saved;
      else state.providers.push(saved);
      return saved;
    },
    'delete-provider': (id) => {
      const before = state.providers.length;
      state.providers = state.providers.filter((item) => item.id !== id);
      return state.providers.length !== before;
    },
    'discover-provider-models': (input) => ({ ok: true, models: [{ id: `modelo-${input.name}`, name: 'Modelo real' }] }),
    'test-provider-model': (input) => ({ ok: true, text: `testado ${input.modelId}` }),
    'load-trainings': () => ({}),
    'billing-detail': (zapId) => {
      const zap = state.zaps.find((z) => String(z.id) === String(zapId));
      if (!zap) return { ok: false, error: 'zap nao encontrado' };
      return { ok: true, ...describeZapBilling(zap) };
    },
    'billing-save': (zapId, data) => {
      const zap = state.zaps.find((z) => String(z.id) === String(zapId));
      if (!zap) return { ok: false, error: 'zap nao encontrado' };
      zap.billingPlan = billingCore.normalizeBillingConfig(data, zap.billingPlan || {}, new Date());
      return { ok: true, billingPlan: zap.billingPlan, billing: describeZapBilling(zap) };
    },
    'billing-pay': (zapId, period, paymentSignature) => {
      const zap = state.zaps.find((z) => String(z.id) === String(zapId));
      if (!zap) return { ok: false, error: 'zap nao encontrado' };
      const billing = describeZapBilling(zap);
      const invoice = billing.invoices.find((item) => item.period === period);
      if (!invoice || !invoice.payable || invoice.paid) return { ok: false, error: 'fatura nao elegivel' };
      const result = state.billingStore.appendPayment({ zapId, period, amountCents: invoice.amountCents, currency: invoice.currency, signature: paymentSignature });
      return { ok: true, payment: result.payment, duplicate: result.duplicate, billing: describeZapBilling(zap) };
    },
    'billing-extend': (zapId, period, days, reason, requestId) => {
      const zap = state.zaps.find((z) => String(z.id) === String(zapId));
      if (!zap) return { ok: false, error: 'zap nao encontrado' };
      const billing = describeZapBilling(zap);
      const invoice = billing.invoices.find((item) => item.period === period);
      if (!invoice || invoice.paid) return { ok: false, error: 'fatura nao elegivel' };
      const extension = state.billingStore.appendExtension({
        zapId,
        period,
        days,
        previousGraceEndsAt: invoice.graceEndsAt,
        newGraceEndsAt: new Date(Date.parse(invoice.graceEndsAt) + Number(days) * billingCore.DAY_MS).toISOString(),
        reason,
        requestId
      });
      return { ok: true, extension, billing: describeZapBilling(zap) };
    },
    'billing-overview': () => {
      const subscriptions = state.zaps
        .map((zap) => ({ zap, billing: describeZapBilling(zap) }))
        .filter((item) => item.billing.enabled);
      return {
        ok: true,
        subscriptions,
        totals: {
          active: subscriptions.filter((item) => item.billing.active).length,
          grace: subscriptions.filter((item) => item.billing.status === 'grace').length,
          overdue: subscriptions.filter((item) => item.billing.status === 'overdue').length,
          amountDueCents: subscriptions.reduce((sum, item) => sum + item.billing.arrearsAmountCents, 0)
        },
        items: subscriptions.map((item) => ({ zapId: String(item.zap.id), name: item.zap.name, ...item.billing })),
        total: subscriptions.length
      };
    },
    'server-terminal-logs': () => state.logs
  };

  const runtime = {
    events,
    buildStatusState: () => ({ connects: 1, zaps: state.zaps }),
    hasCommand: (c) => Object.prototype.hasOwnProperty.call(handlers, c),
    invoke: async (command, ...args) => {
      calls.push({ command, args });
      const fn = handlers[command];
      if (!fn) throw new Error(`comando desconhecido: ${command}`);
      return fn(...args);
    }
  };

  const backend = await startBackend({ config, runtime });
  const base = `http://127.0.0.1:${backend.port}/api/v1`;
  let token = '';

  async function api(method, pathname, body, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token && opts.auth !== false) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(base + pathname, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (_) { data = text; }
    return { status: res.status, data };
  }

  // ---------------------------------------------------------------
  // testes
  // ---------------------------------------------------------------
  testAsync('backend: /health responde sem token', async () => {
    const r = await api('GET', '/health', undefined, { auth: false });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.ok, true);
    assert.strictEqual(r.data.service, 'assistente-zap-backend');
    assert.ok(r.data.resources && r.data.resources.ram, 'resources ausente no /health');
    assert.ok(r.data.resources.ram.totalMB > 0, 'RAM total invalida no /health');
    assert.ok(typeof r.data.resources.ram.usedPct === 'number', 'uso de RAM ausente');
    assert.ok(r.data.resources.cpus >= 1, 'numero de CPUs ausente');
  });

  testAsync('backend: rota protegida exige token', async () => {
    const r = await api('GET', '/zaps', undefined, { auth: false });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.data.ok, false);
  });

  testAsync('backend: login com senha errada falha', async () => {
    const r = await api('POST', '/auth/login', { password: 'errada' }, { auth: false });
    assert.strictEqual(r.status, 401);
  });

  testAsync('backend: login com senha correta devolve token', async () => {
    const r = await api('POST', '/auth/login', { password }, { auth: false });
    assert.strictEqual(r.status, 200);
    assert.ok(r.data.token && r.data.token.split('.').length === 3, 'token JWT malformado');
    token = r.data.token;
  });

  testAsync('backend: /me confirma o usuario autenticado', async () => {
    const r = await api('GET', '/me');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.user.role, 'owner');
  });

  testAsync('backend: provedores permitem descoberta, cadastro, teste e exclusao', async () => {
    let r = await api('POST', '/providers/discover', { name: 'Minha API', baseUrl: 'https://api.exemplo.com/v1', apiKey: 'k' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.models[0].id, 'modelo-Minha API');

    r = await api('PUT', '/providers/p2', { provider: { name: 'Novo Provedor', baseUrl: 'https://api.exemplo.com/v1', models: [{ id: 'm2' }] } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.id, 'p2');

    r = await api('POST', '/providers/test', { providerId: 'p2', modelId: 'm2' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.text, 'testado m2');

    r = await api('DELETE', '/providers/p2');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.ok, true);
  });

  testAsync('backend: lista zaps pelo mesmo handler do IPC', async () => {
    const r = await api('GET', '/zaps');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.length, 1);
    assert.strictEqual(r.data[0].id, 'z1');
    assert.ok(calls.some((c) => c.command === 'load-zaps'));
  });

  testAsync('backend: PUT /zaps grava e valida lista vazia', async () => {
    const empty = await api('PUT', '/zaps', []);
    assert.strictEqual(empty.status, 409, 'lista vazia sem allowEmpty deveria falhar');
    const ok = await api('PUT', '/zaps', { zaps: state.zaps, allowEmpty: true });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.data.ok, true);
  });

  testAsync('backend: contatos com status autorizado/bloqueado', async () => {
    const all = await api('GET', '/zaps/z1/contacts');
    assert.strictEqual(all.status, 200);
    assert.strictEqual(all.data.total, 2);
    assert.strictEqual(all.data.contacts[0].status, 'authorized');

    const block = await api('POST', '/zaps/z1/contacts/block', { contactId: '5511999999999@c.us' });
    assert.strictEqual(block.status, 200);
    assert.strictEqual(block.data.blocked, 1);

    const blocked = await api('GET', '/zaps/z1/contacts?status=blocked');
    assert.strictEqual(blocked.data.total, 1);
    assert.strictEqual(blocked.data.contacts[0].name, 'Maria');

    const stats = await api('GET', '/zaps/z1/contacts/stats');
    assert.strictEqual(stats.data.total, 2);
    assert.strictEqual(stats.data.blocked, 1);
    assert.strictEqual(stats.data.authorized, 1);

    const unblock = await api('DELETE', '/zaps/z1/contacts/block/5511999999999%40c.us');
    assert.strictEqual(unblock.status, 200);
    assert.strictEqual(unblock.data.blocked, 0);
  });

  testAsync('backend: responde quem ja respondeu e quem nao', async () => {
    const r = await api('GET', '/zaps/z1/contacts?responded=true');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.total, 1);
    assert.strictEqual(r.data.contacts[0].name, 'Joao');
  });

  testAsync('backend: billing mostra vencimento e aceita pagamento assinado', async () => {
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const put = await api('PUT', '/zaps/z1/billing', { enabled: true, dueDay: 1, graceDays: 15, monthlyAmount: 99, startMonth: month });
    assert.strictEqual(put.status, 200);
    assert.strictEqual(put.data.ok, true);
    const before = await api('GET', '/zaps/z1/billing');
    assert.strictEqual(before.status, 200);
    assert.strictEqual(before.data.dueDay, 1);
    assert.ok(['pending', 'grace', 'overdue', 'paid'].includes(before.data.status));

    const rejected = await api('POST', '/zaps/z1/billing/pay', { period: month });
    assert.strictEqual(rejected.data.ok, false);
    const pay = await api('POST', '/zaps/z1/billing/pay', { period: month, signature });
    assert.strictEqual(pay.status, 200);
    assert.strictEqual(pay.data.ok, true, pay.data.error);
    assert.strictEqual(pay.data.billing.status, 'paid');
    assert.strictEqual(pay.data.billing.active, true);
    assert.strictEqual(pay.data.payment.signature, signature);

    const overview = await api('GET', '/billing/overview');
    assert.strictEqual(overview.status, 200);
    assert.strictEqual(overview.data.total, 1);
    assert.strictEqual(overview.data.subscriptions[0].billing.payments.length, 1);
  });

  testAsync('backend: /server/status inclui os zaps para o painel', async () => {
    const r = await api('GET', '/server/status');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.ok, true);
    assert.strictEqual(r.data.running, true, 'deve manter os campos do handler server-status');
    assert.ok(Array.isArray(r.data.zaps), 'zaps ausentes no server/status');
    assert.strictEqual(r.data.zaps[0].id, 'z1');
    assert.ok(r.data.resources && r.data.resources.ram.totalMB > 0, 'resources ausente no server/status');
    assert.ok(r.data.resources.swap && typeof r.data.resources.swap.usedMB === 'number', 'swap ausente no server/status');
  });

  testAsync('backend: /status traz o estado do runtime', async () => {
    const r = await api('GET', '/status');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.ok, true);
    assert.strictEqual(r.data.connects, 1);
    assert.strictEqual(r.data.zaps.length, 1);
  });

  testAsync('backend: logs usam o terminal do runtime', async () => {
    state.logs = [{ msg: 'linha 1' }, { msg: 'linha 2' }];
    const r = await api('GET', '/logs?limit=1');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.lines.length, 1);
    assert.strictEqual(r.data.lines[0].msg, 'linha 2');
  });

  testAsync('backend: WebSocket entrega evento ao vivo', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${backend.port}/ws?token=${token}`);
    const messages = [];
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout no ws')), 4000);
      ws.on('message', (buf) => {
        const msg = JSON.parse(String(buf));
        messages.push(msg);
        if (messages.length === 1) {
          assert.strictEqual(msg.event, 'hello');
          events.emit('whatsapp-status', { zapId: 'z1', status: 'ready' });
        } else if (msg.event === 'whatsapp-status') {
          clearTimeout(timer);
          resolve();
        }
      });
      ws.on('error', reject);
    });
    const statusEvent = messages.find((m) => m.event === 'whatsapp-status');
    assert.ok(statusEvent, 'evento de status nao chegou');
    assert.strictEqual(statusEvent.data.zapId, 'z1');
    ws.close();
  });

  testAsync('backend: WebSocket sem token e recusado', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${backend.port}/ws`);
    const result = await new Promise((resolve) => {
      ws.on('open', () => resolve('abriu'));
      ws.on('error', () => resolve('recusado'));
      ws.on('unexpected-response', () => resolve('recusado'));
    });
    assert.strictEqual(result, 'recusado');
    try { ws.terminate(); } catch (_) {}
  });

  testAsync('backend: cliente remoto faz login e le os zaps', async () => {
    let saved = '';
    const client = createRemoteApi({
      baseUrl: `http://127.0.0.1:${backend.port}`,
      apiPrefix: '/api/v1',
      tokenStore: { get: () => saved, set: (v) => { saved = v; } }
    });
    const login = await client.login(password);
    assert.ok(login.token, 'cliente nao recebeu token');
    assert.strictEqual(saved, login.token);

    const zaps = await client.loadZaps();
    assert.strictEqual(zaps.length, 1);
    assert.strictEqual(zaps[0].id, 'z1');

    const status = await client.whatsappStatus('z1');
    assert.strictEqual(status.status, 'ready');

    client.logout();
    assert.strictEqual(saved, '');
  });

  testAsync('backend: cliente remoto escuta eventos pelo WebSocket', async () => {
    let saved = token;
    const client = createRemoteApi({
      baseUrl: `http://127.0.0.1:${backend.port}`,
      apiPrefix: '/api/v1',
      tokenStore: { get: () => saved, set: (v) => { saved = v; } }
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout no ws do cliente')), 4000);
      client.onConnectionChange((state) => {
        if (state && state.connected) {
          clearTimeout(timer);
          resolve();
        }
      });
      client.connectEvents();
    });
    const received = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('evento nao chegou no cliente')), 4000);
      client.onWhatsAppStatus((data) => {
        clearTimeout(timer);
        resolve(data);
      });
    });
    events.emit('whatsapp-status', { zapId: 'z9', status: 'ready' });
    const data = await received;
    assert.strictEqual(data.zapId, 'z9');
    client._events.stop();
  });

  // ---------------------------------------------------------------
  while (pending.length) {
    const t = pending.shift();
    try {
      await t.fn();
      passed++;
      out(`ok - ${t.name}`);
    } catch (e) {
      failures.push({ name: t.name, error: (e && e.stack) || String(e) });
      out(`FAIL - ${t.name}`);
      out(`      ${e && e.message ? e.message : e}`);
    }
  }

  await backend.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}

  out('');
  if (failures.length) {
    out(`${failures.length} FALHA(S):`);
    for (const f of failures) out(`  - ${f.name}\n      ${f.error}`);
    process.exit(1);
  }
  out(`${passed} teste(s) passaram`);
  out('TODOS OS TESTES PASSARAM');
  process.exit(0);
}

main().catch((e) => {
  console.error('ERRO FATAL NO TESTE:', e);
  process.exit(1);
});
