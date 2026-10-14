// Teste do Agente IA do Dashboard (src/js/app-agent.js)
// Sem electron e sem janela: so o agente + fetch simulado.
// Cobre: parse de ferramenta, pergunta simples, add_zap, send_message,
// ferramenta desconhecida, get_stats, block_contact, mencao @ e erro
// de provedor sem chave.
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, '..');
const AppAgent = require(path.join(root, 'src', 'js', 'app-agent'));

const pending = [];
let passed = 0;
const failures = [];
const realLog = console.log;
const out = (...a) => realLog(...a);
function testAsync(name, fn) { pending.push({ name, fn }); }

// ---------------------------------------------------------------
// fetch simulado com roteiro de respostas (fila)
// ---------------------------------------------------------------
let fetchQueue = [];
let fetchCalls = [];
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const req = { url: String(url), body: opts && opts.body ? JSON.parse(opts.body) : null };
  fetchCalls.push(req);
  const item = fetchQueue.shift();
  const res = typeof item === 'function' ? item(req) : (item || {});
  return { ok: res.ok !== false, status: res.status || 200, json: async () => res.json || {} };
};
const googleOk = (text) => ({ json: { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] } });

// ---------------------------------------------------------------
// dados em memoria (zaps, treinamentos, contatos, historico)
// ---------------------------------------------------------------
let zaps = [{
  id: 1, name: 'Teste', phone: '5532999344496',
  enabled: true, autoReply: true, personality: 'padrao',
  blockedContacts: ['5511111111111']
}];
let trainings = { '1': [{ id: 'tr_1', title: 'Precos', content: 'Tudo R$ 10', images: [], links: [], enabled: true }] };
const providers = [{ id: 'g1', name: 'Google AI Studio', apiKeys: ['kg'], models: [{ id: 'gemini-a' }] }];
const sent = [];
const now = Date.now();
const store = {
  conversations: [{
    zapId: '1',
    chatId: '553298482734@c.us',
    messages: [
      { role: 'user', content: 'oi', at: now },
      { role: 'assistant', content: 'ola', at: now },
      { role: 'assistant', content: 'tudo bem?', at: now }
    ]
  }],
  clearForZap() {}
};

const fakeWhats = {
  getStatus: (id) => ({ status: String(id) === '1' ? 'ready' : 'disconnected' }),
  sendMessage: async (zapId, phone, text) => { sent.push({ zapId, phone, text }); return { success: true }; },
  getConversations: (zapId) => (String(zapId) === '1'
    ? [{ chatId: '5511988887777@c.us', contact: { name: 'Maria Silva', number: '5511988887777' } }]
    : [])
};

function makeAgent(provs) {
  return new AppAgent({
    getProviders: () => provs || providers,
    resolveProviderKey: (p) => {
      if (p && p.apiKeys && p.apiKeys.length) return { ...p, apiKey: p.apiKeys[0] };
      if (p && p.apiKey) return p;
      return p;
    },
    loadZaps: () => zaps,
    saveZaps: (d) => { zaps = d; },
    loadTrainings: () => trainings,
    saveTrainings: (d) => { trainings = d; },
    getConversationStore: () => store,
    whatsapp: fakeWhats
  });
}
const agent = makeAgent();

function sysTextOf(call) {
  const si = call && call.body && call.body.systemInstruction;
  return ((si && si.parts) || []).map(p => p.text).join('\n');
}
function bodyTextOf(call) {
  const contents = (call && call.body && call.body.contents) || [];
  const texts = [];
  for (const c of contents) {
    for (const p of ((c && c.parts) || [])) {
      if (p && typeof p.text === 'string') texts.push(p.text);
    }
  }
  return texts.join('\n');
}

