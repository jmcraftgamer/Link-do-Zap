// Testes do download/descriptografia manual de audio do WhatsApp
const assert = require('assert');
const crypto = require('crypto');
const path = require('path');

const { decryptWhatsAppMedia } = require(path.join(__dirname, '..', 'src', 'js', 'media-crypto'));
const WhatsAppManager = require(path.join(__dirname, '..', 'src', 'js', 'whatsapp-manager'));
const AIResponder = require(path.join(__dirname, '..', 'src', 'js', 'ai-responder'));
const { sanitizeMessage, sanitizeMessages } = require(path.join(__dirname, '..', 'src', 'core', 'audio-history'));

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

function encryptMedia(plain, mediaKey, type) {
  const info = type === 'ptt' || type === 'audio'
    ? 'WhatsApp Audio Keys'
    : 'WhatsApp Image Keys';
  const derived = Buffer.from(
    crypto.hkdfSync('sha256', mediaKey, Buffer.alloc(32), Buffer.from(info), 112)
  );
  const iv = derived.subarray(0, 16);
  const cipherKey = derived.subarray(16, 48);
  const macKey = derived.subarray(48, 80);
  const cipher = crypto.createCipheriv('aes-256-cbc', cipherKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const mac = crypto
    .createHmac('sha256', macKey)
    .update(Buffer.concat([iv, ciphertext]))
    .digest()
    .subarray(0, 10);
  return Buffer.concat([ciphertext, mac]);
}

test('descriptografa audio ptt com mediaKey', () => {
  const mediaKey = crypto.randomBytes(32);
  const plain = Buffer.from('audio-de-teste-ogg-opus');
  const enc = encryptMedia(plain, mediaKey, 'ptt');
  const out = decryptWhatsAppMedia(enc, mediaKey, 'ptt');
  assert.deepStrictEqual(out, plain);
});

test('aceita midia e chave em base64 (formato vindo da pagina)', () => {
  const mediaKey = crypto.randomBytes(32);
  const plain = Buffer.from('outro-audio');
  const enc = encryptMedia(plain, mediaKey, 'audio');
  const out = decryptWhatsAppMedia(enc.toString('base64'), mediaKey.toString('base64'), 'audio');
  assert.deepStrictEqual(out, plain);
});

test('rejeita assinatura invalida', () => {
  const mediaKey = crypto.randomBytes(32);
  const enc = encryptMedia(Buffer.from('audio'), mediaKey, 'ptt');
  enc[enc.length - 1] ^= 0xFF;
  assert.throws(
    () => decryptWhatsAppMedia(enc, mediaKey, 'ptt'),
    /assinatura da midia nao confere/
  );
});

test('rejeita mediaKey com tamanho errado', () => {
  assert.throws(
    () => decryptWhatsAppMedia(Buffer.alloc(20), Buffer.alloc(16), 'ptt'),
    /mediaKey invalida/
  );
});

async function testRegressaoMimetypePtt() {
  const mediaId = '3EB0AUDIO123';
  const chatId = '5532999999999@s.whatsapp.net';
  const serialized = `false_${chatId}_${mediaId}`;
  const audio = {
    data: Buffer.from([1, 2, 3]),
    mimetype: 'audio/ogg; codecs=opus',
  };
  const internal = {
    id: { id: mediaId, remote: chatId, fromMe: false, _serialized: serialized },
    type: 'ptt',
    mimetype: audio.mimetype,
    mediaData: { mediaStage: 'RESOLVED' },
    directPath: '/v/t62.7118-24/audio',
    encFilehash: 'enc',
    filehash: 'hash',
    mediaKey: new Uint8Array(32),
    mediaKeyTimestamp: 1,
    size: audio.data.length,
  };
  const fakeWindow = {
    require(name) {
      if (name === 'WAWebCollections') {
        return {
          Msg: {
            get: () => internal,
            getMessagesById: async () => ({ messages: [internal] }),
          },
          Chat: { get: () => null },
        };
      }
      if (name === 'WAWebWidFactory') return { createWid: (v) => v };
      if (name === 'WAWebDownloadManager') {
        return {
          downloadManager: {
            downloadAndMaybeDecrypt: async (opts) => {
              if (!opts.mimetype || opts.mimetype === 'application/octet-stream') {
                throw new Error('Unexpected mimetype application/octet-stream for media type ptt');
              }
              assert.strictEqual(opts.mimetype, audio.mimetype);
              return audio.data;
            },
          },
        };
      }
      throw new Error(`modulo inesperado: ${name}`);
    },
    WWebJS: {
      arrayBufferToBase64Async: async (buf) => Buffer.from(buf).toString('base64'),
    },
  };

  const previousWindow = global.window;
  const previousFetch = global.fetch;
  global.window = fakeWindow;
  global.fetch = async () => { throw new Error('fetch nao deveria ser usado'); };
  try {
    const mgr = new WhatsAppManager(null);
    mgr.logToApp = () => {};
    mgr.clients.set('zap1', {
      client: { pupPage: { evaluate: async (fn, arg) => fn(arg) } },
      messages: new Map(),
    });
    const msg = {
      id: { id: mediaId, remote: chatId, fromMe: false, _serialized: serialized },
      fromMe: false,
      from: chatId,
      to: chatId,
      type: 'ptt',
      _data: { mimetype: audio.mimetype },
      downloadMedia: async () => { throw new Error('fallback nao deveria ser usado'); },
    };

    const out = await mgr._downloadAudio('zap1', msg, audio.mimetype);
    assert.ok(out, 'download retornou vazio');
    assert.strictEqual(out.data, audio.data.toString('base64'));
    assert.strictEqual(out.mimetype, audio.mimetype);
    assert.strictEqual(out.size, audio.data.length);
    passed++;
    console.log('ok - regressao: ptt baixa passando o mimetype real');
  } finally {
    global.window = previousWindow;
    global.fetch = previousFetch;
  }
}

async function testFallbackManual() {
  const mediaId = '3EB0FALLBACK456';
  const chatId = '5532999999999@s.whatsapp.net';
  const serialized = `false_${chatId}_${mediaId}`;
  const mediaKey = crypto.randomBytes(32);
  const plain = Buffer.from('audio-baixado-da-cdn');
  const encrypted = encryptMedia(plain, mediaKey, 'ptt');
  const internal = {
    id: { id: mediaId, remote: chatId, fromMe: false, _serialized: serialized },
    type: 'ptt',
    mimetype: 'audio/ogg; codecs=opus',
    mediaData: { mediaStage: 'FETCHING' },
    directPath: '/v/t62.7118-24/audio',
    deprecatedMms3Url: 'https://mmg.whatsapp.net/v/t62.7118-24/audio',
    encFilehash: 'enc',
    filehash: 'hash',
    mediaKey: new Uint8Array(mediaKey),
    mediaKeyTimestamp: 1,
    size: plain.length,
  };
  const fakeWindow = {
    require(name) {
      if (name === 'WAWebCollections') {
        return {
          Msg: {
            get: () => internal,
            getMessagesById: async () => ({ messages: [internal] }),
          },
          Chat: { get: () => null },
        };
      }
      if (name === 'WAWebWidFactory') return { createWid: (v) => v };
      if (name === 'WAWebDownloadManager') {
        return {
          downloadManager: {
            downloadAndMaybeDecrypt: async () => {
              throw new Error('Unexpected mimetype application/octet-stream for media type ptt');
            },
          },
        };
      }
      throw new Error(`modulo inesperado: ${name}`);
    },
    WWebJS: {
      arrayBufferToBase64Async: async (buf) => Buffer.from(buf).toString('base64'),
    },
  };

  const previousWindow = global.window;
  const previousFetch = global.fetch;
  global.window = fakeWindow;
  global.fetch = async () => ({ ok: true, arrayBuffer: async () => encrypted });
  try {
    const mgr = new WhatsAppManager(null);
    mgr.logToApp = () => {};
    mgr.clients.set('zap1', {
      client: { pupPage: { evaluate: async (fn, arg) => fn(arg) } },
      messages: new Map(),
    });
    const msg = {
      id: { id: mediaId, remote: chatId, fromMe: false, _serialized: serialized },
      fromMe: false,
      from: chatId,
      to: chatId,
      type: 'ptt',
      _data: { mimetype: 'audio/ogg; codecs=opus' },
      downloadMedia: async () => { throw new Error('fallback wwebjs nao deveria ser usado'); },
    };

    const out = await mgr._downloadAudio('zap1', msg, 'audio/ogg; codecs=opus');
    assert.ok(out, 'download manual retornou vazio');
    assert.strictEqual(out.data, plain.toString('base64'));
    assert.strictEqual(out.size, plain.length);
    passed++;
    console.log('ok - fallback: CDN criptografada + descriptografia manual');
  } finally {
    global.window = previousWindow;
    global.fetch = previousFetch;
  }
}

// ---------------------------------------------------------------
// Historico da conversa nao guarda base64 de audio
// ---------------------------------------------------------------

test('historico: remove o base64 do audio e preserva mimetype/size', () => {
  const msg = { body: '[AUDIO]', audio: { data: 'QUJD', mimetype: 'audio/ogg; codecs=opus', size: 3 } };
  const out = sanitizeMessage(msg);
  assert.strictEqual(out.audio.data, undefined, 'base64 nao pode ir para o historico');
  assert.strictEqual(out.audio.mimetype, 'audio/ogg; codecs=opus');
  assert.strictEqual(out.audio.size, 3);
  assert.strictEqual(out.body, '[AUDIO]');
  assert.strictEqual(msg.audio.data, 'QUJD', 'o objeto em voo (IA) precisa manter o audio');
});

test('historico: devolve o mesmo objeto quando ja esta limpo', () => {
  const texto = { body: 'oi' };
  assert.strictEqual(sanitizeMessage(texto), texto);
  const limpo = { body: '[AUDIO]', audio: { mimetype: 'audio/ogg', size: 3 } };
  assert.strictEqual(sanitizeMessage(limpo), limpo, 'getMessages nao pode copiar 200 mensagens por chamada');
});

test('historico: sanitizeMessages tolera entrada invalida', () => {
  assert.deepStrictEqual(sanitizeMessages(null), []);
  assert.deepStrictEqual(sanitizeMessages('x'), []);
  assert.strictEqual(sanitizeMessages([{ body: 'a' }, null]).length, 2);
});

async function testGeminiUsaBase64SemBuffer() {
  const responder = new AIResponder();
  const b64 = Buffer.from('audio-gemini').toString('base64');
  let seen = null;
  const previousFetch = global.fetch;
  global.fetch = async (url, opts) => {
    seen = { url, opts, body: JSON.parse(opts.body) };
    return {
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'texto transcrito' }] } }] })
    };
  };
  try {
    const text = await responder.transcribeAudio(
      { data: b64, mimetype: 'audio/ogg; codecs=opus', size: 12 },
      [{ id: 'g', name: 'Google Gemini', apiKey: 'k', models: [{ id: 'gemini-3.6-flash' }] }],
      'zap1'
    );
    assert.strictEqual(text, 'texto transcrito');
    const part = seen.body.contents[0].parts[0];
    assert.strictEqual(part.inline_data.data, b64, 'Gemini deve receber o base64 puro');
    assert.ok(seen.opts.signal, 'fetch de transcricao precisa de signal de timeout');
  } finally {
    global.fetch = previousFetch;
  }
}

