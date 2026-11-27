// Testes do download/descriptografia manual de audio do WhatsApp
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { decryptWhatsAppMedia } = require(path.join(__dirname, '..', 'src', 'js', 'media-crypto'));
const WhatsAppManager = require(path.join(__dirname, '..', 'src', 'js', 'whatsapp-manager'));
const AIResponder = require(path.join(__dirname, '..', 'src', 'js', 'ai-responder'));
const { sanitizeMessage, sanitizeMessages } = require(path.join(__dirname, '..', 'src', 'core', 'audio-history'));
const { classifyAudioError } = require(path.join(__dirname, '..', 'src', 'core', 'audio', 'errors'));
const { validateAudio, sniffAudioMime } = require(path.join(__dirname, '..', 'src', 'core', 'audio', 'validator'));
const { normalizeTranscript, isUsableTranscript } = require(path.join(__dirname, '..', 'src', 'core', 'audio', 'transcript'));
const { AudioTaskStore } = require(path.join(__dirname, '..', 'src', 'core', 'audio', 'task-store'));
const { AudioScheduler } = require(path.join(__dirname, '..', 'src', 'core', 'audio', 'scheduler'));
const { AudioPipeline } = require(path.join(__dirname, '..', 'src', 'core', 'audio', 'pipeline'));

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

// ---------------------------------------------------------------
// Fila persistente de audio: classificacao, validacao, store, pipeline
// ---------------------------------------------------------------

function makeTempStore(name) {
  const dir = require('fs').mkdtempSync(path.join(require('os').tmpdir(), `zap-audio-${name}-`));
  const file = path.join(dir, 'audio-tasks.json');
  let clock = 1700000000000;
  const store = new AudioTaskStore({
    filePath: file,
    now: () => clock,
    logger: { error() {}, info() {}, warn() {} }
  });
  return { file, store, advance: (ms) => { clock += ms; }, now: () => clock };
}

function oggBuffer() {
  return Buffer.concat([Buffer.from('OggS'), Buffer.alloc(220, 1)]);
}

test('audio erro: classifica auth, expirada, transitoria e permanente', () => {
  assert.strictEqual(classifyAudioError(new Error('HTTP 401 unauthorized')).kind, 'auth');
  assert.strictEqual(classifyAudioError(new Error('HTTP 401 unauthorized')).retryable, false);
  const expired = classifyAudioError(new Error('midia expirada, cliente pedindo reupload'));
  assert.strictEqual(expired.kind, 'expired');
  assert.strictEqual(expired.refresh, true);
  assert.strictEqual(classifyAudioError(new Error('HTTP 503')).kind, 'transient');
  assert.strictEqual(classifyAudioError(new Error('socket hang up')).retryable, true);
  assert.strictEqual(classifyAudioError(new Error('mensagem nao encontrada')).kind, 'permanent');
  const bug = classifyAudioError(new ReferenceError('getWhatsapp is not defined'));
  assert.strictEqual(bug.kind, 'permanent');
  assert.strictEqual(bug.retryable, false);
  const timeout = classifyAudioError(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  assert.strictEqual(timeout.kind, 'timeout');
  assert.strictEqual(timeout.retryable, true);
});

test('audio main: nao chama helper getWhatsapp inexistente', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(!/\bgetWhatsapp\s*\(\s*\)/.test(source), 'main.js deve usar whatsappManager diretamente');
});

test('audio validador: aceita ogg real e recusa html/json/curto/grande', () => {
  const ok = validateAudio(oggBuffer(), { mimetype: 'audio/ogg; codecs=opus' });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.mimetype, 'audio/ogg');
  assert.strictEqual(sniffAudioMime(oggBuffer()), 'audio/ogg');
  const html = validateAudio(Buffer.from('<html>' + 'x'.repeat(200) + '</html>'), { mimetype: 'audio/ogg' });
  assert.strictEqual(html.ok, false);
  const json = validateAudio(Buffer.from('{"erro":"sem media"}'.padEnd(200, ' ')), { mimetype: 'audio/ogg' });
  assert.strictEqual(json.ok, false);
  assert.strictEqual(validateAudio(Buffer.alloc(4), { mimetype: 'audio/ogg' }).ok, false);
  const tooBig = validateAudio(oggBuffer(), { mimetype: 'audio/ogg', maxBytes: 100 });
  assert.strictEqual(tooBig.ok, false);
  assert.strictEqual(tooBig.kind, 'limit');
});

test('audio transcricao: limpa prefixos e descarta silencio/musica', () => {
  assert.strictEqual(normalizeTranscript('  Transcricao: ola   mundo '), 'ola mundo');
  assert.strictEqual(isUsableTranscript('[Musica]'), false);
  assert.strictEqual(isUsableTranscript('(silencio)'), false);
  assert.strictEqual(isUsableTranscript('...'), false);
  assert.strictEqual(isUsableTranscript('quero marcar um horario'), true);
});

