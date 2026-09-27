// Teste de fluxo do main.js SEM celular e SEM janela:
// - electron e o whatsapp-manager sao substituidos por stubs
// - fetch e simulado (nenhuma chamada de rede)
// - relógio virtual: os 15/25/35s de sorteio e o tempo de digitacao
//   passam na hora, mas sao medidos de verdade
// Cobre: fila por conversa, sorteio de tempo, indicador digitando na
// ordem certa, nome no prompt, resposta cortada, texto lixo e corte de grupo.
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const root = path.join(__dirname, '..');
const ZAP_ID = 'Z1';

const pending = [];
let passed = 0;
const failures = [];
const realLog = console.log;
const out = (...a) => realLog(...a);

function testAsync(name, fn) { pending.push({ name, fn }); }

// ---------------------------------------------------------------
// 1) diretorio de dados temporario (nao toca no %APPDATA% real)
// ---------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zap-flow-'));
const userData = path.join(tmp, 'userData');
const dataDir = path.join(userData, 'link-no-whatsapp');
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'zaps.json'), JSON.stringify([
  { id: ZAP_ID, name: 'Teste', enabled: true, autoReply: true, personality: 'padrao',
    providers: ['g1', 'o1'], selectedModels: [], model: 'auto', blockedContacts: [] }
], null, 2));
fs.writeFileSync(path.join(dataDir, 'providers.json'), JSON.stringify([
  { id: 'g1', name: 'Google AI Studio', apiKeys: ['kg'], models: [{ id: 'gemini-a' }] },
  { id: 'o1', name: 'OpenRouter', apiKeys: ['ko'], models: [{ id: 'meta/llama', free: true }] }
], null, 2));
fs.writeFileSync(path.join(dataDir, 'trainings.json'), JSON.stringify({ [ZAP_ID]: [] }, null, 2));

// ---------------------------------------------------------------
// 2) relógio virtual (setTimeout avanca o Date.now)
// ---------------------------------------------------------------
let vnow = Date.now();
Date.now = () => vnow;
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn, ms, ...args) => {
  vnow += Number(ms) || 0;
  return realSetTimeout(fn, 0, ...args);
};

// ---------------------------------------------------------------
// 3) captura de logs + eventos do renderer
// ---------------------------------------------------------------
const logs = [];
const rendererEvents = [];
console.log = (...a) => { logs.push(a.map(String).join(' ')); };

// ---------------------------------------------------------------
// 4) fetch simulado
// ---------------------------------------------------------------
const realFetch = global.fetch;
let fetchCalls = [];
let fetchHandler = null;
global.fetch = async (url, opts) => {
  const req = { url: String(url), body: opts && opts.body ? JSON.parse(opts.body) : null };
  fetchCalls.push(req);
  const res = (fetchHandler && fetchHandler(req, fetchCalls.length)) || {};
  return { ok: res.ok !== false, status: res.status || 200, json: async () => res.json || {} };
};

const googleOk = (text) => ({ json: { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] } });
const orOk = (text) => ({ json: { choices: [{ message: { content: text }, finish_reason: 'stop' }] } });
const isGoogle = (req) => req.url.includes('generativelanguage');

// ---------------------------------------------------------------
// 5) stubs de electron e do whatsapp-manager
// ---------------------------------------------------------------
const typingEvents = [];
const sentMessages = [];
let fakeMgr = null;

class FakeBrowserWindow {
  constructor() {
    this.webContents = { on() {}, send(ch, payload) { rendererEvents.push({ ch, payload }); } };
  }
  loadFile() { return Promise.resolve(); }
  on() {}
  once() {}
  isDestroyed() { return false; }
  minimize() {}
  maximize() {}
  close() {}
  static getAllWindows() { return []; }
}

