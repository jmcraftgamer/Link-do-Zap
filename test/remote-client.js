// Testes do cliente remoto (Setup -> VPS).
//
// Cobre tres camadas:
//  1. createRemoteApi: contrato de metodos, rotas HTTP, token e eventos (com
//     cliente HTTP e socket injetados, sem rede).
//  2. createHttpClient: requisicao real contra um servidor local efemero
//     (headers, JSON, 401, erros HTTP e servidor nao configurado).
//  3. createEventSocket: conexao, mensagens, reconexao e parada (com
//     WebSocket e timers falsos, sem rede).
const assert = require('assert');
const http = require('http');
const { createRemoteApi, createHttpClient, createEventSocket, trimSlash, TIMEOUTS } =
  require('../src/js/api-client');

const pending = [];
let passed = 0;
const failures = [];
const realLog = console.log;
const out = (...a) => realLog(...a);
function test(name, fn) { pending.push({ name, fn }); }
function testAsync(name, fn) { pending.push({ name, fn, async: true }); }

// ---------------------------------------------------------------------------
// dublês
// ---------------------------------------------------------------------------
function createTokenStore(initial = '') {
  let token = initial;
  return {
    get: () => token,
    set: (v) => { token = v; },
    peek: () => token
  };
}

function createFakeHttp() {
  const calls = [];
  const callOptions = [];
  const httpStub = {
    calls,
    callOptions,
    request(method, path, body, opts) {
      calls.push({ method, path, body });
      callOptions.push({ method, path, opts });
      if (method === 'GET' && path === '/api/v1/me' && httpStub.meFails) {
        const err = new Error('nao autorizado');
        err.status = 401;
        return Promise.reject(err);
      }
      if (method === 'POST' && path === '/api/v1/auth/login') {
        if (!body || body.password !== 'senha') {
          const err = new Error('senha invalida');
          err.status = 401;
          return Promise.reject(err);
        }
        return Promise.resolve({ ok: true, token: 'tok-1', expiresIn: 3600 });
      }
      if (method === 'GET' && path === '/api/v1/zaps') return Promise.resolve([{ id: 'z1', name: 'Zap' }]);
      if (method === 'GET' && path === '/api/v1/providers') return Promise.resolve([{ id: 'p1' }]);
      if (method === 'GET' && path === '/api/v1/trainings') return Promise.resolve({ z1: [] });
      if (method === 'GET' && (path === '/api/v1/logs' || path.startsWith('/api/v1/logs?'))) {
        return Promise.resolve({ lines: [{ msg: 'linha' }] });
      }
      if (method === 'GET' && path === '/api/v1/zaps/z1/status') {
        return Promise.resolve({ status: 'ready', zapId: 'z1' });
      }
      if (method === 'GET' && path === '/api/v1/zaps/z1/conversations') {
        return Promise.resolve([{ chatId: 'x@c.us' }]);
      }
      if (method === 'GET' && path.endsWith('/history?limit=50')) {
        return Promise.resolve({ messages: [{ body: 'oi' }] });
      }
      if (method === 'GET' && path === '/api/v1/zaps/z1/billing') {
        return Promise.resolve({ dueDay: 10, status: 'paid' });
      }
      if (method === 'GET' && path === '/api/v1/server/overview') {
        return Promise.resolve({ running: true, zaps: 1 });
      }
      if (method === 'GET' && path === '/api/v1/server/status') {
        return Promise.resolve({ ok: true, running: true });
      }
      if (method === 'POST' && path === '/api/v1/zaps/z1/conversations/x%40c.us/active') {
        return Promise.reject(new Error('sem conexao'));
      }
      return Promise.resolve({ ok: true });
    }
  };
  httpStub.get = (p, o) => httpStub.request('GET', p, undefined, o);
  httpStub.post = (p, b, o) => httpStub.request('POST', p, b === undefined ? {} : b, o);
  httpStub.put = (p, b, o) => httpStub.request('PUT', p, b === undefined ? {} : b, o);
  httpStub.patch = (p, b, o) => httpStub.request('PATCH', p, b === undefined ? {} : b, o);
  httpStub.del = (p, o) => httpStub.request('DELETE', p, undefined, o);
  return httpStub;
}

