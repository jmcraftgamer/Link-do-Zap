// Teste de fluxo do main.js SEM celular e SEM janela:
// - electron e o whatsapp-manager sao substituidos por stubs
// - fetch e simulado (nenhuma chamada de rede)
// - relógio virtual: os 2/3/5s de sorteio e o tempo de digitacao
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
const HOURLY = 3600000;
global.setTimeout = (fn, ms, ...args) => {
  const d = Number(ms) || 0;
  // Timers de fundo (virada de dia 00:00 etc) ficam fora do teste: se fossem
  // avancados aqui o relógio virtual pularia horas e reagendariam para sempre.
  if (d > HOURLY) return { unref() {}, ref() {} };
  vnow += d;
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
  async hasOwnerReplied() { return !!this.ownerReplied; }
  async replyMessage(zapId, chatId, text) {
    sentMessages.push({ zapId: String(zapId), chatId, text, quoted: true, t: Date.now() });
    return { success: true, quoted: true };
  }
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
// O ConversationStore agenda um save (400ms) a cada gravacao; aqui esse timer
// so poluiria o relógio virtual, entao vira no-op (o teste so usa memoria).
const ConversationStore = require(path.join(root, 'src', 'js', 'conversation-store'));
ConversationStore.prototype.scheduleSave = function () {};
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
    assert.ok(/Sorteio de tempo de resposta: (2|3|5)s/.test(text), 'sorteio 2/3/5s ausente');
    assert.ok(text.includes('Digitacao realista'), 'log de digitacao realista ausente');
    assert.ok(text.includes('Indicador "digitando" ativado'), 'indicador nao ligou antes da IA');

    const ev = typingEvents.slice(s.typing);
    const comp = ev.find(e => e.state === 'composing');
    const pause = ev.find(e => e.state === 'paused');
    assert.ok(comp, 'composing nunca foi chamado');
    assert.ok(pause, 'paused nunca foi chamado');
    assert.ok(comp.t < pause.t, 'paused veio antes do composing');
    assert.ok(pause.t <= sent.t, 'mensagem saiu antes de desligar o digitando');

    // tempo total = sorteio (2/3/5s) + digitacao humana (2,5 chars/s, min 5s)
    const humanMs = Math.round((sent.text.length / 2.5) * 1000);
    const target = Math.max(5000, humanMs);
    const preDelay = (sent.t - s.t) - target;
    assert.ok([2000, 3000, 5000].includes(preDelay), `preDelay fora do esperado: ${preDelay}ms`);
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

  testAsync('fluxo: JSON da IA nao chega ao cliente (cai no fallback)', async () => {
    clearCooldown();
    fetchHandler = (req) => (isGoogle(req) ? googleOk('{"reply":"Oi"}') : orOk('Claro, posso ajudar!'));
    await fakeMgr.cb(mkMsg(person('5511777777777', 'Lia')));

    const sent = lastSent();
    assert.strictEqual(sent.text, 'Claro, posso ajudar!');
    assert.ok(!/[{}]/.test(sent.text), 'JSON vazou ao cliente');
  });

  testAsync('fluxo: marcador de imagem torto nao vaza como codigo', async () => {
    clearCooldown();
    fetchHandler = (req) => (isGoogle(req) ? googleOk('[SEND_IMAGE : img1] Segue o cardapio') : orOk('x'));
    await fakeMgr.cb(mkMsg(person('5511666666666', 'Rafa')));

    const sent = lastSent();
    assert.ok(!/SEND_IMAGE/i.test(sent.text || ''), 'marcador vazou ao cliente');
    assert.ok(!/\[[^\]]*\]/.test(sent.text || ''), 'colchetes de marcador vazaram');
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
  // ---------------------------------------------------------------
  // H) multiplas mensagens: 3 baloes com digitando entre cada um
  // ---------------------------------------------------------------
  testAsync('fluxo: resposta em 3 baloes com digitacao entre cada um', async () => {
    clearCooldown();
    const s = snapshot();
    fetchHandler = () => googleOk('Ola, bom dia![QUEBRA]Bem-vindo a Dikassa![QUEBRA]Em que posso ajudar?');
    await fakeMgr.cb(mkMsg(person('5566555555555', 'Rita')));

    const sent = sentMessages.slice(s.sent);
    assert.deepStrictEqual(sent.map(m => m.text),
      ['Ola, bom dia!', 'Bem-vindo a Dikassa!', 'Em que posso ajudar?'],
      'baloes fora de ordem ou marcador vazou');

    assert.ok(logs.slice(s.logs).some(l => l.includes('Resposta separada em 3 mensagens')),
      'log de separacao ausente');
    assert.ok(!logs.slice(s.logs).some(l => /\[QUEBRA\]/.test(l) && l.includes('Enviando')),
      'marcador [QUEBRA] vazou para o envio');

    const ev = typingEvents.slice(s.typing);
    const comp = ev.filter(e => e.state === 'composing');
    const pause = ev.filter(e => e.state === 'paused');
    assert.ok(comp.length >= 3, `esperava composing em cada balao, veio ${comp.length}`);
    assert.ok(pause.length >= 3, `esperava paused em cada balao, veio ${pause.length}`);

    for (let i = 0; i < sent.length; i++) {
      assert.ok(comp[i].t <= pause[i].t, `balao ${i + 1}: paused antes do composing`);
      assert.ok(pause[i].t <= sent[i].t, `balao ${i + 1}: enviado antes de desligar o digitando`);
      assert.ok(sent[i].t - comp[i].t >= 5000, `balao ${i + 1}: digitando menos de 5s`);
      if (i > 0) {
        assert.ok(comp[i].t >= sent[i - 1].t, `balao ${i + 1}: comecou a digitar antes do balao ${i} sair`);
        assert.ok(sent[i].t - sent[i - 1].t >= 5000, `balao ${i + 1}: gap menor que 5s entre baloes`);
      }
    }

    // 1o balao espera o sorteio (2/3/5s) + digitacao humana
    const human = Math.max(5000, Math.round((sent[0].text.length / 2.5) * 1000));
    const preDelay = (sent[0].t - s.t) - human;
    assert.ok([2000, 3000, 5000].includes(preDelay), `preDelay fora do esperado: ${preDelay}ms`);
  });

  // ---------------------------------------------------------------
  // I) teto absoluto: 6 marcadores da IA viram 4 baloes
  // ---------------------------------------------------------------
  testAsync('fluxo: IA exagerou no [QUEBRA] - envia no maximo 4 mensagens', async () => {
    clearCooldown();
    const s = snapshot();
    fetchHandler = () => googleOk(['m1', 'm2', 'm3', 'm4', 'm5', 'm6'].join('[QUEBRA]'));
    await fakeMgr.cb(mkMsg(person('5577444444444', 'Tiago')));

    const sent = sentMessages.slice(s.sent);
    assert.strictEqual(sent.length, 4, `esperava 4 mensagens, enviou ${sent.length}`);
    assert.strictEqual(sent[3].text, 'm4 m5 m6', 'excesso nao foi juntado na ultima mensagem');
    assert.strictEqual(fetchCalls.slice(s.fetch).length, 1);
  });

  // ---------------------------------------------------------------
  // J) resposta curta continua em UMA mensagem so
  // ---------------------------------------------------------------
  testAsync('fluxo: resposta curta NAO e separada', async () => {
    clearCooldown();
    const s = snapshot();
    fetchHandler = () => googleOk('Sai por R$ 50, quer que eu reserve?');
    await fakeMgr.cb(mkMsg(person('5588333333333', 'Lia')));

    const sent = sentMessages.slice(s.sent);
    assert.strictEqual(sent.length, 1, `esperava 1 mensagem, enviou ${sent.length}`);
    assert.ok(!logs.slice(s.logs).some(l => l.includes('Resposta separada em')));
  });

  // ---------------------------------------------------------------
  // K) MEMORIA: historico por conversa (zerada as 00:00)
  // ---------------------------------------------------------------
  function lastAiBody() {
    const req = fetchCalls[fetchCalls.length - 1];
    return (req && req.body) || null;
  }
  function sysText(body) {
    const si = body && body.systemInstruction;
    return ((si && si.parts) || []).map(p => p.text).join('\n');
  }
  function contentsText(body) {
    return JSON.stringify((body && body.contents) || []);
  }

  testAsync('fluxo: 2a mensagem leva o historico da 1a para o modelo', async () => {
    clearCooldown();
    const s = snapshot();
    const p = person('5510101010101', 'Carla');

    fetchHandler = () => googleOk('Oi Carla, bem-vinda!');
    await fakeMgr.cb(mkMsg(Object.assign({ body: 'oi' }, p)));

    fetchHandler = () => googleOk('Voce se chama Carla.');
    await fakeMgr.cb(mkMsg(Object.assign({ body: 'como eu me chamo?' }, p)));

    const body = lastAiBody();
    assert.ok(body, 'segunda chamada a IA nao aconteceu');
    const contents = contentsText(body);
    assert.ok(contents.includes('oi'), 'mensagem 1 ausente do historico');
    assert.ok(contents.includes('bem-vinda'), 'resposta 1 ausente do historico');
    assert.ok(contents.includes('como eu me chamo?'), 'mensagem atual ausente do pedido');
    assert.ok(sysText(body).includes('MEMORIA DA CONVERSA ATUAL'), 'bloco de memoria ausente no prompt');
    assert.ok(logs.slice(s.logs).some(l => l.includes('Nova conversa iniciada')), 'log de nova conversa ausente');
  });

  testAsync('fluxo: outro contato nao herda o historico do primeiro', async () => {
    clearCooldown();
    fetchHandler = () => googleOk('Certo.');
    await fakeMgr.cb(mkMsg(Object.assign({ body: 'oi' }, person('5520202020202', 'Bruno'))));

    const body = lastAiBody();
    assert.ok(!contentsText(body).includes('Carla'), 'historico de outro contato vazou');
    assert.ok(!sysText(body).includes('MEMORIA DA CONVERSA ATUAL'),
      'conversa nova nao deveria receber o bloco de memoria');
  });

  testAsync('fluxo: apos 00:00 o contato abre conversa nova e perde a memoria antiga', async () => {
    const s = snapshot();
    const d = new Date(vnow);
    vnow = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 5, 0, 0).getTime();
    clearCooldown();

    fetchHandler = () => googleOk('Bom dia!');
    await fakeMgr.cb(mkMsg(Object.assign({ body: 'bom dia' }, person('5510101010101', 'Carla'))));

    const body = lastAiBody();
    assert.ok(!contentsText(body).includes('bem-vinda'), 'historico de ontem vazou para a conversa nova');
    assert.ok(!sysText(body).includes('MEMORIA DA CONVERSA ATUAL'),
      'conversa do dia seguinte nao pode ver a memoria de ontem');
    assert.ok(logs.slice(s.logs).some(l => l.includes('Nova conversa iniciada')),
      'log de nova conversa apos a virada ausente');
  });

  // ---------------------------------------------------------------
  // L) RESPOSTA INSTANTANEA: zap.instantReply ignora o sorteio
  // ---------------------------------------------------------------
  testAsync('fluxo: zap com instantReply responde sem o sorteio de tempo', async () => {
    clearCooldown();
    const zapsPath = path.join(dataDir, 'zaps.json');
    const original = fs.readFileSync(zapsPath, 'utf8');
    fs.writeFileSync(zapsPath, JSON.stringify([
      { id: ZAP_ID, name: 'Teste', enabled: true, autoReply: true, personality: 'padrao',
        instantReply: true, providers: ['g1', 'o1'], selectedModels: [], model: 'auto', blockedContacts: [] }
    ], null, 2));

    const s = snapshot();
    fetchHandler = () => googleOk('Resposta rapida!');
    await fakeMgr.cb(mkMsg(person('5566778899000', 'Rita')));

    fs.writeFileSync(zapsPath, original);

    const text = newLogs(s);
    assert.ok(text.includes('Resposta instantanea ativada'), 'log de resposta instantanea ausente');
    assert.ok(!/Sorteio de tempo de resposta/.test(text), 'sorteio nao deveria ter acontecido');

    const sent = lastSent();
    assert.strictEqual(sent.text, 'Resposta rapida!');
    const human = Math.max(5000, Math.round((sent.text.length / 2.5) * 1000));
    const preDelay = (sent.t - s.t) - human;
    assert.ok(preDelay < 1000, `preDelay deveria ser ~0, veio ${preDelay}ms`);

    // zaps.json de volta ao normal: os demais testes continuam com o sorteio
    const back = JSON.parse(fs.readFileSync(zapsPath, 'utf8'));
    assert.strictEqual(back[0].instantReply, undefined, 'restauracao do zaps.json falhou');
  });

  // dono ja respondeu -> IA nao envia nada
  testAsync('fluxo: dono ja respondeu - IA NAO envia nada', async () => {
    clearCooldown();
    const s = snapshot();
    fetchHandler = () => googleOk('resposta que nao deve sair');
    fakeMgr.ownerReplied = true;
    try { await fakeMgr.cb(mkMsg()); } finally { fakeMgr.ownerReplied = false; }
    assert.strictEqual(sentMessages.length, s.sent, 'IA enviou mesmo com resposta do dono');
    assert.ok(newLogs(s).includes('Dono do numero ja respondeu'), 'log da checagem do dono ausente');
  });

  // horario de atendimento: fora da janela nada e enviado
  testAsync('fluxo: fora do horario de atendimento - nada e enviado', async () => {
    clearCooldown();
    const zapsPath = path.join(dataDir, 'zaps.json');
    const original = fs.readFileSync(zapsPath, 'utf8');
    const amanha = (new Date().getDay() + 1) % 7;
    fs.writeFileSync(zapsPath, JSON.stringify([
      { id: ZAP_ID, name: 'Teste', enabled: true, autoReply: true, personality: 'padrao',
        workHours: { enabled: true, start: '00:00', end: '23:59', days: [amanha] },
        providers: ['g1', 'o1'], selectedModels: [], model: 'auto', blockedContacts: [] }
    ], null, 2));

    const s = snapshot();
    fetchHandler = () => googleOk('nao deveria responder');
    await fakeMgr.cb(mkMsg());

    fs.writeFileSync(zapsPath, original);

    assert.strictEqual(sentMessages.length, s.sent, 'IA respondeu fora do horario');
    assert.strictEqual(fetchCalls.length, s.fetch, 'mensagem foi enviada a IA fora do horario');
    assert.ok(newLogs(s).includes('Fora do horario de atendimento'), 'log de fora do horario ausente');
  });

  // as vezes, resposta com varios baloes -> 1 saira citando a mensagem do cliente
  testAsync('fluxo: resposta com varios baloes pode sair com 1 mensagem citando', async () => {
    clearCooldown();
    const s = snapshot();
    fetchHandler = () => googleOk('Primeira parte[QUEBRA]Segunda parte');
    const origRandom = Math.random;
    Math.random = () => 0;
    try { await fakeMgr.cb(mkMsg()); } finally { Math.random = origRandom; }
    const enviados = sentMessages.slice(s.sent);
    assert.ok(enviados.length >= 2, `esperava varios baloes, veio ${enviados.length}`);
    assert.ok(enviados.some(m => m.quoted), 'nenhuma mensagem saiu citando a do cliente');
  });

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