class FakeWhatsAppManager {
  constructor() {
    fakeMgr = this;
    this.clients = new Map();
    this.clients.set(ZAP_ID, {
      client: {
        pupPage: {
          evaluate: async (fn, chatId) => {
            const src = String(fn);
            typingEvents.push({
              chatId,
              state: src.includes('sendChatStateComposing') ? 'composing'
                : src.includes('sendChatStatePaused') ? 'paused' : 'other',
              t: Date.now()
            });
            return true;
          }
        }
      },
      chats: new Map()
    });
  }
  setOnMessageCallback(cb) { this.cb = cb; }
  async sendMessage(zapId, chatId, text) {
    sentMessages.push({ zapId: String(zapId), chatId, text, t: Date.now() });
    return { success: true };
  }
  async sendMedia(zapId, chatId) {
    sentMessages.push({ zapId: String(zapId), chatId, text: '[MEDIA]', t: Date.now() });
    return { success: true };
  }
  async disconnectAll() {}
}

const electronStub = {
  app: { getPath: () => userData, whenReady: () => Promise.resolve(), on() {}, quit() {} },
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

// ---------------------------------------------------------------
// helpers
// ---------------------------------------------------------------
function tick(n = 4) {
  return new Promise((resolve) => {
    let left = n;
    const step = () => (--left <= 0 ? resolve() : realSetTimeout(step, 0));
    step();
  });
}
function clearCooldown() { vnow += 6 * 60 * 1000; } // estoura os 5min de cooldown de modelo
function snapshot() {
  return { logs: logs.length, typing: typingEvents.length, sent: sentMessages.length, fetch: fetchCalls.length, renderer: rendererEvents.length, t: Date.now() };
}
function mkMsg(over) {
  return Object.assign({
    zapId: ZAP_ID,
    id: 'false_1',
    body: 'oi',
    from: '553298482734@c.us',
    to: '5532999344496@c.us',
    fromMe: false,
    selfChat: false,
    audio: null,
    audioFailed: false,
    timestamp: Math.floor(Date.now() / 1000),
    contact: { id: '553298482734@s.whatsapp.net', name: 'Joao Silva', number: '553298482734' },
    chat: { id: '553298482734@c.us', name: 'Joao Silva', isGroup: false }
  }, over || {});
}
function person(num, name) {
  return {
    from: `${num}@c.us`,
    contact: { id: `${num}@s.whatsapp.net`, name, number: num },
    chat: { id: `${num}@c.us`, name, isGroup: false }
  };
}
function lastSent() { return sentMessages[sentMessages.length - 1]; }
function newLogs(s) { return logs.slice(s.logs).join('\n'); }

// ---------------------------------------------------------------
// carrega o main.js real com os stubs
// ---------------------------------------------------------------
require(path.join(root, 'main.js'));

async function run() {
  await tick(6);
  assert.ok(fakeMgr && fakeMgr.cb, 'callback do whatsapp-manager nao registrado');

  // ---------------------------------------------------------------
  // A) resposta normal: nome no prompt, 2048 tokens, sorteio e digitando
  // ---------------------------------------------------------------
  testAsync('fluxo: resposta normal com nome, sorteio e digitando na ordem', async () => {
    clearCooldown();
    const s = snapshot();
    fetchHandler = (req) => (isGoogle(req) ? googleOk('Oi, Joao, em que posso ajudar?') : orOk('fallback'));
    await fakeMgr.cb(mkMsg());

    const sent = lastSent();
    assert.strictEqual(sent.text, 'Oi, Joao, em que posso ajudar?');

    const calls = fetchCalls.slice(s.fetch);
    const g = calls.find(isGoogle);
    assert.ok(g, 'chamada ao Google ausente');
    assert.strictEqual(g.body.generationConfig.maxOutputTokens, 2048, 'maxOutputTokens != 2048');
    const sys = g.body.systemInstruction.parts[0].text;
    assert.ok(sys.includes('NOME DO CLIENTE: Joao Silva'), 'nome do contato ausente no prompt');

    const text = newLogs(s);
    assert.ok(/Sorteio de tempo de resposta: (15|25|35)s/.test(text), 'sorteio 15/25/35s ausente');
    assert.ok(text.includes('Digitacao realista'), 'log de digitacao realista ausente');
    assert.ok(text.includes('Indicador "digitando" ativado'), 'indicador nao ligou antes da IA');

    const ev = typingEvents.slice(s.typing);
    const comp = ev.find(e => e.state === 'composing');
    const pause = ev.find(e => e.state === 'paused');
    assert.ok(comp, 'composing nunca foi chamado');
    assert.ok(pause, 'paused nunca foi chamado');
    assert.ok(comp.t < pause.t, 'paused veio antes do composing');
    assert.ok(pause.t <= sent.t, 'mensagem saiu antes de desligar o digitando');

    // tempo total = sorteio (15/25/35s) + digitacao humana (2,5 chars/s, min 5s)
    const humanMs = Math.round((sent.text.length / 2.5) * 1000);
    const target = Math.max(5000, humanMs);
    const preDelay = (sent.t - s.t) - target;
    assert.ok([15000, 25000, 35000].includes(preDelay), `preDelay fora do esperado: ${preDelay}ms`);
    assert.ok(sent.t - comp.t >= 5000, 'digitando durou menos de 5s');

    const typingUi = rendererEvents.slice(s.renderer).filter(e => e.ch === 'whatsapp-typing');
    assert.ok(typingUi.some(e => e.payload.isTyping === true), 'renderer nao recebeu isTyping=true');
    assert.ok(typingUi.some(e => e.payload.isTyping === false), 'renderer nao recebeu isTyping=false');
  });

  // ---------------------------------------------------------------
  // B) resposta lixa -> fallback, nunca vai ao cliente
  // ---------------------------------------------------------------
  testAsync('fluxo: texto lixo da IA nao vai ao cliente', async () => {
    clearCooldown();
    const s = snapshot();
    fetchHandler = (req) => (isGoogle(req) ? googleOk('Check Constreainsts:*** Max') : orOk('Blz, te respondo ja ja!'));
    await fakeMgr.cb(mkMsg(person('5511888888888', 'Maria')));

    const sent = lastSent();
    assert.strictEqual(sent.text, 'Blz, te respondo ja ja!');
    assert.ok(!/Constreainsts/i.test(sent.text), 'texto lixo foi enviado ao cliente');
    assert.ok(/invalido|descartado/i.test(newLogs(s)), 'log de resposta descartada ausente');
  });

  // ---------------------------------------------------------------
  // C) resposta cortada no meio -> fallback, nunca vai ao cliente
  // ---------------------------------------------------------------
  testAsync('fluxo: resposta cortada no meio cai no fallback', async () => {
    clearCooldown();
    const s = snapshot();
    fetchHandler = (req) => (isGoogle(req)
      ? { json: { candidates: [{ content: { parts: [{ text: 'Ola eu sou o Jota da' }] }, finishReason: 'MAX_TOKENS' }] } }
      : orOk('Tudo certo por aqui, posso te ajudar?'));
    await fakeMgr.cb(mkMsg(person('5522777777777', 'Carlos')));

    const sent = lastSent();
    assert.strictEqual(sent.text, 'Tudo certo por aqui, posso te ajudar?');
    assert.ok(!sent.text.includes('Jota da'), 'texto cortado foi ao cliente');
    assert.ok(fetchCalls.slice(s.fetch).length >= 2, 'fallback nao foi tentado');
  });

  // ---------------------------------------------------------------
  // D) corte com frase completa -> envia so a frase inteira
  // ---------------------------------------------------------------
  testAsync('fluxo: corte com frase completa envia a frase inteira', async () => {
    clearCooldown();
    const s = snapshot();
    fetchHandler = () => ({ json: { candidates: [{ content: { parts: [{ text: 'Sai por R$ 50. Quero ver mais detalhes' }] }, finishReason: 'MAX_TOKENS' }] } });
    await fakeMgr.cb(mkMsg(person('5544333333333', 'Ana')));

    const sent = lastSent();
    assert.strictEqual(sent.text, 'Sai por R$ 50.');
    assert.strictEqual(fetchCalls.slice(s.fetch).length, 1, 'nao precisou de fallback');
  });

  // ---------------------------------------------------------------
  // E) fila por conversa: 2 mensagens do mesmo chat na ordem certa
  // ---------------------------------------------------------------
  testAsync('fluxo: 2 mensagens do mesmo chat sao respondidas na ordem', async () => {
    clearCooldown();
    const s = snapshot();
    let n = 0;
    fetchHandler = () => { n++; return googleOk(n === 1 ? 'Primeira resposta' : 'Segunda resposta'); };
    const who = person('5533666666666', 'Pedro');
    const p1 = fakeMgr.cb(mkMsg(Object.assign({ body: 'oi' }, who)));
    const p2 = fakeMgr.cb(mkMsg(Object.assign({ body: 'quanto custa?' }, who)));
    await p1;
    await p2;

    const texts = sentMessages.slice(s.sent).map(m => m.text);
    assert.deepStrictEqual(texts, ['Primeira resposta', 'Segunda resposta'],
      `ordem errada: ${JSON.stringify(texts)}`);
    assert.strictEqual(fetchCalls.slice(s.fetch).length, 2, 'esperava 2 chamadas de IA');
  });

  // ---------------------------------------------------------------
  // F) grupo: bloqueado antes de qualquer coisa
  // ---------------------------------------------------------------
  testAsync('fluxo: mensagem de grupo nao chega na IA nem no cliente', async () => {
    clearCooldown();
    const s = snapshot();
    fetchHandler = () => { throw new Error('IA foi chamada para um grupo!'); };
    await fakeMgr.cb(mkMsg({
      from: '120363012345678901@g.us',
      isGroup: true,
      contact: { id: '120363012345678901@g.us', name: 'Grupo da galera', number: '' },
      chat: { id: '120363012345678901@g.us', name: 'Grupo da galera', isGroup: true }
    }));

    assert.strictEqual(fetchCalls.length, s.fetch, 'IA foi chamada para um grupo');
    assert.strictEqual(sentMessages.length, s.sent, 'mensagem foi enviada para um grupo');
    assert.ok(logs.slice(s.logs).some(l => l.includes('[GRUPO]')), 'log de corte de grupo ausente');
  });

  // ---------------------------------------------------------------
  // G) audio que nao baixou -> pede pra mandar como texto
  // ---------------------------------------------------------------
  testAsync('fluxo: audio que nao baixou recebe pedido de texto', async () => {
    clearCooldown();
    const s = snapshot();
    fetchHandler = () => { throw new Error('IA nao deveria ser chamada'); };
    await fakeMgr.cb(mkMsg(Object.assign({ audioFailed: true, body: '[AUDIO]' }, person('5555444444444', 'Bia'))));

    assert.strictEqual(fetchCalls.length, s.fetch, 'IA chamada mesmo com audio falho');
    assert.ok(lastSent().text.includes('audio'), `esperava pedido de texto, veio: ${lastSent().text}`);
  });

  // ---------------------------------------------------------------
  for (const p of pending) {
    try {
      await p.fn();
      passed++;
      out(`  ok - ${p.name}`);
    } catch (e) {
      failures.push({ name: p.name, error: e.message });
      out(`  FAIL - ${p.name}\n      ${e.message}`);
    }
  }

  global.fetch = realFetch;
  console.log = realLog;
  out(`\n${passed} teste(s) passaram`);
  if (failures.length) {
    out(`\n${failures.length} FALHA(S):`);
    for (const f of failures) out(`  - ${f.name}\n      ${f.error}`);
    out('\n--- logs capturados ---');
    for (const l of logs) out('  ' + l);
    process.exitCode = 1;
  } else {
    out('TODOS OS TESTES PASSARAM');
  }
}

run().catch((e) => {
  console.log = realLog;
  out('ERRO FATAL NO TESTE: ' + (e && e.stack));
  process.exitCode = 1;
});