function createFakeEvents() {
  const listeners = new Map();
  const state = { started: 0, stopped: 0, open: false, sent: [] };
  const bus = {
    state,
    listeners,
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(cb);
      return () => listeners.get(event).delete(cb);
    },
    start() { state.started++; state.open = true; },
    stop() { state.stopped++; state.open = false; },
    isOpen: () => state.open,
    send(command, payload, id) { state.sent.push({ command, payload, id }); return true; },
    emit(event, data) {
      const set = listeners.get(event);
      if (set) for (const cb of [...set]) cb(data);
    }
  };
  return bus;
}

function makeRemote(tokenStore) {
  const httpStub = createFakeHttp();
  const events = createFakeEvents();
  const remote = createRemoteApi({
    baseUrl: 'http://127.0.0.1:39123',
    apiPrefix: '/api/v1',
    tokenStore,
    httpClient: httpStub,
    eventSocket: events
  });
  return { remote, httpStub, events };
}

function lastCall(httpStub) {
  return httpStub.calls[httpStub.calls.length - 1];
}

function fakeTimers() {
  let next = 1;
  const timers = new Map();
  return {
    setTimeout(fn, ms) {
      const id = next++;
      timers.set(id, { fn, ms });
      return { id, unref() {} };
    },
    clearTimeout(timer) {
      if (timer && timer.id) timers.delete(timer.id);
    },
    runAll() {
      const all = [...timers.values()];
      timers.clear();
      for (const t of all) t.fn();
    },
    count: () => timers.size
  };
}

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.handlers = {};
    FakeWebSocket.instances.push(this);
  }
  on(event, cb) { this.handlers[event] = cb; }
  emit(event, arg) { if (this.handlers[event]) this.handlers[event](arg); }
  open() { this.readyState = 1; this.emit('open'); }
  message(obj) { this.emit('message', Buffer.from(JSON.stringify(obj))); }
  close() { this.readyState = 3; this.emit('close'); }
  send() {}
}
FakeWebSocket.instances = [];

