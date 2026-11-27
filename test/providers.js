'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const {
  normalizeBaseUrl,
  buildProviderEndpoint,
  buildGoogleGenerateUrl,
  normalizeProvider,
  parseModelList,
  discoverProviderModels
} = require(path.join(__dirname, '..', 'src', 'core', 'providers'));
const AIResponder = require(path.join(__dirname, '..', 'src', 'js', 'ai-responder'));

let passed = 0;
const failures = [];
const pending = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`ok - ${name}`); }
  catch (error) { failures.push({ name, error: error.message }); console.log(`FAIL - ${name}\n      ${error.message}`); }
}
function testAsync(name, fn) { pending.push({ name, fn }); }

test('provider persistencia: handler criptografa o provedor dentro da lista', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(source.includes('encryptAllProvidersKeys([safe])'), 'save-provider deve passar uma lista para o cifrador de chaves');
});

test('provider url: normaliza base conhecida e monta endpoints OpenAI', () => {
  const base = normalizeBaseUrl('https://api.openai.com');
  assert.strictEqual(base, 'https://api.openai.com/v1');
  assert.strictEqual(buildProviderEndpoint(base, 'models'), 'https://api.openai.com/v1/models');
  assert.strictEqual(buildProviderEndpoint(base, 'chat/completions'), 'https://api.openai.com/v1/chat/completions');
  assert.strictEqual(
    buildProviderEndpoint('https://exemplo.com/api/v1/', 'chat/completions'),
    'https://exemplo.com/api/v1/chat/completions'
  );
});

test('provider url: rejeita protocolo invalido e credenciais na URL', () => {
  assert.throws(() => normalizeBaseUrl('file:///tmp/modelo'), /http/);
  assert.throws(() => normalizeBaseUrl('https://usuario:senha@exemplo.com/v1'), /Chave API/);
});

test('provider modelos: normaliza, remove duplicadas por erro e preserva chaves extras', () => {
  const provider = normalizeProvider({
    id: 'p1',
    name: 'Minha API',
    type: 'openai',
    baseUrl: 'https://api.exemplo.com/v1',
    apiKey: 'chave-nova',
    models: [{ id: 'modelo/a', name: 'Modelo A' }, 'modelo-b']
  }, {
    id: 'p1',
    name: 'Nome antigo',
    apiKey: 'chave-antiga',
    apiKeys: ['chave-antiga', 'chave-reserva'],
    apiKeyNames: ['Principal', 'Reserva'],
    models: [{ id: 'velho', name: 'Velho' }]
  });
  assert.deepStrictEqual(provider.models.map((model) => model.id), ['modelo/a', 'modelo-b']);
  assert.deepStrictEqual(provider.apiKeys, ['chave-nova', 'chave-antiga', 'chave-reserva']);
  assert.strictEqual(provider.baseUrl, 'https://api.exemplo.com/v1');
  assert.throws(() => normalizeProvider({
    id: 'p2', name: 'Duplicada', baseUrl: 'https://api.exemplo.com/v1',
    models: [{ id: 'x' }, { id: 'x' }]
  }), /modelo duplicado/);
});

test('provider descoberta: interpreta OpenAI, Google e Ollama', () => {
  assert.deepStrictEqual(parseModelList({ data: [{ id: 'gpt-x', name: 'GPT X' }] }, 'openai'), [
    { id: 'gpt-x', name: 'GPT X', free: false }
  ]);
  assert.deepStrictEqual(parseModelList({ models: [{ name: 'models/gemini-x', displayName: 'Gemini X' }] }, 'google'), [
    { id: 'gemini-x', name: 'Gemini X', free: false }
  ]);
  assert.deepStrictEqual(parseModelList({ models: [{ name: 'llama3.2', model: 'llama3.2' }] }, 'openai'), [
    { id: 'llama3.2', name: 'llama3.2', free: false }
  ]);
});

testAsync('provider descoberta: faz GET real em /models com Bearer', async () => {
  let call = null;
  const models = await discoverProviderModels({
    name: 'Minha API',
    type: 'openai',
    baseUrl: 'https://api.exemplo.com/v1',
    apiKey: 'segredo'
  }, {
    fetchImpl: async (url, options) => {
      call = { url, options };
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'modelo-real' }] }) };
    }
  });
  assert.strictEqual(call.url, 'https://api.exemplo.com/v1/models');
  assert.strictEqual(call.options.headers.Authorization, 'Bearer segredo');
  assert.strictEqual(models[0].id, 'modelo-real');
});

