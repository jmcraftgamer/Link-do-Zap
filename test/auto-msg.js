// Testes do motor da Mensagem Automatica (fila de disparos com intervalo)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AutoMessage = require(path.join(__dirname, '..', 'src', 'js', 'auto-message'));

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    failures.push({ name, error: e.message });
    console.log(`FAIL - ${name}`);
    console.log(`      ${e.message}`);
  }
}

function testAsync(name, fn) {
  pending.push({ name, fn });
}

const pending = [];

async function waitFor(fn, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise(r => setTimeout(r, 10));
  }
  return fn();
}

function makeManager(over = {}) {
  const sent = [];
  const logs = [];
  const mgr = new AutoMessage();
  mgr.configure(Object.assign({
    delays: { contact: 5, retry: 5, ready: 5 },
    getStatus: () => ({ status: 'ready' }),
    sendMessage: async (zapId, phone, text) => {
      sent.push({ zapId: String(zapId), phone, text });
      return { success: true, msgId: `mid_${sent.length}` };
    },
    sendMedia: async (zapId, phone, media) => {
      sent.push({ zapId: String(zapId), phone, text: `[midia:${media.name}]` });
      return { success: true };
    },
    deleteMessage: async () => 'everyone',
    onLog: (e) => logs.push(e)
  }, over));
  return { mgr, sent, logs };
}

// ---------------------------------------------------------------
// Numeros
// ---------------------------------------------------------------
test('normaliza numero brasileiro com e sem DDI', () => {
  const m = new AutoMessage();
  assert.strictEqual(m.normalizeNumber('5532999999999'), '5532999999999');
  assert.strictEqual(m.normalizeNumber('(32) 99999-9999'), '5532999999999');
  assert.strictEqual(m.normalizeNumber('+55 32 99999-9999'), '5532999999999');
  assert.strictEqual(m.normalizeNumber('032 99999-9999'), '5532999999999');
  assert.strictEqual(m.normalizeNumber('005532999999999'), '5532999999999');
  assert.strictEqual(m.normalizeNumber('1234'), null);
  assert.strictEqual(m.normalizeNumber(''), null);
});

test('extrai numeros do texto e ignora datas', () => {
  const m = new AutoMessage();
  const found = m.extractNumbers('Oi, envie para +55 (32) 99999-9999 e 31888888888, hoje 03/10/2026');
  assert.deepStrictEqual(found, ['5532999999999', '5531888888888']);
});

test('registra numero sem repetir', () => {
  const m = new AutoMessage();
  assert.strictEqual(m.addRecipient('32 99999-9999'), true);
  assert.strictEqual(m.addRecipient('5532999999999'), false);
  assert.strictEqual(Object.keys(m.state.recipients).length, 1);
});

// ---------------------------------------------------------------
// Fila / acoes
// ---------------------------------------------------------------
testAsync('acao send enfileira com repeat e vira running', async () => {
  const { mgr } = makeManager({ getStatus: () => ({ status: 'disconnected' }) });
  mgr.setZap('z1');
  const r = await mgr.runActions([
    { type: 'send', numbers: ['5532999999999', '5531888888888'], text: 'boa noite', repeat: 2 }
  ], []);
  assert.strictEqual(r.scheduled, 4, `esperava 4 agendados, veio ${r.scheduled}`);
  assert.strictEqual(mgr.state.queue.length, 4);
  assert.strictEqual(mgr.state.status, 'running');
  assert.ok(mgr.state.queue.every(q => q.status === 'pending'));

  const stopped = mgr.stop();
  await new Promise(r => setTimeout(r, 40));
  assert.strictEqual(mgr.state.status, 'stopped', 'stop nao parou a campanha');
  assert.strictEqual(mgr.pendingCount(), 4, 'fila deveria ficar preservada');
});

testAsync('runner envia tudo, marca progresso e conclui', async () => {
  const { mgr, sent, logs } = makeManager();
  mgr.setZap('z1');
  await mgr.runActions([
    { type: 'send', numbers: ['5532999999999', '5531888888888', '5531777777777'], text: 'oi tudo bem?' }
  ], []);
  // primeiro envio ja sai na hora, os demais com intervalo curto de teste
  const done = await waitFor(() => mgr.state.status === 'done');
  assert.ok(done, `campanha nao concluiu (status=${mgr.state.status})`);
  assert.strictEqual(sent.length, 3, `esperava 3 envios, houve ${sent.length}`);
  assert.ok(sent.every(s => s.text === 'oi tudo bem?'));
  assert.ok(mgr.state.queue.every(q => q.status === 'sent'));
  assert.ok(Object.values(mgr.state.recipients).every(r => r.status === 'sent'));

  const msgs = mgr.state.log.map(l => l.msg);
  assert.ok(msgs.some(m => m.includes('(1/3)')), 'progresso 1/3 ausente do log');
  assert.ok(msgs.some(m => m.includes('(3/3)')), 'progresso 3/3 ausente do log');
  assert.ok(msgs.some(m => m.includes('Fila concluida')), 'fim da fila ausente do log');
  assert.strictEqual(mgr.state.nextAt, 0, 'nextAt deveria zerar ao concluir');
  assert.strictEqual(logs.length > 0, true, 'onLog nao foi chamado');
});