test('audio store: begin idempotente e persistencia apos reiniciar', () => {
  const { file, store } = makeTempStore('store');
  const first = store.begin({ zapId: 'z1', msgId: 'm1', chatId: 'c1', type: 'ptt' });
  assert.strictEqual(first.duplicate, false);
  const again = store.begin({ zapId: 'z1', msgId: 'm1' });
  assert.strictEqual(again.duplicate, true);
  assert.strictEqual(again.task.key, first.task.key);
  store.transition(first.task.key, 'TRANSCRIBED', { text: 'oi' });
  const reloaded = new AudioTaskStore({ filePath: file });
  const t = reloaded.get(first.task.key);
  assert.ok(t);
  assert.strictEqual(t.state, 'TRANSCRIBED');
  assert.strictEqual(t.text, 'oi');
});

test('audio store: markStale protege tarefa em voo e manda IA para DLQ', () => {
  const { store, advance } = makeTempStore('stale');
  const a = store.begin({ zapId: 'z1', msgId: 'm1' });
  const b = store.begin({ zapId: 'z1', msgId: 'm2' });
  store.transition(a.task.key, 'AI_PROCESSING');
  store.transition(b.task.key, 'DOWNLOADING');
  advance(5 * 60 * 1000);
  const changed = store.markStale(2 * 60 * 1000, new Set([b.task.key]));
  assert.strictEqual(changed.length, 1);
  assert.strictEqual(store.get(a.task.key).state, 'DEAD_LETTER');
  assert.strictEqual(store.get(b.task.key).state, 'DOWNLOADING');
});

async function testSchedulerLimits() {
  const scheduler = new AudioScheduler({ maxConcurrent: 2, maxPerKey: 1, maxPending: 10 });
  let activeAll = 0;
  let peakAll = 0;
  let activeA = 0;
  let peakA = 0;
  const job = (key) => scheduler.run(key, async () => {
    activeAll++;
    peakAll = Math.max(peakAll, activeAll);
    if (key === 'a') { activeA++; peakA = Math.max(peakA, activeA); }
    await new Promise((r) => setTimeout(r, 20));
    if (key === 'a') activeA--;
    activeAll--;
  });
  await Promise.all([job('a'), job('a'), job('b'), job('c')]);
  assert.strictEqual(peakA, 1, 'o mesmo zap nao pode rodar dois audios ao mesmo tempo');
  assert.ok(peakAll <= 2, `limite global estourado (pico ${peakAll})`);

  const tiny = new AudioScheduler({ maxConcurrent: 1, maxPerKey: 1, maxPending: 1 });
  const running = tiny.run('a', () => new Promise((r) => setTimeout(r, 20)));
  await assert.rejects(() => tiny.run('b', async () => {}), /backpressure/);
  await running;
}

async function testPipelineRetry() {
  const { store } = makeTempStore('retry');
  const delays = [];
  const pipeline = new AudioPipeline({
    store,
    sleep: async (ms) => { delays.push(ms); },
    random: () => 0,
    config: { baseDelayMs: 100, maxDelayMs: 400, jitterRatio: 0.25, downloadAttempts: 3, transcribeAttempts: 1 }
  });
  const { task } = pipeline.begin({ zapId: 'z1', msgId: 'm1', chatId: 'c1', type: 'ptt', mimetype: 'audio/ogg' });
  let calls = 0;
  const res = await pipeline.run(task.key, {
    download: async () => {
      calls++;
      if (calls < 3) throw new Error('HTTP 503');
      return { buffer: oggBuffer(), mimetype: 'audio/ogg', method: 'cdn+decrypt' };
    },
    transcribe: async () => 'ola mundo'
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.text, 'ola mundo');
  assert.strictEqual(calls, 3, 'deveria tentar 3 vezes');
  assert.deepStrictEqual(delays, [100, 200], 'backoff exponencial sem jitter');
  assert.strictEqual(store.get(task.key).state, 'TRANSCRIBED');
}

async function testPipelineDeadLetter() {
  const { store } = makeTempStore('dlq');
  const pipeline = new AudioPipeline({ store, sleep: async () => {}, random: () => 0 });
  const { task } = pipeline.begin({ zapId: 'z1', msgId: 'm1' });
  let calls = 0;
  const res = await pipeline.run(task.key, {
    download: async () => { calls++; throw new Error('HTTP 401 unauthorized'); },
    transcribe: async () => 'x'
  });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.deadLetter, true);
  assert.strictEqual(res.kind, 'auth');
  assert.strictEqual(calls, 1, 'falha de credencial nao deve ser repetida');
  assert.strictEqual(store.get(task.key).state, 'DEAD_LETTER');
  const reopened = pipeline.retryDeadLetter(task.key);
  assert.ok(reopened);
  assert.strictEqual(reopened.state, 'QUEUED');
}

