// Testes offline do ai-responder: respostas cortadas, texto lixo,
// nome do contato e limites de tokens - tudo com fetch simulado (sem rede,
// sem celular).
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, '..');
const AIResponder = require(path.join(root, 'src', 'js', 'ai-responder'));
const { verifyMessage } = require(path.join(root, 'src', 'js', 'message-guard'));

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
// 1b) verificador de mensagens (message-guard)
// ---------------------------------------------------------------
test('guard: codigo/JSON/XML/markdown reprovados', () => {
  assert.strictEqual(verifyMessage('```js\nconst a = 1;\n```').ok, false);
  assert.strictEqual(verifyMessage('{"reply":"Oi"}').ok, false);
  assert.strictEqual(verifyMessage('<tool_call>{"x":1}</tool_call>').ok, false);
  assert.strictEqual(verifyMessage('**Oi** tudo bem?').ok, false);
  assert.strictEqual(verifyMessage('- item um\n- item dois').ok, false);
});

test('guard: marcador interno vazado reprovado', () => {
  assert.strictEqual(verifyMessage('[SEND_IMAGE:img1]').ok, false);
  assert.strictEqual(verifyMessage('[QUEBRA] Oi').ok, false);
  assert.strictEqual(verifyMessage('[SEND_IMAGE:img1]Oi', { allowKnownMarkers: true }).ok, true);
  assert.strictEqual(verifyMessage('[MARCADOR_TORTO:1]Oi', { allowKnownMarkers: true }).ok, false);
});

test('guard: prompt/artefato vazado reprovado', () => {
  assert.strictEqual(verifyMessage('REGRAS DE RESPOSTA (IMPORTANTE): responda curto').ok, false);
  assert.strictEqual(verifyMessage('finish_reason=length max_tokens').ok, false);
  assert.strictEqual(verifyMessage('***').ok, false);
});

test('guard: ingles so bloqueia quando o cliente escreveu em PT', () => {
  assert.strictEqual(verifyMessage('Hello, how are you? Please let me know now.', { incoming: 'oi, tudo bem?' }).ok, false);
  assert.strictEqual(verifyMessage('Hello, how are you? Please let me know now.', { incoming: 'hello there' }).ok, true);
  assert.strictEqual(verifyMessage('Oi, tudo bem?', { incoming: 'oi' }).ok, true);
});