// ---------------------------------------------------------------
async function run() {
  // A) parse de ferramenta
  testAsync('agente: parseTool com json puro, markdown e texto misturado', () => {
    const t1 = agent.parseTool('{"tool":"list_zaps","args":{}}');
    assert.strictEqual(t1.tool, 'list_zaps');
    const t2 = agent.parseTool('```json\n{"tool":"add_zap","args":{"name":"X"}}\n```');
    assert.strictEqual(t2.tool, 'add_zap');
    assert.strictEqual(t2.args.name, 'X');
    const t3 = agent.parseTool('Vou criar agora.\n{"tool":"block_contact","args":{"zap":"Teste","number":"5511"}}');
    assert.strictEqual(t3.tool, 'block_contact');
    assert.strictEqual(t3.args.zap, 'Teste');
    assert.strictEqual(agent.parseTool('Oi! Em que posso ajudar?'), null);
    assert.strictEqual(agent.parseTool(''), null);
  });

  // B) pergunta simples: sem ferramenta, estado no prompt
  testAsync('agente: pergunta simples responde texto puro com estado no prompt', async () => {
    fetchQueue = [googleOk('Oi! Sou o agente do seu app.')];
    const before = fetchCalls.length;
    const res = await agent.run({ message: 'Quem e voce?' });
    assert.strictEqual(res.reply, 'Oi! Sou o agente do seu app.');
    assert.strictEqual(res.steps.length, 0);
    const sys = sysTextOf(fetchCalls[before]);
    assert.ok(sys.includes('nome="Teste"'), 'zap do estado ausente no prompt');
    assert.ok(sys.includes('ESTATISTICAS DE HOJE'), 'estatisticas ausentes no prompt');
    assert.ok(sys.includes('send_message'), 'ferramentas ausentes no prompt');
  });

  // C) add_zap: executa e persiste
  testAsync('agente: add_zap cria o Zap e salva', async () => {
    fetchQueue = [
      googleOk('{"tool":"add_zap","args":{"name":"Vendas","phone":"5511999998888"}}'),
      googleOk('Zap Vendas criado com sucesso!')
    ];
    const res = await agent.run({ message: 'Crie um zap Vendas 5511999998888' });
    assert.strictEqual(res.steps.length, 1);
    assert.strictEqual(res.steps[0].tool, 'add_zap');
    assert.strictEqual(res.steps[0].ok, true);
    assert.strictEqual(res.reply, 'Zap Vendas criado com sucesso!');
    assert.strictEqual(zaps.length, 2);
    assert.strictEqual(zaps[0].name, 'Vendas');
    assert.strictEqual(zaps[0].phone, '5511999998888');
    assert.ok(Array.isArray(zaps[0].blockedContacts));
    assert.deepStrictEqual(zaps[0].providers, ['g1'], 'provedores com chave nao vieram por padrao');
  });

  // D) send_message: envia pelo zap conectado
  testAsync('agente: send_message envia pelo zap conectado', async () => {
    fetchQueue = [
      googleOk('{"tool":"send_message","args":{"zap":"Teste","number":"+5511888887777","texto":"Ola!"}}'),
      googleOk('Mensagem enviada.')
    ];
    const res = await agent.run({ message: 'Manda Ola pra Maria no zap Teste' });
    assert.strictEqual(res.steps[0].ok, true);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].zapId, '1');
    assert.strictEqual(sent[0].phone, '+5511888887777');
    assert.strictEqual(sent[0].text, 'Ola!');
    assert.strictEqual(res.reply, 'Mensagem enviada.');
  });

  // E) zap desconectado: envio falha com aviso claro
  testAsync('agente: send_message em zap desconectado volta ok:false', async () => {
    fetchQueue = [
      googleOk('{"tool":"send_message","args":{"zap":"Vendas","number":"5511888887777","texto":"Oi"}}'),
      googleOk('O zap Vendas nao esta conectado.')
    ];
    const res = await agent.run({ message: 'Manda Ola pelo zap Vendas' });
    assert.strictEqual(res.steps[0].ok, false);
    assert.ok(/conectado/.test(res.steps[0].info), 'aviso de desconexao ausente');
    assert.strictEqual(sent.length, 1, 'nao deveria ter enviado nada');
    assert.strictEqual(res.reply, 'O zap Vendas nao esta conectado.');
  });

  // F) ferramenta desconhecida vira erro alimentado de volta ao modelo
  testAsync('agente: ferramenta desconhecida retorna erro sem quebrar', async () => {
    fetchQueue = [
      googleOk('{"tool":"voar","args":{}}'),
      googleOk('Nao tenho essa ferramenta.')
    ];
    const res = await agent.run({ message: 'Voa ai' });
    assert.strictEqual(res.steps[0].ok, false);
    assert.ok(/desconhecida/.test(res.steps[0].info));
    assert.strictEqual(res.reply, 'Nao tenho essa ferramenta.');
  });

  // G) get_stats alimenta contagens reais de hoje
  testAsync('agente: get_stats devolve contagens de hoje', async () => {
    fetchQueue = [
      googleOk('{"tool":"get_stats","args":{}}'),
      googleOk('Hoje a IA respondeu 2 mensagens.')
    ];
    const before = fetchCalls.length;
    const res = await agent.run({ message: 'Quantas mensagens a IA respondeu hoje?' });
    assert.strictEqual(res.steps[0].ok, true);
    const resultMsg = bodyTextOf(fetchCalls[before + 1]);
    assert.ok(resultMsg.includes('"respostasIA":2'), 'respostasIA != 2: ' + resultMsg.substring(0, 300));
    assert.ok(resultMsg.includes('"recebidas":1'), 'recebidas != 1');
    assert.ok(resultMsg.includes('Teste'), 'nome do zap ausente no resultado');
    assert.strictEqual(res.reply, 'Hoje a IA respondeu 2 mensagens.');
  });

  // H) block_contact persiste no zap
  testAsync('agente: block_contact adiciona o numero', async () => {
    fetchQueue = [
      googleOk('{"tool":"block_contact","args":{"zap":"Teste","number":"5511777776666"}}'),
      googleOk('Numero bloqueado no zap Teste.')
    ];
    const res = await agent.run({ message: 'Bloqueia 5511777776666 no zap Teste' });
    assert.strictEqual(res.steps[0].ok, true);
    assert.ok(zaps.find(z => z.name === 'Teste').blockedContacts.includes('5511777776666'));
    assert.strictEqual(res.reply, 'Numero bloqueado no zap Teste.');
  });

  // I) mencao @ vai resolvida para o modelo
  testAsync('agente: mencao @ e passada resolvida no prompt', async () => {
    fetchQueue = [googleOk('Beleza, ja anotei a Maria.')];
    const before = fetchCalls.length;
    const res = await agent.run({
      message: 'Manda um oi pra @maria',
      mentions: [{ token: '@maria', name: 'maria', number: '5511988887777' }]
    });
    const sys = sysTextOf(fetchCalls[before]);
    assert.ok(sys.includes('@maria'), 'mencao ausente no prompt');
    assert.ok(sys.includes('5511988887777'), 'numero da mencao ausente no prompt');
    assert.strictEqual(res.reply, 'Beleza, ja anotei a Maria.');
  });

  // J) search_contacts acha contato nas conversas
  testAsync('agente: search_contacts encontra Maria', async () => {
    fetchQueue = [
      googleOk('{"tool":"search_contacts","args":{"query":"maria"}}'),
      googleOk('Achei: Maria Silva +5511988887777')
    ];
    const before = fetchCalls.length;
    const res = await agent.run({ message: 'Ache a Maria' });
    assert.strictEqual(res.steps[0].ok, true);
    const resultMsg = bodyTextOf(fetchCalls[before + 1]);
    assert.ok(resultMsg.includes('5511988887777'), 'numero da Maria ausente no resultado');
    assert.strictEqual(res.reply, 'Achei: Maria Silva +5511988887777');
  });

  // K) sem chave de API: erro claro
  testAsync('agente: sem provedor com chave retorna erro claro', async () => {
    const semChave = makeAgent([{ id: 'g1', name: 'Google AI Studio', apiKeys: [], models: [{ id: 'gemini-a' }] }]);
    let erro = null;
    try {
      await semChave.run({ message: 'Ola' });
    } catch (e) {
      erro = e;
    }
    assert.ok(erro, 'deveria ter lancado erro');
    assert.ok(/provedor de IA com chave/.test(erro.message), 'mensagem errada: ' + erro.message);
  });

  // L) historico local entra na conversa
  testAsync('agente: historico enviado entra nas mensagens', async () => {
    fetchQueue = [googleOk('Certo!')];
    const before = fetchCalls.length;
    await agent.run({
      message: 'e agora?',
      history: [
        { role: 'user', content: 'crie um zap' },
        { role: 'assistant', content: 'zap criado' }
      ]
    });
    const body = fetchCalls[before].body;
    const contents = JSON.stringify(body.contents || []);
    assert.ok(contents.includes('crie um zap'), 'historico user ausente');
    assert.ok(contents.includes('zap criado'), 'historico assistant ausente');
    assert.ok(contents.includes('e agora?'), 'mensagem atual ausente');
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
