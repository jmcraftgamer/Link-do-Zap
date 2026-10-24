// Testes do download/descriptografia manual de audio do WhatsApp
const assert = require('assert');
const crypto = require('crypto');
const path = require('path');

const { decryptWhatsAppMedia } = require(path.join(__dirname, '..', 'src', 'js', 'media-crypto'));
const WhatsAppManager = require(path.join(__dirname, '..', 'src', 'js', 'whatsapp-manager'));

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

async function runAsyncTests() {
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
