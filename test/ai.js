// Testes offline do ai-responder: respostas cortadas, texto lixo,
// nome do contato e limites de tokens - tudo com fetch simulado (sem rede,
// sem celular).
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, '..');
const AIResponder = require(path.join(root, 'src', 'js', 'ai-responder'));

const pending = [];
let passed = 0;
const failures = [];

function test(name, fn) {
  try { fn(); passed++; } catch (e) { failures.push({ name, error: e.message }); }
}
function testAsync(name, fn) { pending.push({ name, fn }); }

// ---------------------------------------------------------------
// fetch simulado
// ---------------------------------------------------------------
const realFetch = global.fetch;
let fetchCalls = [];
let fetchHandler = null;

function mockFetch(handler) {
  fetchCalls = [];
  fetchHandler = handler;
  global.fetch = async (url, opts) => {
    const req = { url: String(url), body: opts && opts.body ? JSON.parse(opts.body) : null };
    fetchCalls.push(req);
    const res = fetchHandler(req, fetchCalls.length) || {};
    return {
      ok: res.ok !== false,
      status: res.status || 200,
      json: async () => res.json || {}
    };
  };
}

// helpers de resposta
const googleOk = (text) => ({ json: { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] } });
const googleTruncated = (text) => ({ json: { candidates: [{ content: { parts: [{ text }] }, finishReason: 'MAX_TOKENS' }] } });
const googleThought = (thought, visible) => ({
  json: { candidates: [{ content: { parts: [{ text: thought, thought: true }, { text: visible }] }, finishReason: 'STOP' }] }
});
const orOk = (text) => ({ json: { choices: [{ message: { content: text }, finish_reason: 'stop' }] } });
const orTruncated = (text) => ({ json: { choices: [{ message: { content: text }, finish_reason: 'length' }] } });
const isGoogle = (req) => req.url.includes('generativelanguage');
const isOpenRouter = (req) => req.url.includes('openrouter');

const GOOGLE = { id: 'g1', name: 'Google AI Studio', apiKey: 'kg', models: [{ id: 'gemini-a' }] };
const OPENROUTER = { id: 'o1', name: 'OpenRouter', apiKey: 'ko', models: [{ id: 'meta/llama', free: true }] };
const providers = [GOOGLE, OPENROUTER];

function cfg(provider, model) {
  return { aiName: '', personality: 'padrao', area: '', customPrompt: '', provider, model, trainings: [] };
}
function msg(over) {
  return Object.assign({
    zapId: 'Z1',
    body: 'oi',
    from: '553298482734@c.us',
    chat: { id: '553298482734@c.us' },
    contact: { name: 'Joao Silva', number: '553298482734' }
  }, over || {});
}
function promptOf(call) {
  if (!call) return '';
  if (call.body && call.body.systemInstruction) return call.body.systemInstruction.parts[0].text;
  const sys = (call.body && call.body.messages || []).find(m => m.role === 'system');
  return sys ? sys.content : '';
}

// ---------------------------------------------------------------
// 1) texto lixo
// ---------------------------------------------------------------
test('junk: "Check Constreainsts:*** Max" e descartado', () => {
  assert.strictEqual(new AIResponder().isJunkResponse('Check Constreainsts:*** Max'), true);
});
test('junk: resto do vocabulario de erro e descartado', () => {
  const ai = new AIResponder();
  assert.strictEqual(ai.isJunkResponse('finish_reason: length'), true);
  assert.strictEqual(ai.isJunkResponse('Quota exceeded, too many requests'), true);
  assert.strictEqual(ai.isJunkResponse('[object Object]'), true);
  assert.strictEqual(ai.isJunkResponse('thought=true'), true);
  assert.strictEqual(ai.isJunkResponse(''), true);
});
test('junk: resposta normal NAO e descartada', () => {
  const ai = new AIResponder();
  assert.strictEqual(ai.isJunkResponse('Oi, em que posso ajudar?'), false);
  assert.strictEqual(ai.isJunkResponse('Sai por R$ 50, quer que eu reserve?'), false);
  assert.strictEqual(ai.isJunkResponse('Fechado, Joao! Ja te dou o retorno.'), false);
  assert.strictEqual(ai.isJunkResponse('kkkkkk boa!'), false);
});

