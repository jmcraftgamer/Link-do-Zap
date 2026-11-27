// Seguranca de configuracao: um zaps.json corrompido, vazio ou invalido NAO
// pode apagar zaps, sessoes ou treinamentos. Cobre:
//  - save-zaps recusa payload invalido e lista vazia sem allowEmpty
//  - backup .bak e restauracao automatica
//  - load-zaps lanca erro (em vez de devolver []) quando nao ha backup
//  - reconciliador do servidor aborta com zaps.json vazio sem confirmacao
//  - reconciliador move sessao para trash/ em vez de apagar
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

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function test(name, fn) {
  try { fn(); passed++; out(`ok - ${name}`); }
  catch (e) { failures.push({ name, error: e.message }); out(`FAIL - ${name}`); out(`      ${e.message}`); }
}
function testAsync(name, fn) { pending.push({ name, fn }); }

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zap-cfg-'));
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const zapsPath = path.join(dataDir, 'zaps.json');
  const bakPath = zapsPath + '.bak';
  const markerPath = path.join(dataDir, 'zaps.empty-ok.json');
  const signature = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=';

  fs.writeFileSync(zapsPath, JSON.stringify([
    { id: 'z1', name: 'Zap 1', enabled: true },
    { id: 'z2', name: 'Zap 2', enabled: true }
  ], null, 2));

  process.env.LINK_DATA_DIR = dataDir;
  process.env.HEADLESS = '1';
  process.env.LINK_HTTP_HOST = '127.0.0.1';
  process.env.LINK_HTTP_PORT = String(await freePort());

  // ---------------------------------------------------------------
  // stubs: electron + whatsapp-manager
  // ---------------------------------------------------------------
  const handlers = new Map();
  class FakeBrowserWindow {
    constructor() { throw new Error('janela nao deveria ser criada em headless'); }
  }
  class FakeWhatsAppManager {
    constructor() { this.clients = new Map(); this.connects = []; }
    setOnMessageCallback() {}
    async connectZap(id, phone, method) { this.connects.push({ id, method }); }
    getStatus() { return { status: 'disconnected' }; }
    getSystemHealth() { return { ok: true, zaps: [] }; }
    listConnectionStates() { return []; }
    async disconnectZap() { return { status: 'disconnected' }; }
    async disconnectAll() {}
  }
  const electronStub = {
    app: {
      getPath: () => path.join(tmp, 'electron-userdata'),
      setPath() {},
      isPackaged: false,
      whenReady: () => Promise.resolve(),
      on() {},
      quit() {},
      getName: () => 'Link no WhatsApp'
    },
    BrowserWindow: FakeBrowserWindow,
    ipcMain: { handle(ch, fn) { handlers.set(ch, fn); }, on() {} },
    dialog: {},
    safeStorage: { isEncryptionAvailable: () => false }
  };

  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === 'electron') return electronStub;
    if (request === './src/js/whatsapp-manager') return FakeWhatsAppManager;
    return origLoad.apply(this, arguments);
  };

  const mainMod = require(path.join(root, 'main.js'));
  await new Promise((r) => setTimeout(r, 250));

  const saveZaps = handlers.get('save-zaps');
  const loadZaps = handlers.get('load-zaps');
  assert.ok(saveZaps, 'handler save-zaps nao registrado');
  assert.ok(loadZaps, 'handler load-zaps nao registrado');

  // ---------------------------------------------------------------
  // 1) validacao de payload
  // ---------------------------------------------------------------
  test('config: save-zaps recusa lista vazia sem allowEmpty', () => {
    assert.strictEqual(saveZaps({}, [], undefined), false);
    const onDisk = JSON.parse(fs.readFileSync(zapsPath, 'utf8'));
    assert.strictEqual(onDisk.length, 2, 'zaps.json foi alterado por um payload vazio');
  });

  test('config: save-zaps recusa payload invalido', () => {
    assert.strictEqual(saveZaps({}, null), false, 'null deveria ser recusado');
    assert.strictEqual(saveZaps({}, 'texto'), false, 'string deveria ser recusada');
    assert.strictEqual(saveZaps({}, [{ name: 'sem id' }]), false, 'zap sem id deveria ser recusado');
    assert.strictEqual(saveZaps({}, [{ id: 'a' }, { id: 'a' }]), false, 'id duplicado deveria ser recusado');
  });

  test('config: save-zaps valido grava e mantem backup', () => {
    assert.strictEqual(saveZaps({}, [{ id: 'z1', name: 'Zap 1' }]), true);
    assert.strictEqual(JSON.parse(fs.readFileSync(zapsPath, 'utf8')).length, 1);
    assert.ok(fs.existsSync(bakPath), 'backup .bak nao foi criado');
    assert.strictEqual(JSON.parse(fs.readFileSync(bakPath, 'utf8')).length, 2, 'backup deveria ter a versao anterior');
  });

  test('config: save-zaps preserva billingPlan e nao aceita plano por escrita generica', () => {
    const billingSave = handlers.get('billing-save');
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const previous = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const previousMonth = `${previous.getFullYear()}-${String(previous.getMonth() + 1).padStart(2, '0')}`;
    const saved = billingSave({}, 'z1', { enabled: true, dueDay: 1, graceDays: 15, monthlyAmount: 99, startMonth: previousMonth });
    assert.strictEqual(saved.ok, true, saved.error);
    assert.strictEqual(saveZaps({}, [{ id: 'z1', name: 'Zap editado', billingPlan: { enabled: false, monthlyAmount: 999 } }]), true);
    const onDisk = JSON.parse(fs.readFileSync(zapsPath, 'utf8'));
    assert.strictEqual(onDisk[0].billingPlan.enabled, true);
    assert.strictEqual(onDisk[0].billingPlan.monthlyAmount, 99);
    assert.strictEqual(onDisk[0].billingPlan.dueDay, 1);
    assert.strictEqual(saveZaps({}, [
      { id: 'z1', name: 'Zap editado' },
      { id: 'z3', name: 'Zap novo', billingPlan: { enabled: true, monthlyAmount: 500 } }
    ]), true);
    const withNewZap = JSON.parse(fs.readFileSync(zapsPath, 'utf8'));
    const newPlan = withNewZap.find((zap) => zap.id === 'z3').billingPlan;
    assert.strictEqual(newPlan.enabled, true);
    assert.strictEqual(newPlan.monthlyAmount, 349);
    assert.strictEqual(newPlan.graceDays, 3);
    assert.notStrictEqual(newPlan.monthlyAmount, 500);
    assert.strictEqual(saveZaps({}, [{ id: 'z1', name: 'Zap editado' }]), true);

    const pay = handlers.get('billing-pay')({}, 'z1', previousMonth, signature);
    assert.strictEqual(pay.ok, true, pay.error);
    assert.strictEqual(pay.payment.period, previousMonth);
    const overview = handlers.get('billing-overview')();
    assert.strictEqual(overview.ok, true, overview.error);
    assert.strictEqual(overview.subscriptions.length, 1);
    assert.strictEqual(overview.subscriptions[0].billing.payments.length, 1);

    const extension = handlers.get('billing-extend')({}, 'z1', currentMonth, 5, 'teste');
    assert.strictEqual(extension.ok, true, extension.error);
    assert.strictEqual(extension.extension.days, 5);

    const disabled = billingSave({}, 'z1', { enabled: false });
    assert.strictEqual(disabled.ok, true, disabled.error);
    assert.strictEqual(handlers.get('billing-overview')().subscriptions.length, 0);
    assert.strictEqual(handlers.get('billing-check')({}, 'z1').active, true);
    const enabled = billingSave({}, 'z1', { enabled: true });
    assert.strictEqual(enabled.ok, true, enabled.error);
    assert.strictEqual(handlers.get('billing-overview')().subscriptions[0].billing.payments.length, 1);
  });

  test('config: lista vazia confirmada grava marcador explicito', () => {
    assert.strictEqual(saveZaps({}, [], { allowEmpty: true }), true);
    assert.strictEqual(JSON.parse(fs.readFileSync(zapsPath, 'utf8')).length, 0);
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    assert.strictEqual(marker.empty, true, 'marcador deveria indicar vazio confirmado');
    assert.ok(marker.at > 0, 'marcador sem timestamp');
  });

  // ---------------------------------------------------------------
  // 2) corrupcao
  // ---------------------------------------------------------------
  test('config: JSON corrompido sem backup -> load-zaps lanca (nao devolve [])', () => {
    fs.writeFileSync(zapsPath, '{ corrompido');
    try { fs.unlinkSync(bakPath); } catch (_) {}
    assert.throws(() => loadZaps(), /corrompido/i, 'deveria lancar erro');
    assert.strictEqual(fs.readFileSync(zapsPath, 'utf8'), '{ corrompido', 'arquivo deveria ser preservado');
    assert.strictEqual(mainMod.isConfigUnsafe('zaps.json'), true);
  });

  test('config: JSON corrompido COM backup -> restaura automaticamente', () => {
    fs.writeFileSync(bakPath, JSON.stringify([{ id: 'z1' }], null, 2));
    const list = loadZaps();
    assert.ok(Array.isArray(list), 'deveria devolver a lista do backup');
    assert.strictEqual(list.length, 1);
    assert.strictEqual(JSON.parse(fs.readFileSync(zapsPath, 'utf8')).length, 1, 'arquivo deveria ser restaurado');
    assert.strictEqual(mainMod.isConfigUnsafe('zaps.json'), false);
  });

  // ---------------------------------------------------------------
  // 3) reconciliador
  // ---------------------------------------------------------------
  const sessionZ1 = path.join(dataDir, 'sessions', 'z1');
  const trainingZ1 = path.join(dataDir, 'trainings', 'z1');
  fs.mkdirSync(sessionZ1, { recursive: true });
  fs.mkdirSync(trainingZ1, { recursive: true });

  testAsync('config: reconciler aborta com zaps.json vazio sem marcador', async () => {
    fs.writeFileSync(zapsPath, '[]');
    try { fs.unlinkSync(markerPath); } catch (_) {}
    await mainMod.reconcileServerZapsOnce();
    assert.ok(fs.existsSync(sessionZ1), 'sessao foi apagada com lista vazia nao confirmada');
    assert.ok(fs.existsSync(trainingZ1), 'treinamento foi apagado com lista vazia nao confirmada');
  });

  testAsync('config: reconciler aceita vazio confirmado e move para trash (nao apaga)', async () => {
    fs.writeFileSync(zapsPath, '[]');
    fs.writeFileSync(markerPath, JSON.stringify({ empty: true, at: Date.now() }));
    await mainMod.reconcileServerZapsOnce();
    assert.ok(!fs.existsSync(sessionZ1), 'sessao deveria sair do caminho ativo');
    assert.ok(!fs.existsSync(trainingZ1), 'treinamento deveria sair do caminho ativo');
    const trashRoot = path.join(dataDir, 'trash');
    assert.ok(fs.existsSync(trashRoot), 'pasta trash nao foi criada');
    const entries = fs.readdirSync(trashRoot);
    assert.ok(entries.length >= 1, 'nada foi para a lixeira');
    const moved = entries.some((e) => fs.existsSync(path.join(trashRoot, e, 'z1')));
    assert.ok(moved, 'sessao/treinamento deveria estar recuperavel em trash/');
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

  try {
    const srv = mainMod.getStatusServer();
    if (srv && srv.listening) await new Promise((r) => srv.close(r));
  } catch (_) {}
  await new Promise((r) => setTimeout(r, 50));

  out('');
  out(`${passed} teste(s) passaram`);
  if (failures.length) {
    out(`${failures.length} FALHA(S):`);
    for (const f of failures) out(` - ${f.name}: ${f.error}`);
    process.exitCode = 1;
  }
  process.exit(process.exitCode || 0);
})();