async function testPipelineBackpressureRetryLater() {
  const { store } = makeTempStore('bp');
  const scheduler = {
    run: async () => {
      const err = new Error('fila de audio cheia (backpressure)');
      err.code = 'QUEUE_FULL';
      throw err;
    }
  };
  const pipeline = new AudioPipeline({ store, scheduler, sleep: async () => {} });
  const { task } = pipeline.begin({ zapId: 'z1', msgId: 'm1' });
  const res = await pipeline.run(task.key, {
    download: async () => ({ buffer: oggBuffer(), mimetype: 'audio/ogg' }),
    transcribe: async () => 'x'
  });
  assert.strictEqual(res.retryLater, true);
  assert.strictEqual(store.get(task.key).state, 'RETRYING');
}

test('audio pipeline: recuperacao nao retoma audio que ja chegou na IA', () => {
  const { store, now } = makeTempStore('recover');
  const pipeline = new AudioPipeline({ store, now });
  const done = store.begin({ zapId: 'z1', msgId: 'm1' });
  store.transition(done.task.key, 'COMPLETED');
  const pending = store.begin({ zapId: 'z1', msgId: 'm2' });
  store.transition(pending.task.key, 'DOWNLOADING');
  const ai = store.begin({ zapId: 'z1', msgId: 'm3' });
  store.transition(ai.task.key, 'AI_PROCESSING');
  const keys = pipeline.recoverable().map((t) => t.key);
  assert.ok(keys.includes(pending.task.key), 'download interrompido deve ser retomado');
  assert.ok(!keys.includes(done.task.key), 'audio concluido nao pode ser repetido');
  assert.ok(!keys.includes(ai.task.key), 'audio em resposta nao pode gerar segunda resposta');
});