// ---------------------------------------------------------------
// 2) corte de texto
// ---------------------------------------------------------------
test('corte: texto sem pontuacao final devolve null (nunca vai ao cliente)', () => {
  assert.strictEqual(new AIResponder().finishTruncated('Ola eu sou o Jota da'), null);
  assert.strictEqual(new AIResponder().finishTruncated(''), null);
});
test('corte: texto completo volta inteiro', () => {
  const t = 'Oi, Joao. Sua solicitacao foi registrada com sucesso.';
  assert.strictEqual(new AIResponder().finishTruncated(t), t);
});
test('corte: corta na ultima frase completa', () => {
  assert.strictEqual(
    new AIResponder().finishTruncated('Sai por R$ 50. Quero ver o cardapio tambem'),
    'Sai por R$ 50.'
  );
});

// ---------------------------------------------------------------
// 3) Google (Gemini)
// ---------------------------------------------------------------
testAsync('google: resposta normal volta inteira com 2048 tokens', async () => {
  const ai = new AIResponder();
  mockFetch((req) => (isGoogle(req) ? googleOk('Oi, Joao, em que posso ajudar?') : orOk('fallback')));
  const r = await ai.generateResponse(msg(), cfg(GOOGLE, GOOGLE.models[0]), providers);
  const g = fetchCalls.find(isGoogle);
  assert.ok(g, 'chamada ao Google nao aconteceu');
  assert.strictEqual(g.body.generationConfig.maxOutputTokens, 2048, 'maxOutputTokens != 2048');
  assert.strictEqual(r, 'Oi, Joao, em que posso ajudar?');
});

testAsync('google: pensamento oculto (thought) nunca aparece na resposta', async () => {
  const ai = new AIResponder();
  mockFetch((req) => (isGoogle(req) ? googleThought('Check Constreainsts:*** Max tokens', 'Oi, em que posso ajudar?') : orOk('fallback')));
  const r = await ai.generateResponse(msg(), cfg(GOOGLE, GOOGLE.models[0]), providers);
  assert.strictEqual(r, 'Oi, em que posso ajudar?');
  assert.ok(!String(r).includes('Constreainsts'), 'texto de pensamento vazou');
});

testAsync('google: corte MAX_TOKENS sem frase completa -> fallback pro proximo modelo', async () => {
  const ai = new AIResponder();
  mockFetch((req) => (isGoogle(req) ? googleTruncated('Ola eu sou o Jota da') : orOk('Tudo certo por aqui, posso te ajudar?')));
  const r = await ai.generateResponse(msg(), cfg(GOOGLE, GOOGLE.models[0]), providers);
  assert.strictEqual(r, 'Tudo certo por aqui, posso te ajudar?');
  assert.strictEqual(fetchCalls.length, 2, 'esperava 2 chamadas (google + fallback)');
  assert.ok(!r.includes('Jota da'), 'texto cortado foi ao cliente');
});

testAsync('google: corte MAX_TOKENS com frase completa -> envia a frase inteira', async () => {
  const ai = new AIResponder();
  mockFetch((req) => (isGoogle(req) ? googleTruncated('Sai por R$ 50. Quero ver o cardapio tambem') : orOk('fallback')));
  const r = await ai.generateResponse(msg(), cfg(GOOGLE, GOOGLE.models[0]), providers);
  assert.strictEqual(r, 'Sai por R$ 50.');
  assert.strictEqual(fetchCalls.length, 1, 'nao deveria ter precisado de fallback');
});