testAsync('provider descoberta: Google usa key na URL e nao vaza no header', async () => {
  let call = null;
  await discoverProviderModels({
    name: 'Google AI Studio',
    type: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: 'chave-google'
  }, {
    fetchImpl: async (url, options) => {
      call = { url, options };
      return { ok: true, status: 200, json: async () => ({ models: [{ name: 'models/gemini-real', displayName: 'Gemini Real' }] }) };
    }
  });
  assert.ok(call.url.includes('/v1beta/models?key=chave-google'));
  assert.strictEqual(call.options.headers.Authorization, undefined);
});

testAsync('provider runtime: modelo com barra usa URL customizada e nao vaza chave ao OpenRouter', async () => {
  const realFetch = global.fetch;
  let call = null;
  global.fetch = async (url, options) => {
    call = { url, options };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Conexao funcionando.' }, finish_reason: 'stop' }] }) };
  };
  try {
    const ai = new AIResponder();
    const provider = {
      id: 'custom', name: 'Meu Provedor', type: 'openai',
      baseUrl: 'https://meu-provedor.com/api/v1', apiKey: 'chave-customizada'
    };
    const text = await ai.callAI(provider, { id: 'fornecedor/modelo-x' }, provider.apiKey, [
      { role: 'user', content: 'oi' }
    ]);
    assert.strictEqual(text, 'Conexao funcionando.');
    assert.strictEqual(call.url, 'https://meu-provedor.com/api/v1/chat/completions');
    assert.strictEqual(call.options.headers.Authorization, 'Bearer chave-customizada');
    assert.strictEqual(JSON.parse(call.options.body).model, 'fornecedor/modelo-x');
  } finally {
    global.fetch = realFetch;
  }
});

test('provider zap: selecao por id encontra provedor correto', () => {
  const ai = new AIResponder();
  const providers = [
    { id: 'p1', name: 'Provedor 1', apiKey: 'k1', models: [{ id: 'm1' }] },
    { id: 'p2', name: 'Provedor 2', apiKey: 'k2', models: [{ id: 'm2' }] }
  ];
  const list = ai.getModelsToTry({ providers: ['p2'], model: 'p2|m2', autoSwitch: false }, providers);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].provider.id, 'p2');
  assert.strictEqual(list[0].model.id, 'm2');
});

test('provider google: monta generateContent com id exato', () => {
  const url = buildGoogleGenerateUrl('https://generativelanguage.googleapis.com/v1beta', 'gemini-x', 'chave');
  assert.strictEqual(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent?key=chave');
});

testAsync('provider integracao: descoberta e chat usam HTTP real em URL customizada', async () => {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      calls.push({ url: req.url, method: req.method, headers: req.headers, body: body ? JSON.parse(body) : null });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1/models') {
        res.end(JSON.stringify({ data: [{ id: 'modelo-http-real', name: 'Modelo HTTP Real' }] }));
        return;
      }
      if (req.url === '/v1/chat/completions') {
        res.end(JSON.stringify({ choices: [{ message: { content: 'Resposta real do servidor local.' }, finish_reason: 'stop' }] }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: 'rota nao encontrada' } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    const models = await discoverProviderModels({ name: 'Servidor Local', type: 'openai', baseUrl, apiKey: 'chave-real' });
    assert.strictEqual(models[0].id, 'modelo-http-real');
    const ai = new AIResponder();
    const text = await ai.callAI(
      { id: 'local', name: 'Servidor Local', type: 'openai', baseUrl, apiKey: 'chave-real' },
      { id: 'modelo-http-real' },
      'chave-real',
      [{ role: 'user', content: 'Teste real' }]
    );
    assert.strictEqual(text, 'Resposta real do servidor local.');
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0].headers.authorization, 'Bearer chave-real');
    assert.strictEqual(calls[1].body.model, 'modelo-http-real');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

(async () => {
  for (const item of pending) {
    try { await item.fn(); passed++; console.log(`ok - ${item.name}`); }
    catch (error) { failures.push({ name: item.name, error: error.message }); console.log(`FAIL - ${item.name}\n      ${error.message}`); }
  }
  console.log(`\n${passed} teste(s) passaram`);
  if (failures.length) {
    console.error(`${failures.length} teste(s) falharam`);
    process.exit(1);
  }
  console.log('TODOS OS TESTES DE PROVEDORES PASSARAM');
})();