async function testFilaDeTranscricao() {
  const previousEnv = process.env.LINK_TRANSCRIBE_CONCURRENCY;
  process.env.LINK_TRANSCRIBE_CONCURRENCY = '1';
  const responder = new AIResponder();
  let active = 0;
  let peak = 0;
  const previousFetch = global.fetch;
  global.fetch = async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 60));
    active--;
    return { ok: true, json: async () => ({ text: 'ok' }) };
  };
  try {
    const audio = { data: Buffer.from('audio').toString('base64'), mimetype: 'audio/ogg', size: 5 };
    const providers = [{ id: 'o', name: 'OpenAI', apiKey: 'k' }];
    await Promise.all([
      responder.transcribeAudio(audio, providers, 'zap1'),
      responder.transcribeAudio(audio, providers, 'zap2'),
      responder.transcribeAudio(audio, providers, 'zap3')
    ]);
    assert.strictEqual(peak, 1, `a fila nao limitou as transcricoes (pico ${peak})`);
  } finally {
    global.fetch = previousFetch;
    if (previousEnv === undefined) delete process.env.LINK_TRANSCRIBE_CONCURRENCY;
    else process.env.LINK_TRANSCRIBE_CONCURRENCY = previousEnv;
  }
}

async function testTimeoutDeTranscricao() {
  const previousEnv = process.env.LINK_TRANSCRIBE_TIMEOUT_MS;
  process.env.LINK_TRANSCRIBE_TIMEOUT_MS = '80';
  const responder = new AIResponder();
  const previousFetch = global.fetch;
  global.fetch = (url, opts) => new Promise((resolve, reject) => {
    if (opts && opts.signal) {
      opts.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }
  });
  try {
    await assert.rejects(
      () => responder.transcribeAudio(
        { data: Buffer.from('audio').toString('base64'), mimetype: 'audio/ogg', size: 5 },
        [{ id: 'o', name: 'OpenAI', apiKey: 'k' }],
        'zap1'
      ),
      /excedeu/,
      'transcricao travada precisa abortar no timeout'
    );
  } finally {
    global.fetch = previousFetch;
    if (previousEnv === undefined) delete process.env.LINK_TRANSCRIBE_TIMEOUT_MS;
    else process.env.LINK_TRANSCRIBE_TIMEOUT_MS = previousEnv;
  }
}

