// Portabilidade Linux + servidor HTTP de status/QR.
// Tudo offline: nenhum acesso a rede, nenhum celular, nenhum Electron real.
// Cobre: LINK_DATA_DIR, modo HEADLESS (sem janela), servidor HTTP
// (/ , /status, /qr, /logs, token) e guarda contra caminhos Windows fixos.
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const Module = require('module');

const root = path.join(__dirname, '..');
const pending = [];
let passed = 0;
const failures = [];
const realLog = console.log;
const out = (...a) => realLog(...a);

function test(name, fn) { pending.push({ name, fn }); }
function testAsync(name, fn) { pending.push({ name, fn }); }

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) return resolve();
    server.close(() => resolve());
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  // ---------------------------------------------------------------
  // 1) pasta de dados temporaria + env de servidor
  // ---------------------------------------------------------------
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zap-linux-'));
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'zaps.json'), JSON.stringify([
    { id: 'zap1', name: 'Teste Linux', enabled: true, autoReply: true },
    { id: 'zap2', name: 'Desligado', enabled: false, autoReply: false }
  ], null, 2));
  fs.writeFileSync(path.join(dataDir, 'providers.json'), JSON.stringify([
    { id: 'g1', name: 'Google AI Studio', apiKeys: ['k'], models: [{ id: 'gemini-a' }] }
  ], null, 2));
  fs.mkdirSync(path.join(dataDir, 'sessions', 'zap1'), { recursive: true });

  process.env.LINK_DATA_DIR = dataDir;
  process.env.HEADLESS = '1';
  process.env.LINK_HTTP_HOST = '127.0.0.1';
  process.env.LINK_HTTP_PORT = String(await freePort());

  // ---------------------------------------------------------------
  // 2) WhatsAppManager real (antes do stub do main.js)
  // ---------------------------------------------------------------
  const RealWM = require(path.join(root, 'src', 'js', 'whatsapp-manager'));

  test('linux: WhatsAppManager guarda dados em LINK_DATA_DIR', () => {
    const wm = new RealWM(null);
    assert.strictEqual(wm._baseDir, dataDir);
    assert.ok(fs.existsSync(dataDir), 'pasta de dados nao existe');
  });

  test('linux: getQrString e listConnectionStates expoe o estado', () => {
    const wm = new RealWM(null);
    assert.strictEqual(wm.getQrString('zap1'), null);
    wm.clients.set('zap1', { status: 'connecting', qrCode: 'QR-TESTE-123', method: 'qrcode', phoneNumber: '5511999999999' });
    assert.strictEqual(wm.getQrString('zap1'), 'QR-TESTE-123');
    assert.strictEqual(wm.getQrString('inexistente'), null);
    const list = wm.listConnectionStates();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].id, 'zap1');
    assert.strictEqual(list[0].qrPending, true);
    assert.strictEqual(list[0].status, 'connecting');
  });

  // ---------------------------------------------------------------
  // 3) servidor de status (modulo puro)
  // ---------------------------------------------------------------
  const { createStatusServer } = require(path.join(root, 'src', 'js', 'status-server'));

  testAsync('linux: servidor responde /, /status, /logs, /qr e 404', async () => {
    const srv = createStatusServer({
      getState: () => ({ ok: true, zaps: [{ id: 'z1', name: 'Loja', status: 'ready' }] }),
      getQr: (id) => (id === 'z1' ? 'conteudo-do-qr' : null),
      getLogs: () => ['linha1', 'linha2']
    });
    const port = await listen(srv, 0);
    const base = `http://127.0.0.1:${port}`;

    const st = await (await fetch(`${base}/status`)).json();
    assert.strictEqual(st.ok, true);
    assert.strictEqual(st.zaps[0].name, 'Loja');

    const homeRes = await fetch(`${base}/`);
    assert.strictEqual(homeRes.status, 200);
    const html = await homeRes.text();
    assert.ok(html.includes('Assistente do Zap'), 'titulo ausente na pagina');
    assert.ok(html.includes('Loja'), 'zap ausente na pagina');

    const logs = await (await fetch(`${base}/logs`)).json();
    assert.deepStrictEqual(logs.lines, ['linha1', 'linha2']);

    const qrRes = await fetch(`${base}/qr?zap=z1`);
    assert.strictEqual(qrRes.status, 200);
    assert.ok((qrRes.headers.get('content-type') || '').includes('image/png'), 'content-type do QR nao e image/png');
    const png = Buffer.from(await qrRes.arrayBuffer());
    assert.strictEqual(png.toString('ascii', 1, 4), 'PNG', 'resposta do QR nao e PNG');

    assert.strictEqual((await fetch(`${base}/qr?zap=outro`)).status, 404);
    assert.strictEqual((await fetch(`${base}/qr`)).status, 400);
    assert.strictEqual((await fetch(`${base}/rota-inexistente`)).status, 404);

    await closeServer(srv);
  });

  testAsync('linux: servidor com token bloqueia quem nao tem token', async () => {
    const calls = [];
    const srv = createStatusServer({
      token: 'segredo123',
      getState: () => ({ ok: true }),
      onConnect: (zapId, o) => { calls.push(Object.assign({ zapId }, o)); return { status: 202, ok: true }; },
      onDisconnect: () => ({ status: 200, ok: true })
    });
    const port = await listen(srv, 0);
    const base = `http://127.0.0.1:${port}`;

    assert.strictEqual((await fetch(`${base}/status`)).status, 401);
    assert.strictEqual((await fetch(`${base}/`)).status, 401);
    assert.strictEqual((await fetch(`${base}/status?token=errado`)).status, 401);
    assert.strictEqual((await fetch(`${base}/status?token=segredo123`)).status, 200);
    assert.strictEqual((await fetch(`${base}/status`, { headers: { 'x-token': 'segredo123' } })).status, 200);
    assert.strictEqual((await fetch(`${base}/status`, { headers: { Authorization: 'Bearer segredo123' } })).status, 200);

    const postOpts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ zap: 'z9', method: 'qrcode' }) };
    assert.strictEqual((await fetch(`${base}/connect`, postOpts)).status, 401, 'POST sem token deveria dar 401');
    assert.strictEqual((await fetch(`${base}/connect?token=segredo123`, postOpts)).status, 202, 'POST com token deveria passar');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].zapId, 'z9');
    assert.strictEqual(calls[0].method, 'qrcode');
    assert.strictEqual((await fetch(`${base}/disconnect?token=segredo123`, postOpts)).status, 200);

    await closeServer(srv);
  });

  // ---------------------------------------------------------------
  // 4) main.js real em modo headless (electron e manager trocados por stubs)
  // ---------------------------------------------------------------
  let fakeWM = null;
  let windowCount = 0;

  class FakeBrowserWindow {
    constructor() {
      windowCount++;
      this.webContents = { on() {}, send() {}, setWindowOpenHandler() {} };
    }
    loadFile() { return Promise.resolve(); }
    on() {}
    once() {}
    isDestroyed() { return false; }
    close() {}
    static getAllWindows() { return []; }
  }

  class FakeWhatsAppManager {
    constructor() {
      fakeWM = this;
      this.clients = new Map();
      this.connects = [];
      this.disconnects = [];
    }
    setOnMessageCallback(cb) { this.cb = cb; }
    getStatus(id) {
      const d = this.clients.get(String(id));
      return d ? { status: d.status, qrCode: d.qrCode, method: d.method } : { status: 'disconnected' };
    }
    getQrString(id) {
      const d = this.clients.get(String(id));
      return d && d.qrCode ? d.qrCode : null;
    }
    async connectZap(id, phone, method) {
      this.connects.push({ id: String(id), phone: phone || '', method: method || 'qrcode' });
      return { status: 'initializing', method: method || 'qrcode' };
    }
    async disconnectZap(id) {
      this.disconnects.push(String(id));
      this.clients.delete(String(id));
      return { status: 'disconnected' };
    }
    async disconnectAll() {}
  }

  const electronStub = {
    app: {
      getPath: () => path.join(tmp, 'electron-userdata'),
      whenReady: () => Promise.resolve(),
      on() {},
      quit() {},
      getName: () => 'Link no WhatsApp'
    },
    BrowserWindow: FakeBrowserWindow,
    ipcMain: { handle() {}, on() {} },
    dialog: {}
  };

  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === 'electron') return electronStub;
    if (request === './src/js/whatsapp-manager') return FakeWhatsAppManager;
    return origLoad.apply(this, arguments);
  };

  const mainMod = require(path.join(root, 'main.js'));

  await sleep(150);

  test('linux: HEADLESS=1 nao cria nenhuma janela', () => {
    assert.strictEqual(mainMod.isHeadless(), true, 'isHeadless deveria ser true');
    assert.strictEqual(windowCount, 0, 'janela foi criada mesmo em modo headless');
  });

  test('linux: isHeadless respeita a env (fora dela volta ao modo janela)', () => {
    delete process.env.HEADLESS;
    assert.strictEqual(mainMod.isHeadless(), false);
    process.env.HEADLESS = '1';
    assert.strictEqual(mainMod.isHeadless(), true);
  });

  test('linux: getDataDir usa LINK_DATA_DIR', () => {
    assert.strictEqual(mainMod.getDataDir(), path.resolve(dataDir));
    assert.strictEqual(mainMod.getFilePath('zaps.json'), path.join(path.resolve(dataDir), 'zaps.json'));
  });

  testAsync('linux: servidor HTTP do main responde com os zaps e o QR', async () => {
    const srv = mainMod.getStatusServer();
    assert.ok(srv && srv.listening, 'servidor de status nao subiu');
    const base = `http://127.0.0.1:${process.env.LINK_HTTP_PORT}`;

    fakeWM.clients.set('zap1', { status: 'connecting', qrCode: 'QR-INTEGRACAO' });

    const st = await (await fetch(`${base}/status`)).json();
    assert.strictEqual(st.ok, true);
    assert.strictEqual(st.headless, true);
    assert.strictEqual(st.dataDir, path.resolve(dataDir));
    assert.strictEqual(typeof st.uptime, 'number');
    const z1 = st.zaps.find((z) => z.id === 'zap1');
    assert.ok(z1, 'zap1 ausente no status');
    assert.strictEqual(z1.name, 'Teste Linux');
    assert.strictEqual(z1.enabled, true);
    assert.strictEqual(z1.qrPending, true);
    const z2 = st.zaps.find((z) => z.id === 'zap2');
    assert.ok(z2, 'zap2 ausente no status');
    assert.strictEqual(z2.enabled, false);

    const html = await (await fetch(`${base}/`)).text();
    assert.ok(html.includes('Teste Linux'), 'zap ausente na pagina do main');
    assert.ok(html.includes('Pasta de dados'), 'pasta de dados ausente na pagina');

    const qrRes = await fetch(`${base}/qr?zap=zap1`);
    assert.strictEqual(qrRes.status, 200);
    const png = Buffer.from(await qrRes.arrayBuffer());
    assert.strictEqual(png.toString('ascii', 1, 4), 'PNG', 'QR do main nao veio como PNG');

    const qrMissing = await fetch(`${base}/qr?zap=zap2`);
    assert.strictEqual(qrMissing.status, 404, 'zap sem QR deveria dar 404');

    const logs = await (await fetch(`${base}/logs`)).json();
    assert.ok(Array.isArray(logs.lines), '/logs deveria devolver array');
    assert.ok(logs.lines.length > 0, 'ring de logs vazio');

    assert.strictEqual(mainMod.getStatusServer(), mainMod.startStatusServer(), 'startStatusServer duplicou o servidor');
  });

  test('linux: ring de logs captura console.log', () => {
    console.log('linha-do-ring-de-teste');
    const ring = mainMod.getLogRing();
    assert.ok(ring.some((l) => l.includes('linha-do-ring-de-teste')), 'linha nao apareceu no ring');
    assert.ok(ring.some((l) => l.includes('[HTTP]')), 'log do servidor de status ausente no ring');
  });

  test('linux: reconexao automatica conecta o zap com sessao salva', () => {
    const auto = fakeWM.connects.filter((c) => c.id === 'zap1' && c.method === 'qrcode');
    assert.ok(auto.length >= 1, 'nenhum zap com sessao salva foi reconectado');
    assert.ok(!fakeWM.connects.some((c) => c.id === 'zap2'), 'zap2 nao tem sessao e nao deveria reconectar');
    const ring = mainMod.getLogRing();
    assert.ok(ring.some((l) => l.includes('[AUTO]')), 'log de reconexao automatica ausente no ring');
  });

  testAsync('linux: POST /connect e /disconnect chegam ao gerenciador', async () => {
    const base = `http://127.0.0.1:${process.env.LINK_HTTP_PORT}`;
    const post = (body) => fetch(`${base}/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    assert.strictEqual((await post({})).status, 400, 'POST sem zap deveria dar 400');
    assert.strictEqual((await post({ zap: 'nao-existe' })).status, 404, 'zap fora do zaps.json deveria dar 404');
    assert.strictEqual((await fetch(`${base}/connect`)).status, 405, 'GET em /connect deveria dar 405');
    assert.strictEqual((await post({ zap: 'zap1', method: 'pairing' })).status, 400, 'pairing sem phone deveria dar 400');

    const before = fakeWM.connects.length;
    const ok = await post({ zap: 'zap1', method: 'qrcode' });
    assert.strictEqual(ok.status, 202, 'POST /connect valido deveria dar 202');
    const j = await ok.json();
    assert.strictEqual(j.ok, true);
    await sleep(60);
    assert.strictEqual(fakeWM.connects.length, before + 1, 'connect nao chegou ao gerenciador');
    assert.strictEqual(fakeWM.connects[fakeWM.connects.length - 1].id, 'zap1');

    const disc = await fetch(`${base}/disconnect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ zap: 'zap1' })
    });
    assert.strictEqual(disc.status, 200, 'POST /disconnect deveria dar 200');
    await sleep(60);
    assert.ok(fakeWM.disconnects.includes('zap1'), 'disconnect nao chegou ao gerenciador');
  });

  // ---------------------------------------------------------------
  // 5) guarda: nenhum caminho Windows fixo no codigo
  // ---------------------------------------------------------------
  test('linux: nenhum caminho Windows fixo (unidade de disco / %APPDATA%) no codigo', () => {
    const files = [path.join(root, 'main.js'), path.join(root, 'preload.js')];
    const dir = path.join(root, 'src', 'js');
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.js')) files.push(path.join(dir, f));
    }
    const drive = /['"][A-Za-z]:[\\/]/;
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      assert.ok(!drive.test(src), `caminho de unidade de disco fixo em ${path.basename(f)}`);
      assert.ok(!src.includes('%APPDATA%'), `%APPDATA% hardcoded em ${path.basename(f)}`);
      assert.ok(!/path\.win32/.test(src), `path.win32 usado em ${path.basename(f)}`);
    }
  });

  test('linux: getFilePath usa path.join (separador do SO)', () => {
    const p = mainMod.getFilePath('zaps.json');
    assert.strictEqual(p, path.join(mainMod.getDataDir(), 'zaps.json'));
    assert.ok(p.includes(path.sep), 'getFilePath nao usa o separador do SO atual');
    if (path.sep === '/') assert.ok(!p.includes('\\'), 'barra invertida do Windows vazou num caminho do SO atual');
    else assert.ok(!p.includes('/'), 'barra Unix vazou num caminho do Windows');
  });

  // ---------------------------------------------------------------
  // execucao
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
      out(`      ${e && e.message}`);
    }
  }

  await closeServer(mainMod.getStatusServer());
  await sleep(50);

  out('');
  out(`${passed} teste(s) passaram`);
  if (failures.length) {
    out(`${failures.length} FALHA(S):`);
    for (const f of failures) {
      out(`  - ${f.name}`);
      out(`      ${String(f.error).split('\n').join('\n      ')}`);
    }
  } else {
    out('TODOS OS TESTES PASSARAM');
  }
  out('');
  process.exit(failures.length ? 1 : 0);
}

run().catch((e) => {
  out('ERRO FATAL no test/linux.js:', (e && e.stack) || e);
  process.exit(1);
});