testAsync('falha permanente marca failed apos 3 tentativas', async () => {
  const { mgr, sent } = makeManager({
    sendMessage: async () => { throw new Error('zap caiu'); }
  });
  mgr.setZap('z1');
  await mgr.runActions([{ type: 'send', numbers: ['5532999999999'], text: 'oi' }], []);
  const done = await waitFor(() => mgr.state.status === 'done');
  assert.ok(done, 'campanha com falhas nao terminou');
  assert.strictEqual(sent.length, 0, 'nada deveria ter sido enviado');
  assert.strictEqual(mgr.state.queue[0].status, 'failed');
  assert.strictEqual(mgr.state.queue[0].attempts, 3, 'esperava 3 tentativas');
  assert.strictEqual(mgr.state.recipients['5532999999999'].status, 'failed');
  const msgs = mgr.state.log.map(l => l.msg);
  assert.ok(msgs.some(m => m.includes('apos 3 tentativas')), 'log de falha final ausente');
});

testAsync('anexo vai junto na fila e vira midia no envio', async () => {
  const { mgr, sent } = makeManager();
  mgr.setZap('z1');
  await mgr.runActions([
    { type: 'send', numbers: ['5532999999999'], text: 'cardapio', files: ['cardapio.png'] }
  ], [{ name: 'cardapio.png', mimeType: 'image/png', data: 'aGVsbG8=' }]);
  const done = await waitFor(() => mgr.state.status === 'done');
  assert.ok(done, 'envio com anexo nao concluiu');
  assert.strictEqual(sent.length, 2, 'esperava texto + midia');
  assert.ok(sent[0].text === 'cardapio');
  assert.ok(sent[1].text === '[midia:cardapio.png]');
});

// ---------------------------------------------------------------
// Troca de conta, exclusao e retomada
// ---------------------------------------------------------------
test('troca de conta bloqueada com fila pendente', async () => {
  const { mgr } = makeManager({ getStatus: () => ({ status: 'disconnected' }) });
  mgr.setZap('z1');
  await mgr.runActions([{ type: 'send', numbers: ['5532999999999'], text: 'oi' }], []);
  assert.strictEqual(mgr.setZap('z2'), false, 'troca deveria ser bloqueada');
  assert.strictEqual(mgr.state.zapId, 'z1');
  mgr.stop();
  await new Promise(r => setTimeout(r, 40));
  assert.strictEqual(mgr.setZap('z2'), true, 'com a campanha parada a troca deveria passar');
  assert.strictEqual(Object.keys(mgr.state.recipients).length, 0, 'troca zera a agenda');
});

testAsync('delete sem registro avisa no log', async () => {
  const { mgr } = makeManager();
  mgr.setZap('z1');
  const r = await mgr.runActions([{ type: 'delete', numbers: ['5532999999999'] }], []);
  assert.ok(r.notes[0].includes('0 apagada'), 'nota de exclusao inesperada');
  assert.ok(mgr.state.log.some(l => l.msg.includes('nada a apagar')));
});