async function testMensagemComAudioUsaMesmaIA() {
  const { createMessagePipeline } = require(path.join(__dirname, '..', 'src', 'core', 'messaging', 'pipeline'));
  const sent = [];
  let seenBody = null;
  let receivedTaskKey = null;
  const manager = {
    clients: new Map(),
    async sendMessage(zapId, chatId, text) { sent.push(text); return { success: true }; },
    async hasOwnerReplied() { return false; }
  };
  const responder = {
    getModelsToTry() { return [{ provider: { id: 'p', name: 'P', apiKey: 'k' }, model: { id: 'm' } }]; },
    async generateResponse(msg) { seenBody = msg.body; return 'Claro, qual o servico?'; },
    isJunkResponse() { return false; }
  };
  const pipeline = createMessagePipeline({
    getWhatsapp: () => manager,
    getAiResponder: () => responder,
    getConversationStore: () => null,
    loadZaps: () => [{ id: 'Z1', enabled: true, autoReply: true, instantReply: true, model: 'm' }],
    loadProviders: () => [],
    loadTrainings: () => ({ Z1: [] }),
    checkBillingActive: () => ({ active: true, reason: 'own_use' }),
    isServerPaused: () => false,
    isServerMode: () => true,
    log: () => {},
    typing: { send: async () => {}, clear: async () => {}, waitRealistic: async () => {} },
    resolveProviderKey: (p) => p,
    runAudioTask: async (md) => {
      receivedTaskKey = md.audioTaskKey;
      return { ok: true, text: 'quero um orcamento', method: 'cdn+decrypt', size: 999 };
    }
  });
  const result = await pipeline.processMessage({
    zapId: 'Z1',
    id: 'false_1',
    body: '[AUDIO]',
    from: '5511@c.us',
    to: '5512@c.us',
    fromMe: false,
    timestamp: Math.floor(Date.now() / 1000),
    audio: null,
    audioFailed: false,
    audioPending: true,
    audioTaskKey: 'Z1:abc',
    contact: { id: '5511@s.whatsapp.net', name: 'Ana', number: '5511' },
    chat: { id: '5511@c.us', name: 'Ana', isGroup: false }
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(receivedTaskKey, 'Z1:abc', 'a tarefa persistente precisa ser usada');
  assert.strictEqual(seenBody, 'quero um orcamento', 'a transcricao precisa chegar na IA como texto');
  assert.strictEqual(sent[0], 'Claro, qual o servico?');
}

async function testFilaDeAudioAdiaSemResponder() {
  const { createMessagePipeline } = require(path.join(__dirname, '..', 'src', 'core', 'messaging', 'pipeline'));
  const sent = [];
  const manager = {
    clients: new Map(),
    async sendMessage(zapId, chatId, text) { sent.push(text); return { success: true }; },
    async hasOwnerReplied() { return false; }
  };
  const responder = {
    getModelsToTry() { return [{ provider: { id: 'p', name: 'P', apiKey: 'k' }, model: { id: 'm' } }]; },
    async generateResponse() { throw new Error('IA nao deveria ser chamada'); },
    isJunkResponse() { return false; }
  };
  const pipeline = createMessagePipeline({
    getWhatsapp: () => manager,
    getAiResponder: () => responder,
    getConversationStore: () => null,
    loadZaps: () => [{ id: 'Z1', enabled: true, autoReply: true, instantReply: true, model: 'm' }],
    loadProviders: () => [],
    loadTrainings: () => ({ Z1: [] }),
    checkBillingActive: () => ({ active: true, reason: 'own_use' }),
    isServerPaused: () => false,
    isServerMode: () => true,
    log: () => {},
    typing: { send: async () => {}, clear: async () => {}, waitRealistic: async () => {} },
    resolveProviderKey: (p) => p,
    runAudioTask: async () => ({ ok: false, retryLater: true, kind: 'transient', error: 'HTTP 503' })
  });
  const result = await pipeline.processMessage({
    zapId: 'Z1', id: 'false_2', body: '[AUDIO]', from: '5511@c.us', to: '5512@c.us',
    fromMe: false, timestamp: Math.floor(Date.now() / 1000), audio: null, audioFailed: false,
    audioPending: true, audioTaskKey: 'Z1:def',
    contact: { id: '5511@s.whatsapp.net', name: 'Ana', number: '5511' },
    chat: { id: '5511@c.us', name: 'Ana', isGroup: false }
  });
  assert.strictEqual(result.reason, 'audio_retry');
  assert.strictEqual(sent.length, 0, 'audio adiado nao pode receber resposta precipitada');
}

async function testFilaDeAudioFalhaDefinitivaPedeTexto() {
  const { createMessagePipeline } = require(path.join(__dirname, '..', 'src', 'core', 'messaging', 'pipeline'));
  const sent = [];
  const manager = {
    clients: new Map(),
    async sendMessage(zapId, chatId, text) { sent.push(text); return { success: true }; },
    async hasOwnerReplied() { return false; }
  };
  const responder = {
    getModelsToTry() { return [{ provider: { id: 'p', name: 'P', apiKey: 'k' }, model: { id: 'm' } }]; },
    async generateResponse() { throw new Error('IA nao deveria ser chamada'); },
    isJunkResponse() { return false; }
  };
  const pipeline = createMessagePipeline({
    getWhatsapp: () => manager,
    getAiResponder: () => responder,
    getConversationStore: () => null,
    loadZaps: () => [{ id: 'Z1', enabled: true, autoReply: true, instantReply: true, model: 'm' }],
    loadProviders: () => [],
    loadTrainings: () => ({ Z1: [] }),
    checkBillingActive: () => ({ active: true, reason: 'own_use' }),
    isServerPaused: () => false,
    isServerMode: () => true,
    log: () => {},
    typing: { send: async () => {}, clear: async () => {}, waitRealistic: async () => {} },
    resolveProviderKey: (p) => p,
    runAudioTask: async () => ({ ok: false, deadLetter: true, kind: 'corrupt', error: 'audio invalido' })
  });
  const result = await pipeline.processMessage({
    zapId: 'Z1', id: 'false_3', body: '[AUDIO]', from: '5511@c.us', to: '5512@c.us',
    fromMe: false, timestamp: Math.floor(Date.now() / 1000), audio: null, audioFailed: false,
    audioPending: true, audioTaskKey: 'Z1:ghi',
    contact: { id: '5511@s.whatsapp.net', name: 'Ana', number: '5511' },
    chat: { id: '5511@c.us', name: 'Ana', isGroup: false }
  });
  assert.strictEqual(result.reason, 'audio_dead_letter');
  assert.strictEqual(sent.length, 1);
  assert.ok(/texto/i.test(sent[0]), 'cliente deve ser convidado a mandar texto');
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
  await rodar('audio scheduler: limite por zap, global e backpressure', testSchedulerLimits);
  await rodar('audio pipeline: retry com backoff ate transcrever', testPipelineRetry);
  await rodar('audio pipeline: credencial invalida vai para DLQ e pode reprocessar', testPipelineDeadLetter);
  await rodar('audio pipeline: fila cheia mantem a tarefa para novo ciclo', testPipelineBackpressureRetryLater);
  await rodar('audio + IA: transcricao entra no mesmo pipeline de texto', testMensagemComAudioUsaMesmaIA);
  await rodar('audio + IA: tarefa adiada nao responde antes da hora', testFilaDeAudioAdiaSemResponder);
  await rodar('audio + IA: falha definitiva pede para enviar texto', testFilaDeAudioFalhaDefinitivaPedeTexto);
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