// ---------------------------------------------------------------------------
async function main() {
  // =========================================================================
  // 1. createRemoteApi
  // =========================================================================
  test('cliente remoto: identificacao e URL', () => {
    const tokenStore = createTokenStore();
    const { remote } = makeRemote(tokenStore);
    assert.strictEqual(remote.isRemoteMode, true);
    assert.strictEqual(remote.getServerUrl(), 'http://127.0.0.1:39123');
    assert.strictEqual(remote.hasToken(), false);
  });

  test('cliente remoto: setServerUrl normaliza e limpa o token', () => {
    const tokenStore = createTokenStore('tok-antigo');
    const { remote, events } = makeRemote(tokenStore);
    const url = remote.setServerUrl('http://vps.exemplo.com:8080///');
    assert.strictEqual(url, 'http://vps.exemplo.com:8080');
    assert.strictEqual(remote.getServerUrl(), 'http://vps.exemplo.com:8080');
    assert.strictEqual(tokenStore.peek(), '');
    assert.ok(events.state.started >= 1, 'socket deveria reiniciar');
    assert.ok(events.state.stopped >= 1, 'socket deveria parar antes de reiniciar');
  });

  testAsync('cliente remoto: login com senha errada falha', async () => {
    const { remote } = makeRemote(createTokenStore());
    await assert.rejects(() => remote.login('errada'), /senha invalida/);
  });

  testAsync('cliente remoto: login guarda token e abre eventos', async () => {
    const tokenStore = createTokenStore();
    const { remote, httpStub, events } = makeRemote(tokenStore);
    const before = events.state.started;
    const res = await remote.login('senha');
    assert.strictEqual(res.token, 'tok-1');
    assert.strictEqual(tokenStore.peek(), 'tok-1');
    assert.strictEqual(remote.hasToken(), true);
    assert.strictEqual(lastCall(httpStub).path, '/api/v1/auth/login');
    assert.deepStrictEqual(lastCall(httpStub).body, { password: 'senha' });
    assert.ok(events.state.started > before, 'socket deveria abrir apos login');
  });

  testAsync('cliente remoto: logout limpa token e fecha eventos', async () => {
    const tokenStore = createTokenStore();
    const { remote, events } = makeRemote(tokenStore);
    await remote.login('senha');
    remote.logout();
    assert.strictEqual(tokenStore.peek(), '');
    assert.strictEqual(remote.hasToken(), false);
    assert.strictEqual(events.state.open, false);
  });

  testAsync('cliente remoto: /me e /health usam o prefixo certo', async () => {
    const { remote, httpStub } = makeRemote(createTokenStore('tok-1'));
    await remote.me();
    assert.deepStrictEqual(lastCall(httpStub), { method: 'GET', path: '/api/v1/me', body: undefined });
    await remote.health();
    assert.deepStrictEqual(lastCall(httpStub), { method: 'GET', path: '/health', body: undefined });
  });

  testAsync('cliente remoto: timeouts por tipo de operacao', async () => {
    const { remote, httpStub } = makeRemote(createTokenStore('tok-1'));

    assert.strictEqual(TIMEOUTS.defaultMs, 120000);
    assert.strictEqual(TIMEOUTS.heavyMs, 180000);
    assert.strictEqual(TIMEOUTS.healthMs, 8000);

    await remote.health();
    assert.strictEqual(httpStub.callOptions.at(-1).opts.timeoutMs, TIMEOUTS.healthMs);

    await remote.agentChat({ action: 'status' });
    assert.strictEqual(httpStub.callOptions.at(-1).opts.timeoutMs, TIMEOUTS.heavyMs);

    await remote.autoMsgChat({ zapId: 'z1', message: 'oi' });
    assert.strictEqual(httpStub.callOptions.at(-1).opts.timeoutMs, TIMEOUTS.heavyMs);

    await remote.autoMsgTranscribe('base64', 'z1');
    assert.strictEqual(httpStub.callOptions.at(-1).opts.timeoutMs, TIMEOUTS.heavyMs);

    await remote.whatsappSend('z1', '5511@c.us', 'oi');
    assert.strictEqual(httpStub.callOptions.at(-1).opts.timeoutMs, TIMEOUTS.heavyMs);

    await remote.whatsappSendMedia('z1', '5511@c.us', { data: 'x' });
    assert.strictEqual(httpStub.callOptions.at(-1).opts.timeoutMs, TIMEOUTS.heavyMs);

    // Operacoes comuns usam o timeout padrao do httpClient (120s).
    await remote.loadZaps();
    assert.strictEqual(httpStub.callOptions.at(-1).opts, undefined);
  });

  testAsync('cliente remoto: zaps com id codificado na rota', async () => {
    const { remote, httpStub } = makeRemote(createTokenStore('tok-1'));
    await remote.whatsappConnect('zap 1', '5511999999999');
    assert.strictEqual(lastCall(httpStub).path, '/api/v1/zaps/zap%201/connect');
    assert.deepStrictEqual(lastCall(httpStub).body, { phone: '5511999999999', method: undefined });

    await remote.whatsappDisconnect('z1');
    assert.strictEqual(lastCall(httpStub).path, '/api/v1/zaps/z1/disconnect');

    await remote.whatsappStatus('z1');
    assert.deepStrictEqual(lastCall(httpStub), { method: 'GET', path: '/api/v1/zaps/z1/status', body: undefined });
  });

  testAsync('cliente remoto: envio de texto e midia', async () => {
    const { remote, httpStub } = makeRemote(createTokenStore('tok-1'));
    await remote.whatsappSend('z1', '5511@c.us', 'oi');
    assert.deepStrictEqual(lastCall(httpStub).body, { phone: '5511@c.us', chatId: '5511@c.us', text: 'oi' });

    await remote.whatsappSend('z1', '5511@c.us', 'oi', 'outro@c.us');
    assert.deepStrictEqual(lastCall(httpStub).body, { phone: '5511@c.us', chatId: 'outro@c.us', text: 'oi' });

    const media = { data: 'x', mimeType: 'image/jpeg', name: 'f.jpg' };
    await remote.whatsappSendMedia('z1', '5511@c.us', media);
    assert.strictEqual(lastCall(httpStub).path, '/api/v1/zaps/z1/send-media');
    assert.deepStrictEqual(lastCall(httpStub).body, { phone: '5511@c.us', media });
  });

  testAsync('cliente remoto: conversas, historico e midia', async () => {
    const { remote, httpStub } = makeRemote(createTokenStore('tok-1'));
    const convs = await remote.whatsappConversations('z1');
    assert.deepStrictEqual(convs, [{ chatId: 'x@c.us' }]);

    await remote.whatsappMessages('z1', 'x@c.us');
    assert.strictEqual(lastCall(httpStub).path, '/api/v1/zaps/z1/conversations/x%40c.us/messages');

    await remote.whatsappChatHistory('z1', 'x@c.us');
    assert.strictEqual(lastCall(httpStub).path, '/api/v1/zaps/z1/conversations/x%40c.us/history?limit=50');

    await remote.whatsappChatHistory('z1', 'x@c.us', 200);
    assert.strictEqual(lastCall(httpStub).path, '/api/v1/zaps/z1/conversations/x%40c.us/history?limit=200');

    await remote.whatsappChatMedia('z1', 'x@c.us', 'msg 1', 'image');
    assert.strictEqual(
      lastCall(httpStub).path,
      '/api/v1/zaps/z1/conversations/x%40c.us/media/msg%201?hint=image'
    );
  });

  testAsync('cliente remoto: marcar conversa ativa nao quebra sem conexao', async () => {
    const { remote } = makeRemote(createTokenStore('tok-1'));
    const res = await remote.whatsappSetActiveChat('z1', 'x@c.us');
    assert.deepStrictEqual(res, {});
  });

  testAsync('cliente remoto: bloqueio em massa aceita id ou objeto', async () => {
    const { remote, httpStub } = makeRemote(createTokenStore('tok-1'));
    await remote.zapBlockAllExisting({ id: 'z1' });
    assert.strictEqual(lastCall(httpStub).path, '/api/v1/zaps/z1/contacts/block-all-existing');
    await remote.zapBlockAllExisting('z2');
    assert.strictEqual(lastCall(httpStub).path, '/api/v1/zaps/z2/contacts/block-all-existing');
  });

  testAsync('cliente remoto: servidor, energia e terminal', async () => {
    const { remote, httpStub } = makeRemote(createTokenStore('tok-1'));

    const info = await remote.serverInfo();
    assert.strictEqual(info.mode, 'remote');
    assert.strictEqual(info.url, 'http://127.0.0.1:39123');

    await remote.serverPower(true);
    assert.deepStrictEqual(lastCall(httpStub), { method: 'POST', path: '/api/v1/server/power', body: { running: true } });

    await remote.serverOverview();
    assert.strictEqual(lastCall(httpStub).path, '/api/v1/server/overview');

    await remote.serverDeleteZapSession('z1');
    assert.deepStrictEqual(lastCall(httpStub), { method: 'DELETE', path: '/api/v1/zaps/z1/session', body: undefined });

    await remote.serverCurrentQr('z1');
    assert.strictEqual(lastCall(httpStub).path, '/api/v1/zaps/z1/qr');

    await remote.serverPairingCodes();
    await remote.serverConfigPick();
    await remote.serverRelaunch();
    assert.strictEqual(lastCall(httpStub).path, '/api/v1/zaps/z1/qr', 'metodos locais nao devem chamar a rede');

    const logs = await remote.serverTerminalLogs();
    assert.deepStrictEqual(logs, [{ msg: 'linha' }]);
    assert.strictEqual(lastCall(httpStub).path, '/api/v1/logs');

    const exported = await remote.serverTerminalExport();
    assert.deepStrictEqual(exported, [{ msg: 'linha' }]);
    assert.strictEqual(lastCall(httpStub).path, '/api/v1/logs?limit=5000');

    await remote.serverTerminalClear();
    assert.deepStrictEqual(lastCall(httpStub), { method: 'DELETE', path: '/api/v1/logs', body: undefined });

    await remote.serverCommand('status');
    assert.deepStrictEqual(lastCall(httpStub), { method: 'POST', path: '/api/v1/commands', body: { command: 'status' } });
  });

  testAsync('cliente remoto: mensagem automatica e agente', async () => {
    const { remote, httpStub } = makeRemote(createTokenStore('tok-1'));

    await remote.autoMsgState();
    assert.strictEqual(lastCall(httpStub).path, '/api/v1/auto-message/state');

    await remote.autoMsgChat({ zapId: 'z1', message: 'oi' });
    assert.deepStrictEqual(lastCall(httpStub), {
      method: 'POST',
      path: '/api/v1/auto-message/chat',
      body: { zapId: 'z1', message: 'oi' }
    });

    await remote.autoMsgStop();
    assert.deepStrictEqual(lastCall(httpStub), { method: 'POST', path: '/api/v1/auto-message/stop', body: {} });

    await remote.autoMsgNote('z1', 'nota');
    assert.deepStrictEqual(lastCall(httpStub).body, { zapId: 'z1', text: 'nota' });

    await remote.autoMsgTranscribe({ data: 'x' }, 'z1');
    assert.deepStrictEqual(lastCall(httpStub).body, { audio: { data: 'x' }, zapId: 'z1' });

    await remote.agentChat({ action: 'status' });
    assert.deepStrictEqual(lastCall(httpStub), {
      method: 'POST',
      path: '/api/v1/agent/chat',
      body: { action: 'status' }
    });
  });

  testAsync('cliente remoto: dados (zaps, billing, providers, trainings)', async () => {
    const { remote, httpStub } = makeRemote(createTokenStore('tok-1'));

    const zaps = await remote.loadZaps();
    assert.ok(Array.isArray(zaps));
    assert.strictEqual(zaps[0].id, 'z1');

    const saved = await remote.saveZaps([{ id: 'z1' }], { allowEmpty: false });
    assert.strictEqual(saved.ok, true);
    assert.deepStrictEqual(lastCall(httpStub), {
      method: 'PUT',
      path: '/api/v1/zaps',
      body: { zaps: [{ id: 'z1' }], allowEmpty: false }
    });

    await remote.billingSave('z1', { dueDay: 10 });
    assert.deepStrictEqual(lastCall(httpStub), {
      method: 'PUT',
      path: '/api/v1/zaps/z1/billing',
      body: { dueDay: 10 }
    });

    const billing = await remote.billingCheck('z1');
    assert.strictEqual(billing.dueDay, 10);

    const providers = await remote.loadProviders();
    assert.deepStrictEqual(providers, [{ id: 'p1' }]);

    await remote.saveProviders([]);
    assert.deepStrictEqual(lastCall(httpStub).body, { providers: [] });

    const trainings = await remote.loadTrainings();
    assert.deepStrictEqual(trainings, { z1: [] });

    await remote.saveTrainings({ z1: [] }, ['a.txt']);
    assert.deepStrictEqual(lastCall(httpStub).body, { trainings: { z1: [] }, deletedFiles: ['a.txt'] });

    await remote.deleteTrainingsForZap('z1');
    assert.deepStrictEqual(lastCall(httpStub), { method: 'DELETE', path: '/api/v1/zaps/z1/trainings', body: undefined });
  });

  testAsync('cliente remoto: assinaturas usam os mesmos canais do IPC', async () => {
    const { remote, events } = makeRemote(createTokenStore('tok-1'));
    const seen = [];
    const off = remote.onWhatsAppStatus((d) => seen.push(d));
    assert.strictEqual(events.state.open, true, 'assinar deveria abrir o socket');
    events.emit('whatsapp-status', { zapId: 'z1' });
    off();
    events.emit('whatsapp-status', { zapId: 'z2' });
    assert.deepStrictEqual(seen, [{ zapId: 'z1' }]);

    const channels = [
      ['onWhatsAppPairingCode', 'whatsapp-pairing-code'],
      ['onWhatsAppMessage', 'whatsapp-message'],
      ['onWhatsAppTyping', 'whatsapp-typing'],
      ['onWhatsAppLog', 'whatsapp-log'],
      ['onWhatsAppContactsUpdated', 'whatsapp-contacts-updated'],
      ['onServerTerminalLog', 'server-terminal-log'],
      ['onServerTerminalCleared', 'server-terminal-cleared'],
      ['onServerPowerUpdated', 'server-power-updated'],
      ['onAutoMsgLog', 'auto-msg-log'],
      ['onAutoMsgUpdate', 'auto-msg-update'],
      ['onConnectionChange', 'connection'],
      ['onAuthExpired', 'auth-expired']
    ];
    assert.strictEqual(typeof remote.connectEvents, 'function');
    for (const [method, channel] of channels) {
      let got = null;
      const unsubscribe = remote[method]((d) => { got = d; });
      events.emit(channel, { channel });
      assert.deepStrictEqual(got, { channel }, `${method} nao escutou ${channel}`);
      unsubscribe();
    }
  });

  // =========================================================================
  // 2. createHttpClient (servidor local real)
  // =========================================================================
  let received = null;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      received = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: raw ? JSON.parse(raw) : null
      };
      if (req.url === '/api/v1/auth/login' && received.body && received.body.password === 'errada') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'senha invalida' }));
      }
      if (req.url === '/api/v1/me' && req.headers.authorization !== 'Bearer tok-ok') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'token invalido' }));
      }
      if (req.url === '/api/v1/falha') {
        res.writeHead(422, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'dados invalidos' }));
      }
      if (req.url === '/api/v1/vazio') {
        res.writeHead(204);
        return res.end();
      }
      if (req.url === '/api/v1/texto') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('ok');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, echo: received.body }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  testAsync('http client: envia JSON, token e content-type', async () => {
    let token = 'tok-ok';
    const client = createHttpClient({
      getBaseUrl: () => baseUrl,
      getToken: () => token
    });
    const res = await client.post('/api/v1/eco', { a: 1 });
    assert.deepStrictEqual(res, { ok: true, echo: { a: 1 } });
    assert.strictEqual(received.method, 'POST');
    assert.strictEqual(received.headers.authorization, 'Bearer tok-ok');
    assert.strictEqual(received.headers.accept, 'application/json');
    assert.ok(String(received.headers['content-type']).includes('application/json'));

    token = '';
    await client.get('/api/v1/eco');
    assert.strictEqual(received.headers.authorization, undefined, 'sem token nao deve mandar Authorization');
  });

  testAsync('http client: 401 dispara onUnauthorized com status', async () => {
    let unauthorized = 0;
    const client = createHttpClient({
      getBaseUrl: () => baseUrl,
      getToken: () => 'tok-errado',
      onUnauthorized: () => { unauthorized++; }
    });
    await assert.rejects(() => client.get('/api/v1/me'), (err) => {
      assert.strictEqual(err.status, 401);
      assert.strictEqual(err.message, 'token invalido');
      assert.deepStrictEqual(err.body, { ok: false, error: 'token invalido' });
      return true;
    });
    assert.strictEqual(unauthorized, 1);
  });

  testAsync('cliente remoto: 401 em /me limpa token e emite auth-expired', async () => {
    const tokenStore = createTokenStore('tok-errado');
    const events = createFakeEvents();
    const remote = createRemoteApi({
      baseUrl, apiPrefix: '/api/v1', tokenStore, eventSocket: events
    });
    let expired = 0;
    remote.onAuthExpired(() => { expired++; });
    await assert.rejects(() => remote.me(), (err) => {
      assert.strictEqual(err.status, 401);
      return true;
    });
    assert.strictEqual(tokenStore.peek(), '', 'token invalido deveria ser apagado');
    assert.strictEqual(expired, 1, 'gate deveria ser avisado uma vez');
  });

  testAsync('cliente remoto: senha errada nao emite auth-expired', async () => {
    const tokenStore = createTokenStore('');
    const events = createFakeEvents();
    const remote = createRemoteApi({
      baseUrl, apiPrefix: '/api/v1', tokenStore, eventSocket: events
    });
    let expired = 0;
    remote.onAuthExpired(() => { expired++; });
    await assert.rejects(() => remote.login('errada'), /senha invalida/);
    assert.strictEqual(expired, 0, '401 do login e senha errada, nao sessao expirada');
  });

  testAsync('http client: erro HTTP traz status e corpo', async () => {    const client = createHttpClient({ getBaseUrl: () => baseUrl, getToken: () => '' });
    await assert.rejects(() => client.get('/api/v1/falha'), (err) => {
      assert.strictEqual(err.status, 422);
      assert.strictEqual(err.message, 'dados invalidos');
      return true;
    });
  });

  testAsync('http client: corpo vazio e texto puro', async () => {
    const client = createHttpClient({ getBaseUrl: () => baseUrl, getToken: () => '' });
    assert.strictEqual(await client.del('/api/v1/vazio'), null);
    assert.strictEqual(await client.get('/api/v1/texto'), 'ok');
  });

  testAsync('http client: servidor nao configurado falha', async () => {
    const client = createHttpClient({ getBaseUrl: () => '', getToken: () => '' });
    await assert.rejects(() => client.get('/api/v1/zaps'), /servidor nao configurado/);
  });

  // =========================================================================
  // 3. createEventSocket (WebSocket e timers falsos)
  // =========================================================================
  test('event socket: conecta com token e emite eventos', () => {
    FakeWebSocket.instances = [];
    const timers = fakeTimers();
    const socket = createEventSocket({
      getBaseUrl: () => 'http://127.0.0.1:39123',
      getToken: () => 'tok-1',
      WebSocket: FakeWebSocket,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout
    });

    const got = [];
    socket.on('connection', (d) => got.push(['connection', d]));
    socket.on('whatsapp-status', (d) => got.push(['status', d]));
    socket.on('*', (event, data) => got.push(['*', event, data]));

    socket.start();
    assert.strictEqual(FakeWebSocket.instances.length, 1);
    assert.strictEqual(
      FakeWebSocket.instances[0].url,
      'ws://127.0.0.1:39123/ws?token=tok-1'
    );

    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.message({ event: 'whatsapp-status', data: { zapId: 'z1' } });
    assert.ok(got.some((g) => g[0] === 'connection' && g[1].connected === true), 'faltou evento connection');
    assert.ok(got.some((g) => g[0] === 'status' && g[1].zapId === 'z1'), 'faltou evento de status');
    assert.ok(
      got.some((g) => g[0] === '*' && g[1] === 'whatsapp-status' && g[2].zapId === 'z1'),
      'faltou o listener coringa'
    );

    assert.strictEqual(socket.isOpen(), true);
    assert.strictEqual(socket.send('x', { a: 1 }, 7), true);
  });

  test('event socket: usa wss em servidor https', () => {
    FakeWebSocket.instances = [];
    const timers = fakeTimers();
    const socket = createEventSocket({
      getBaseUrl: () => 'https://vps.exemplo.com',
      getToken: () => '',
      WebSocket: FakeWebSocket,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout
    });
    socket.start();
    assert.strictEqual(FakeWebSocket.instances[0].url, 'wss://vps.exemplo.com/ws');
    socket.stop();
  });

  test('event socket: reconecta ao cair e para quando pedido', () => {
    FakeWebSocket.instances = [];
    const timers = fakeTimers();
    const socket = createEventSocket({
      getBaseUrl: () => 'http://127.0.0.1:39123',
      getToken: () => '',
      WebSocket: FakeWebSocket,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout
    });
    const states = [];
    socket.on('connection', (d) => states.push(d.connected));

    socket.start();
    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].close();
    assert.deepStrictEqual(states, [true, false]);
    assert.strictEqual(timers.count(), 1, 'deveria agendar reconexao');

    timers.runAll();
    assert.strictEqual(FakeWebSocket.instances.length, 2, 'deveria abrir novo socket');

    socket.stop();
    assert.strictEqual(timers.count(), 0);
    assert.strictEqual(socket.send('x'), false);
  });

  test('trimSlash remove barras finais', () => {
    assert.strictEqual(trimSlash('http://x///'), 'http://x');
    assert.strictEqual(trimSlash('http://x'), 'http://x');
    assert.strictEqual(trimSlash(''), '');
    assert.strictEqual(trimSlash(undefined), '');
  });

  // -------------------------------------------------------------------------
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

  await new Promise((resolve) => server.close(resolve));

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