testAsync('retomada automatica depois do reinicio', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-msg-'));
  const file = path.join(dir, 'auto-msg-state.json');
  // zap desconectado: nada envia, a fila fica parada "em plena execucao"
  const { mgr } = makeManager({ getStatus: () => ({ status: 'disconnected' }) });
  mgr.configure({ filePath: file });
  mgr.setZap('z1');
  await mgr.runActions([
    { type: 'send', numbers: ['5532999999999', '5531888888888'], text: 'ola' }
  ], []);
  // "crash" no meio da campanha: o disco ficou com status=running e fila pendente
  const snapshot = fs.readFileSync(file, 'utf8');
  mgr.stop();
  await new Promise(r => setTimeout(r, 30));
  fs.writeFileSync(file, snapshot);
  assert.ok(JSON.parse(snapshot).queue.length >= 1, 'fila persistida ausente');

  // novo processo: carrega e retoma
  const sent2 = [];
  const mgr2 = new AutoMessage();
  mgr2.configure({
    filePath: file,
    delays: { contact: 5, retry: 5, ready: 5 },
    getStatus: () => ({ status: 'ready' }),
    sendMessage: async (zapId, phone, text) => { sent2.push(phone); return { success: true, msgId: 'm1' }; },
    sendMedia: async () => ({ success: true }),
    deleteMessage: async () => 'everyone'
  });
  assert.strictEqual(mgr2.load(), true, 'estado nao carregou do disco');
  assert.ok(mgr2.state.queue.length >= 1, 'fila persistida ausente');
  const resumed = mgr2.resumeOnBoot();
  assert.strictEqual(resumed, true, 'retomada nao disparou');
  assert.ok(mgr2.state.log.some(l => l.msg.includes('Retomada automatica')), 'log de retomada ausente');
  const done = await waitFor(() => mgr2.state.status === 'done');
  assert.ok(done, 'campanha retomada nao concluiu');
  assert.strictEqual(sent2.length, mgr2.state.queue.length, 'nem toda a fila retomada foi enviada');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------
// Historico por conta (memoria da IA)
// ---------------------------------------------------------------
test('historico fica isolado por conta e sobrevive a troca de zap', () => {
  const m = new AutoMessage();
  m.setZap('z1');
  m.pushChat('user', 'oi, tudo bem?');
  m.pushSystem('Mensagem enviada para +5532999999999');
  assert.strictEqual(m.setZap('z2'), true);
  assert.strictEqual(m.chatFor('z1').length, 2, 'historico da z1 nao pode sumir na troca');
  assert.strictEqual(m.chatFor('z2').length, 0, 'z2 nasceu com historico vazio');
  m.pushChat('user', 'outro assunto');
  assert.strictEqual(m.chatFor('z1').length, 2, 'historico da z1 mudou depois da troca');
  assert.strictEqual(m.chatFor('z2').length, 1);
});

test('historyTurns lembra o que foi feito (system vira contexto)', () => {
  const m = new AutoMessage();
  m.setZap('z1');
  m.pushChat('user', 'envie para +5532999999999');
  m.pushSystem('Mensagem enviada para +5532999999999');
  m.pushChat('agent', 'Acabei de enviar, mais alguma coisa?');
  const turns = m.historyTurns('z1');
  assert.deepStrictEqual(turns.map(t => t.role), ['user', 'assistant', 'assistant']);
  assert.strictEqual(turns[1].content, 'Mensagem enviada para +5532999999999');
});

test('migracao: chat antigo vira historico da conta', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-msg-mig-'));
  const file = path.join(dir, 'auto-msg-state.json');
  fs.writeFileSync(file, JSON.stringify({
    zapId: 'zap9',
    status: 'idle',
    chat: [{ role: 'user', content: 'oi', t: 1 }, { role: 'agent', content: 'ola', t: 2 }],
    queue: [],
    log: [],
    recipients: {}
  }));
  const m = new AutoMessage();
  m.configure({ filePath: file });
  assert.strictEqual(m.load(), true, 'estado antigo nao carregou');
  assert.strictEqual(m.chatFor('zap9').length, 2, 'chat antigo nao migrou');
  assert.strictEqual(m.state.chat, undefined, 'campo chat antigo nao foi removido');
  const snap = m.getState();
  assert.ok(snap.chats && Array.isArray(snap.chats.zap9), 'getState sem chats por conta');
  fs.rmSync(dir, { recursive: true, force: true });
});

testAsync('envio concluido vira linha no historico da conta', async () => {
  const { mgr } = makeManager();
  mgr.setZap('z1');
  await mgr.runActions([{ type: 'send', numbers: ['5532999999999'], text: 'boa noite' }], []);
  const done = await waitFor(() => mgr.state.status === 'done');
  assert.ok(done, 'campanha nao concluiu');
  const chat = mgr.chatFor('z1').map(c => c.content);
  assert.ok(chat.includes('Mensagem enviada para +5532999999999'), 'linha de envio ausente do historico');
  assert.ok(chat.includes('boa noite'), 'texto enviado ausente do historico');
  const snap = mgr.getState();
  assert.ok(snap.chats && snap.chats.z1, 'getState sem chats por conta');
  assert.strictEqual(snap.chat, undefined, 'getState ainda expoe chat unico');
});

async function runPending() {
  for (const p of pending) {
    try {
      await p.fn();
      passed++;
      console.log(`ok - ${p.name}`);
    } catch (e) {
      failures.push({ name: p.name, error: e.message });
      console.log(`FAIL - ${p.name}`);
      console.log(`      ${e.message}`);
    }
  }

  console.log(`\n${passed} teste(s) passaram`);
  if (failures.length) {
    console.log(`\n${failures.length} FALHA(S):`);
    for (const f of failures) console.log(`  - ${f.name}\n      ${f.error}`);
    process.exitCode = 1;
  } else {
    console.log('TODOS OS TESTES PASSARAM');
  }
}

runPending();