// ---------------------------------------------------------------
// 4) OpenRouter
// ---------------------------------------------------------------
testAsync('openrouter: 2048 tokens e corte finish_reason=length tratado', async () => {
  const ai = new AIResponder();
  mockFetch((req) => (isOpenRouter(req) ? orTruncated('Sai por R$ 50. Quero ver mais') : googleOk('fallback')));
  const r = await ai.generateResponse(msg(), cfg(OPENROUTER, OPENROUTER.models[0]), providers);
  const o = fetchCalls.find(isOpenRouter);
  assert.ok(o, 'chamada ao OpenRouter nao aconteceu');
  assert.strictEqual(o.body.max_tokens, 2048, 'max_tokens != 2048');
  assert.strictEqual(r, 'Sai por R$ 50.');
});

testAsync('openrouter: corte sem frase completa -> fallback pro Google', async () => {
  const ai = new AIResponder();
  mockFetch((req) => (isOpenRouter(req) ? orTruncated('Ola eu sou o Jota da') : googleOk('Ola, em que posso ajudar?')));
  const r = await ai.generateResponse(msg(), cfg(OPENROUTER, OPENROUTER.models[0]), providers);
  assert.strictEqual(r, 'Ola, em que posso ajudar?');
  assert.ok(!r.includes('Jota da'));
});

// ---------------------------------------------------------------
// 5) nome do contato no prompt
// ---------------------------------------------------------------
testAsync('nome: contato com nome vira NOME DO CLIENTE no system prompt', async () => {
  const ai = new AIResponder();
  mockFetch((req) => (isGoogle(req) ? googleOk('Oi!') : orOk('fallback')));
  await ai.generateResponse(msg({ contact: { name: 'Joao Silva', number: '553298482734' } }), cfg(GOOGLE, GOOGLE.models[0]), providers);
  const sys = promptOf(fetchCalls.find(isGoogle));
  assert.ok(sys.includes('NOME DO CLIENTE: Joao Silva'), 'nome do contato ausente no prompt');
  assert.ok(sys.includes('Joao,'), 'exemplo usando o primeiro nome ausente');
});

testAsync('nome: "Desconhecido" nao vira NOME DO CLIENTE', async () => {
  const ai = new AIResponder();
  mockFetch((req) => (isGoogle(req) ? googleOk('Oi!') : orOk('fallback')));
  await ai.generateResponse(msg({ contact: { name: 'Desconhecido', number: '' } }), cfg(GOOGLE, GOOGLE.models[0]), providers);
  assert.ok(!promptOf(fetchCalls.find(isGoogle)).includes('NOME DO CLIENTE'));
});

testAsync('nome: numero puro (contato sem nome) nao vira NOME DO CLIENTE', async () => {
  const ai = new AIResponder();
  mockFetch((req) => (isGoogle(req) ? googleOk('Oi!') : orOk('fallback')));
  await ai.generateResponse(msg({ contact: { number: '5532999344496' } }), cfg(GOOGLE, GOOGLE.models[0]), providers);
  assert.ok(!promptOf(fetchCalls.find(isGoogle)).includes('NOME DO CLIENTE'));
});

// ---------------------------------------------------------------
// 6) resposta lixa do modelo
// ---------------------------------------------------------------
testAsync('junk: lixa do modelo primario nao vai ao cliente - usa o fallback', async () => {
  const ai = new AIResponder();
  mockFetch((req) => (isGoogle(req) ? googleOk('Check Constreainsts:*** Max') : orOk('Blz, te respondo ja ja!')));
  const r = await ai.generateResponse(msg(), cfg(GOOGLE, GOOGLE.models[0]), providers);
  assert.strictEqual(r, 'Blz, te respondo ja ja!');
  assert.ok(!r.includes('Constreainsts'));
});

testAsync('junk: todos os modelos lixo -> devolve null (main envia erro padrao)', async () => {
  const ai = new AIResponder();
  mockFetch((req) => (isGoogle(req) ? googleOk('Check Constreainsts:*** Max') : orOk('finish_reason=length max_tokens')));
  const r = await ai.generateResponse(msg(), cfg(GOOGLE, GOOGLE.models[0]), providers);
  assert.strictEqual(r, null);
});

async function runPending() {
  for (const p of pending) {
    try {
      await p.fn();
      passed++;
    } catch (e) {
      failures.push({ name: p.name, error: e.message });
    }
  }
  global.fetch = realFetch;

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