async function rodar(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    failures.push({ name, error: e.message });
    console.log(`FAIL - ${name}`);
    console.log(`      ${e.message}`);
  }
}

async function runAsyncTests() {
  await rodar('transcricao: Gemini recebe base64 puro e signal de timeout', testGeminiUsaBase64SemBuffer);
  await rodar('transcricao: fila limita as transcricoes simultaneas', testFilaDeTranscricao);
  await rodar('transcricao: timeout aborta provedor travado', testTimeoutDeTranscricao);
  try {
    await testRegressaoMimetypePtt();
  } catch (e) {
    failures.push({ name: 'regressao: ptt baixa passando o mimetype real', error: e.message });
    console.log('FAIL - regressao: ptt baixa passando o mimetype real');
    console.log(`      ${e.message}`);
  }
  try {
    await testFallbackManual();
  } catch (e) {
    failures.push({ name: 'fallback: CDN criptografada + descriptografia manual', error: e.message });
    console.log('FAIL - fallback: CDN criptografada + descriptografia manual');
    console.log(`      ${e.message}`);
  }
  mostrarResumo();
}

runAsyncTests();

function mostrarResumo() {
  console.log(`\n${passed} teste(s) passaram`);
  if (failures.length) {
    console.log(`\n${failures.length} FALHA(S):`);
    for (const f of failures) console.log(`  - ${f.name}\n      ${f.error}`);
    process.exitCode = 1;
  } else {
    console.log('TODOS OS TESTES PASSARAM');
  }
}