test('guard: frases normais de WhatsApp passam', () => {
  const ok = ['Oi, em que posso ajudar?', 'Sai por R$ 50, quer que eu reserve?',
    'Fechado, Joao! Ja te dou o retorno.', 'kkkkkk boa!', 'Sim! Ate as 13h.',
    'Deixa eu confirmar e ja te falo!'];
  for (const t of ok) assert.strictEqual(verifyMessage(t).ok, true, `reprovou frase legitima: ${t}`);
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

testAsync('guard: resposta reprovada pede de novo ao mesmo modelo e envia a corrigida', async () => {
  const ai = new AIResponder();
  let g = 0;
  mockFetch((req) => {
    if (isGoogle(req)) { g++; return googleOk(g === 1 ? '{"reply":"Oi"}' : 'Oi, em que posso ajudar?'); }
    return orOk('fallback');
  });
  const r = await ai.generateResponse(msg(), cfg(GOOGLE, GOOGLE.models[0]), providers);
  assert.strictEqual(r, 'Oi, em que posso ajudar?');
  assert.strictEqual(g, 2, 'esperava 2 chamadas ao Google (original + correcao)');
});

// ---------------------------------------------------------------
// 7) mensagens multiplas (separador [QUEBRA], teto de 4)
// ---------------------------------------------------------------
test('multiplas: resposta curta sem marcador vira UMA mensagem so', () => {
  const ai = new AIResponder();
  assert.deepStrictEqual(ai.splitMessages('Sai por R$ 50, quer que eu reserve?'), ['Sai por R$ 50, quer que eu reserve?']);
  assert.deepStrictEqual(ai.splitMessages('Oi, em que posso ajudar?'), ['Oi, em que posso ajudar?']);
});

test('multiplas: o exemplo do pedido (oi -> 3 baloes) funciona', () => {
  const r = new AIResponder().splitMessages('Ola, bom dia![QUEBRA]Bem-vindo a Dikassa![QUEBRA]Em que posso ajudar?');
  assert.deepStrictEqual(r, ['Ola, bom dia!', 'Bem-vindo a Dikassa!', 'Em que posso ajudar?']);
});

test('multiplas: NUNCA passa de 4 - excesso vira 4a mensagem', () => {
  const raw = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'].join('[QUEBRA]');
  const r = new AIResponder().splitMessages(raw);
  assert.strictEqual(r.length, 4, `esperava 4, veio ${r.length}`);
  assert.ok(r[3].includes('m4') && r[3].includes('m6'), 'excesso nao foi juntado na 4a mensagem');
});

test('multiplas: marcador com espaco/minusculo/variacoes e reconhecido', () => {
  const ai = new AIResponder();
  assert.deepStrictEqual(ai.splitMessages('Oi [quebra] Tudo bem?[BREAK]Sim!'), ['Oi', 'Tudo bem?', 'Sim!']);
  assert.deepStrictEqual(ai.splitMessages('Oi [MSG] Sim'), ['Oi', 'Sim']);
});

test('multiplas: marcador no comeco/fim nao cria balao vazio', () => {
  assert.deepStrictEqual(new AIResponder().splitMessages('[QUEBRA]Ola![QUEBRA]'), ['Ola!']);
  assert.deepStrictEqual(new AIResponder().splitMessages(''), []);
  assert.deepStrictEqual(new AIResponder().splitMessages('   '), []);
});

test('multiplas: texto GRANDE sem marcador separa por frases, sem perder nada', () => {
  const text = [
    'Hoje temos promocao em todos os acais da casa, com desconto direto no balcao.',
    'O combo de dois copos sai por apenas R$ 25 e ainda ganha um adicionador.',
    'Aceitamos pix, cartao de credito e dinheiro na entrega.',
    'A loja abre as 8h da manha e fecha as 22h da noite, todos os dias.',
    'Fazemos entrega em toda a regiao com taxa fixa de R$ 5.',
    'Para pedir e so chamar aqui que ja anotamos tudo.'
  ].join(' ');
  assert.ok(text.length > 300, 'texto do teste precisa passar do limiar');
  const r = new AIResponder().splitMessages(text);
  assert.ok(r.length >= 2 && r.length <= 4, `esperava 2..4 baloes, veio ${r.length}`);
  assert.strictEqual(r.join(' '), text, 'texto se perdeu na separacao');
  for (const p of r) assert.ok(!/^[a-z]/.test(p), `balao comeca no meio de uma frase: "${p}"`);
});

test('multiplas: texto grande SEM pontuacao nao e cortado no meio da palavra', () => {
  const r = new AIResponder().splitMessages('x'.repeat(420));
  assert.strictEqual(r.length, 1, 'nao da pra separar sem cortar frase');
});

test('multiplas: parte gigante unica da IA e aberta na fronteira de frase', () => {
  const s1 = 'Nosso cardapio tem acai pura, acai com granola, acai com frutas frescas e acai com leite condensado.';
  const s2 = 'Todos os tamanhos vem com calda extra por conta da casa e voce escolhe entre morango, banana e leite.';
  const s3 = 'O tamanho P sai por R$ 12, o M por R$ 18 e o G por R$ 24, com desconto de 10% no pix e entrega gratis acima de R$ 30.';
  const text = `${s1} ${s2} ${s3}`;
  assert.ok(text.length > 300, `texto do teste precisa passar do limiar (${text.length})`);
  const r = new AIResponder().splitMessages(text);
  assert.ok(r.length >= 2 && r.length <= 4, `esperava separacao, veio ${r.length} balao`);
  assert.strictEqual(r.join(' '), text);
  assert.ok(r[0].includes('granola'), 'quebrou fora da fronteira de frase');
});

test('prompt: instrucao de mensagens multiplas existe e e o ultimo bloco', () => {
  const s = new AIResponder().getSystemPrompt({ personality: 'padrao', trainings: [] });
  assert.ok(s.includes('[QUEBRA]'), 'instrucao do marcador ausente');
  assert.ok(s.includes('MAXIMO 4 mensagens'), 'teto de 4 mensagens ausente');
  assert.ok(s.indexOf('MENSAGENS MULTIPLAS (LEIA POR ULTIMO') > s.indexOf('FORMATO DA RESPOSTA'), 'bloco deve vir depois de FORMATO DA RESPOSTA');
  assert.strictEqual(s.split('MENSAGENS MULTIPLAS (LEIA POR ULTIMO').length - 1, 1, 'bloco duplicado');
});

test('prompt: saudacao permite divisao (caso do pedido)', () => {
  const s = new AIResponder().getSystemPrompt({ personality: 'padrao', trainings: [] });
  assert.ok(/Saudacao[^]*?ate 3 baloes/.test(s), 'regra de saudacao sem a permissao de dividir');
});

// ---------------------------------------------------------------
// 8) conversa natural (guia anti-robo)
// ---------------------------------------------------------------
test('natural: guia de conversa humana existe e vem antes do FORMATO', () => {
  const s = new AIResponder().getSystemPrompt({ personality: 'padrao', trainings: [] });
  assert.ok(s.includes('COMO UMA PESSOA REAL CONVERSA'), 'guia natural ausente');
  assert.ok(s.indexOf('COMO UMA PESSOA REAL CONVERSA') > s.indexOf('REGRA UNIVERSAL'), 'guia antes da regra universal');
  assert.ok(s.indexOf('COMO UMA PESSOA REAL CONVERSA') < s.indexOf('FORMATO DA RESPOSTA'), 'guia depois do FORMATO');
});

test('natural: regras essenciais do guia estao todas presentes', () => {
  const s = new AIResponder().getSystemPrompt({ personality: 'padrao', trainings: [] });
  const must = [
    'RESPOSTA PRIMEIRO',
    'O TAMANHO CERTO',
    'USE O CONTEXTO',
    'UMA PERGUNTA POR VEZ',
    'VARIE - NAO SEJA PREDIVEL',
    'ADAPTE A LINGUAGEM AO CLIENTE',
    'NAO INVENTE (FUNDAMENTAL)',
    'PERCEBA O ESTADO DO CLIENTE',
    'VENDA NATURAL',
    'FRASES PROIBIDAS'
  ];
  for (const m of must) assert.ok(s.includes(m), `regra ausente: ${m}`);
});

test('natural: exemplos robótico vs natural estao no prompt', () => {
  const s = new AIResponder().getSystemPrompt({ personality: 'padrao', trainings: [] });
  assert.ok(s.includes('Temos sim, voce quer o 13 normal ou o 13 Pro?'), 'exemplo natural ausente');
  assert.ok(s.includes('Gostaria de prosseguir com a compra?'), 'exemplo robotico ausente');
  assert.ok(s.includes('Tranquilo, qualquer coisa e so chamar'), 'exemplo de encerramento natural ausente');
  assert.ok(s.toLowerCase().includes('nao e escrever errado de proposito'), 'anti-erro-artificial ausente');
});

test('natural: vale para TODAS as personalidades e para prompt personalizado', () => {
  const ai = new AIResponder();
  for (const p of ['padrao', 'vendedor', 'especialista', 'atendente']) {
    const s = ai.getSystemPrompt({ personality: p, trainings: [] });
    assert.ok(s.includes('COMO UMA PESSOA REAL CONVERSA'), `personalidade ${p} sem o guia`);
  }
  const custom = ai.getSystemPrompt({ customPrompt: 'Prompt custom da loja.', trainings: [] });
  assert.ok(custom.includes('COMO UMA PESSOA REAL CONVERSA'), 'prompt personalizado sem o guia');
  assert.ok(custom.includes('Prompt custom da loja.'), 'o prompt custom foi perdido');
});

test('natural: regra rigida de "1 frase" foi substituida por tamanho adaptativo', () => {
  const s = new AIResponder().getSystemPrompt({ personality: 'padrao', trainings: [] });
  assert.ok(!s.includes('NO MAXIMO 1 frase'), 'regra rigida continua no prompt');
  assert.ok(s.includes('ADAPTE O TAMANHO'), 'nova regra de tamanho ausente');
  assert.ok(s.includes('paragrafo curto'), 'regra de explicacao maior ausente');
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
